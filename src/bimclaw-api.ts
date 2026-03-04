import { createServer, IncomingMessage, ServerResponse } from 'http';

import { AvailableGroup, ContainerOutput } from './container-runner.js';
import {
  ChatMessageRecord,
  getAllChats,
  getMessagesForChat,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { IpcDeps, processTaskIpc } from './ipc.js';
import { logger } from './logger.js';
import { formatMessages, formatOutbound } from './router.js';
import { RegisteredGroup } from './types.js';
import {
  BIMCLAW_API_ENABLED,
  BIMCLAW_API_HOST,
  BIMCLAW_API_PORT,
  BIMCLAW_API_TOKEN,
  BimToolId,
  isBimToolAllowed,
  summarizeBimConfig,
} from './bimclaw/config.js';

type DirectIpcTool =
  | 'schedule_task'
  | 'pause_task'
  | 'resume_task'
  | 'cancel_task'
  | 'refresh_groups'
  | 'register_group';

type ApiTool = DirectIpcTool | BimToolId;

interface BimclawApiDeps {
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getAvailableGroups: () => AvailableGroup[];
  getSessions: () => Record<string, string>;
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  ipcDeps: IpcDeps;
}

interface SendMessageRequest {
  chatJid: string;
  text: string;
  senderName?: string;
  waitForResponse?: boolean;
  timeoutMs?: number;
}

interface ExecuteToolRequest {
  chatJid: string;
  tool: ApiTool;
  input?: Record<string, unknown>;
  timeoutMs?: number;
}

interface ApiRunResult {
  status: 'success' | 'error';
  responses: string[];
  error?: string;
}

const API_PREFIX = '/bimclaw-api';
const MAX_BODY_SIZE = 1_000_000;
const DEFAULT_API_TIMEOUT_MS = 90_000;
const MAX_API_TIMEOUT_MS = 300_000;
const BIM_SKILLS: ReadonlySet<BimToolId> = new Set([
  'procore-tools',
  'acc-tools',
  'deadline-checker',
  'weekly-summary',
]);
const DIRECT_IPC_TOOLS: ReadonlySet<DirectIpcTool> = new Set([
  'schedule_task',
  'pause_task',
  'resume_task',
  'cancel_task',
  'refresh_groups',
  'register_group',
]);

let apiServerStarted = false;

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  details?: unknown,
): void {
  writeJson(res, statusCode, {
    status: 'villa',
    message,
    details: details ?? null,
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!BIMCLAW_API_TOKEN) return true;
  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${BIMCLAW_API_TOKEN}`;
}

function parseTimeoutMs(input: unknown): number {
  const value = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_API_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_API_TIMEOUT_MS);
}

function parseLimit(input: string | null): number {
  if (!input) return 100;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error('Body of stort'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function mapMessage(record: ChatMessageRecord): Record<string, unknown> {
  return {
    id: record.id,
    chatJid: record.chat_jid,
    sender: record.sender,
    senderName: record.sender_name,
    content: record.content,
    timestamp: record.timestamp,
    isFromMe: record.is_from_me === 1,
    isBotMessage: record.is_bot_message === 1,
  };
}

function isBimSkillTool(tool: ApiTool): tool is BimToolId {
  return BIM_SKILLS.has(tool as BimToolId);
}

function buildBimToolPrompt(
  tool: BimToolId,
  input: Record<string, unknown> | undefined,
): string {
  const payload = JSON.stringify(input || {}, null, 2);

  switch (tool) {
    case 'procore-tools':
      return `Notad skillid procore-tools.

Framkvaemdu beiðni med inntaki:
\`\`\`json
${payload}
\`\`\`

Skilad i islensku: nidurstada, stödu, naestu skref og dagsetningar.`;
    case 'acc-tools':
      return `Notad skillid acc-tools.

Framkvaemdu beiðni med inntaki:
\`\`\`json
${payload}
\`\`\`

Skilad i islensku med verkefnalista/issues, overdue atridum og adgerdum.`;
    case 'deadline-checker':
      return `Notad skillid deadline-checker.

Framkvaemdu frestaeftirlit med inntaki:
\`\`\`json
${payload}
\`\`\`

Skilaðu frestavidvorunum i islensku og bentu a naestu adgerdir.`;
    case 'weekly-summary':
      return `Notad skillid weekly-summary.

Framkvaemdu vikulega samantekt med inntaki:
\`\`\`json
${payload}
\`\`\`

Skilaðu stuttu, adgerdarmidudu vikuyfirliti i islensku.`;
  }
}

function runInQueue<T>(
  queue: GroupQueue,
  chatJid: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const taskId = `bim-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      reject(new Error(`Api timeout eftir ${timeoutMs} ms`));
    }, timeoutMs);

    queue.enqueueTask(chatJid, taskId, async () => {
      try {
        const result = await fn();
        clearTimeout(timeout);
        resolve(result);
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

async function runAgentForApi(
  deps: BimclawApiDeps,
  group: RegisteredGroup,
  chatJid: string,
  prompt: string,
  timeoutMs: number,
): Promise<ApiRunResult> {
  const responses: string[] = [];

  try {
    const status = await runInQueue(deps.queue, chatJid, timeoutMs, async () => {
      return deps.runAgent(group, prompt, chatJid, async (output) => {
        if (!output.result) return;
        const text = formatOutbound(output.result);
        if (!text) return;

        responses.push(text);
        storeMessageDirect({
          id: `api-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: 'bimclaw-agent',
          sender_name: 'BIMClaw',
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      });
    });

    if (status === 'error') {
      return {
        status: 'error',
        responses,
        error: 'Agent keyrslan skiladi villu.',
      };
    }

    return { status: 'success', responses };
  } catch (err) {
    return {
      status: 'error',
      responses,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BimclawApiDeps,
): Promise<void> {
  const body = (await parseJsonBody(req)) as SendMessageRequest;
  if (!body.chatJid || !body.text) {
    writeError(res, 400, 'Vantar `chatJid` eda `text`.');
    return;
  }

  const groups = deps.registeredGroups();
  const group = groups[body.chatJid];
  if (!group) {
    writeError(res, 404, 'Group fannst ekki fyrir chatJid.');
    return;
  }

  const now = new Date().toISOString();
  const inboundMessage = {
    id: `api-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: body.chatJid,
    sender: 'bimclaw-dashboard',
    sender_name: body.senderName || 'BIMClaw Dashboard',
    content: body.text,
    timestamp: now,
    is_from_me: false,
    is_bot_message: false,
  };

  storeChatMetadata(body.chatJid, now, group.name);
  storeMessageDirect(inboundMessage);

  const prompt = formatMessages([inboundMessage]);
  const waitForResponse = body.waitForResponse !== false;
  const timeoutMs = parseTimeoutMs(body.timeoutMs);

  if (!waitForResponse) {
    void runAgentForApi(deps, group, body.chatJid, prompt, timeoutMs).then(
      (result) => {
        logger.info(
          { chatJid: body.chatJid, status: result.status },
          'Async BIM API message completed',
        );
      },
    );

    writeJson(res, 202, {
      status: 'accepted',
      message: 'Skilabod sett i biðroð fyrir agent.',
      chatJid: body.chatJid,
    });
    return;
  }

  const result = await runAgentForApi(deps, group, body.chatJid, prompt, timeoutMs);
  writeJson(res, result.status === 'success' ? 200 : 500, {
    status: result.status,
    chatJid: body.chatJid,
    responses: result.responses,
    error: result.error || null,
  });
}

async function handleToolExecution(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BimclawApiDeps,
): Promise<void> {
  const body = (await parseJsonBody(req)) as ExecuteToolRequest;
  if (!body.chatJid || !body.tool) {
    writeError(res, 400, 'Vantar `chatJid` eda `tool`.');
    return;
  }

  const groups = deps.registeredGroups();
  const group = groups[body.chatJid];
  if (!group) {
    writeError(res, 404, 'Group fannst ekki fyrir chatJid.');
    return;
  }

  const timeoutMs = parseTimeoutMs(body.timeoutMs);

  if (DIRECT_IPC_TOOLS.has(body.tool as DirectIpcTool)) {
    await processTaskIpc(
      {
        type: body.tool,
        ...(body.input || {}),
      },
      group.folder,
      group.isMain === true,
      deps.ipcDeps,
    );

    writeJson(res, 200, {
      status: 'success',
      tool: body.tool,
      message: 'Tool execution trigger sent i IPC.',
    });
    return;
  }

  if (!isBimSkillTool(body.tool)) {
    writeError(res, 400, 'Othjod tool.');
    return;
  }

  if (!isBimToolAllowed(group, body.tool)) {
    writeError(res, 403, 'Tool er ekki heimil fyrir þetta group.');
    return;
  }

  const bimSummary = summarizeBimConfig(group);
  if (body.tool === 'procore-tools' && !bimSummary.hasProcoreToken) {
    writeError(res, 400, 'Procore token vantar fyrir þetta group/tenant.');
    return;
  }
  if (body.tool === 'acc-tools' && !bimSummary.hasAccToken) {
    writeError(res, 400, 'ACC token vantar fyrir þetta group/tenant.');
    return;
  }

  const prompt = buildBimToolPrompt(body.tool, body.input);
  const inboundMessage = {
    id: `api-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: body.chatJid,
    sender: 'bimclaw-dashboard',
    sender_name: 'BIMClaw Dashboard',
    content: `[TOOL:${body.tool}] ${prompt}`,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  };

  storeChatMetadata(body.chatJid, inboundMessage.timestamp, group.name);
  storeMessageDirect(inboundMessage);

  const result = await runAgentForApi(
    deps,
    group,
    body.chatJid,
    formatMessages([inboundMessage]),
    timeoutMs,
  );

  writeJson(res, result.status === 'success' ? 200 : 500, {
    status: result.status,
    tool: body.tool,
    responses: result.responses,
    error: result.error || null,
  });
}

function buildStatusPayload(deps: BimclawApiDeps): Record<string, unknown> {
  const registeredGroups = deps.registeredGroups();
  const sessions = deps.getSessions();
  const queueStatus = deps.queue.getStatus();

  return {
    status: 'ok',
    service: 'bimclaw-agent',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    queue: queueStatus,
    registeredGroupCount: Object.keys(registeredGroups).length,
    availableConversationCount: getAllChats().length,
    activeSessionCount: Object.keys(sessions).length,
    groups: Object.entries(registeredGroups).map(([jid, group]) => ({
      chatJid: jid,
      name: group.name,
      folder: group.folder,
      isMain: group.isMain === true,
      requiresTrigger: group.requiresTrigger !== false,
      bim: summarizeBimConfig(group),
    })),
  };
}

function listConversations(
  deps: BimclawApiDeps,
): Array<Record<string, unknown>> {
  const groups = deps.registeredGroups();
  const registeredJids = new Set(Object.keys(groups));
  return getAllChats().map((chat) => {
    const group = groups[chat.jid];
    return {
      chatJid: chat.jid,
      name: chat.name,
      channel: chat.channel,
      isGroup: chat.is_group === 1,
      lastMessageTime: chat.last_message_time,
      isRegistered: registeredJids.has(chat.jid),
      groupFolder: group?.folder || null,
      requiresTrigger: group ? group.requiresTrigger !== false : null,
    };
  });
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BimclawApiDeps,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (!pathname.startsWith(API_PREFIX)) {
    writeError(res, 404, 'Endpoint fannst ekki.');
    return;
  }

  if (!isAuthorized(req)) {
    writeError(res, 401, 'Ogilt API token.');
    return;
  }

  if (req.method === 'GET' && pathname === `${API_PREFIX}/status`) {
    writeJson(res, 200, buildStatusPayload(deps));
    return;
  }

  if (req.method === 'GET' && pathname === `${API_PREFIX}/conversations`) {
    writeJson(res, 200, {
      status: 'ok',
      conversations: listConversations(deps),
    });
    return;
  }

  if (
    req.method === 'GET' &&
    pathname.startsWith(`${API_PREFIX}/conversations/`) &&
    pathname.endsWith('/messages')
  ) {
    const encodedJid = pathname
      .replace(`${API_PREFIX}/conversations/`, '')
      .replace('/messages', '');
    const chatJid = decodeURIComponent(encodedJid);
    const limit = parseLimit(url.searchParams.get('limit'));
    const before = url.searchParams.get('before') || undefined;

    writeJson(res, 200, {
      status: 'ok',
      chatJid,
      messages: getMessagesForChat(chatJid, limit, before).map(mapMessage),
    });
    return;
  }

  if (req.method === 'POST' && pathname === `${API_PREFIX}/messages`) {
    await handleSendMessage(req, res, deps);
    return;
  }

  if (req.method === 'POST' && pathname === `${API_PREFIX}/tools/execute`) {
    await handleToolExecution(req, res, deps);
    return;
  }

  writeError(res, 404, 'Endpoint fannst ekki.');
}

export function startBimclawApiBridge(deps: BimclawApiDeps): void {
  if (!BIMCLAW_API_ENABLED) {
    logger.info('BIMClaw API bridge disabled (set BIMCLAW_API_ENABLED=true to enable)');
    return;
  }

  if (apiServerStarted) {
    logger.debug('BIMClaw API bridge already running');
    return;
  }
  apiServerStarted = true;

  const server = createServer((req, res) => {
    routeRequest(req, res, deps).catch((err) => {
      logger.error({ err }, 'BIMClaw API request failed');
      writeError(res, 500, 'Innri villa i BIMClaw API.', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  server.listen(BIMCLAW_API_PORT, BIMCLAW_API_HOST, () => {
    logger.info(
      {
        host: BIMCLAW_API_HOST,
        port: BIMCLAW_API_PORT,
        basePath: API_PREFIX,
      },
      'BIMClaw API bridge started',
    );
  });
}
