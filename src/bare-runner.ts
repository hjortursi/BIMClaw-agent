/**
 * Bare runner for environments where Docker-in-Docker is unavailable.
 * Runs Claude Code as a direct child process and keeps the same host-side
 * contract as container-runner (streaming outputs + IPC input loop).
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import type { RegisteredGroup } from './types.js';

const IPC_POLL_MS = 500;

interface BareWorkspace {
  groupDir: string;
  groupIpcDir: string;
  inputDir: string;
  homeDir: string;
  claudeDir: string;
  additionalDirs: string[];
  groupClaudeMd?: string;
}

interface QueryResult {
  status: 'success' | 'error';
  newSessionId?: string;
  error?: string;
  stderrTail?: string;
}

interface StreamJsonEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: unknown;
  is_error?: boolean;
}

function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
}

function ensureGroupClaudeSettings(claudeDir: string): void {
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }
}

function syncSkills(claudeDir: string): void {
  const skillsDst = path.join(claudeDir, 'skills');
  const skillSources = [
    path.join(process.cwd(), 'container', 'skills'),
    path.join(process.cwd(), '.claude', 'skills', 'bim'),
  ];

  for (const sourceDir of skillSources) {
    if (!fs.existsSync(sourceDir)) continue;
    for (const skillDir of fs.readdirSync(sourceDir)) {
      const srcDir = path.join(sourceDir, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
}

function buildAdditionalDirectories(
  group: RegisteredGroup,
  isMain: boolean,
): string[] {
  const dirs = new Set<string>();

  if (isMain) {
    dirs.add(process.cwd());
  } else {
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) dirs.add(globalDir);
  }

  if (group.containerConfig?.additionalMounts) {
    const validated = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validated) {
      try {
        if (fs.statSync(mount.hostPath).isDirectory()) {
          dirs.add(mount.hostPath);
        }
      } catch {
        // Ignore disappearing mount paths.
      }
    }
  }

  return [...dirs];
}

function prepareWorkspace(
  group: RegisteredGroup,
  isMain: boolean,
): BareWorkspace {
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const inputDir = path.join(groupIpcDir, 'input');
  const sessionRoot = path.join(DATA_DIR, 'sessions', group.folder);
  const claudeDir = path.join(sessionRoot, '.claude');

  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(sessionRoot, { recursive: true });

  ensureGroupClaudeSettings(claudeDir);
  syncSkills(claudeDir);

  const groupClaudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const groupClaudeMd = fs.existsSync(groupClaudeMdPath)
    ? fs.readFileSync(groupClaudeMdPath, 'utf-8')
    : undefined;

  return {
    groupDir,
    groupIpcDir,
    inputDir,
    homeDir: sessionRoot,
    claudeDir,
    additionalDirs: buildAdditionalDirectories(group, isMain),
    groupClaudeMd,
  };
}

function closeSentinelPath(inputDir: string): string {
  return path.join(inputDir, '_close');
}

function consumeCloseSentinel(inputDir: string): boolean {
  const sentinel = closeSentinelPath(inputDir);
  if (!fs.existsSync(sentinel)) return false;
  try {
    fs.unlinkSync(sentinel);
  } catch {
    // ignore
  }
  return true;
}

function drainIpcInput(inputDir: string): string[] {
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const files = fs
      .readdirSync(inputDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(inputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        logger.warn(
          { filePath, err },
          'Failed to process bare-runner IPC input file',
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
    return messages;
  } catch (err) {
    logger.warn({ err }, 'Failed to drain bare-runner IPC input');
    return [];
  }
}

function waitForIpcMessage(
  inputDir: string,
  shouldAbort: () => boolean,
): Promise<string | null | 'timeout'> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldAbort()) {
        resolve('timeout');
        return;
      }
      if (consumeCloseSentinel(inputDir)) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput(inputDir);
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function sanitizeLogText(text: string): string {
  return text.slice(-4000);
}

function buildClaudeArgs(
  input: ContainerInput,
  prompt: string,
  sessionId: string | undefined,
  workspace: BareWorkspace,
): string[] {
  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--permission-mode',
    'bypassPermissions',
    '--setting-sources',
    'project,user',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  if (workspace.groupClaudeMd && workspace.groupClaudeMd.trim()) {
    args.push('--append-system-prompt', workspace.groupClaudeMd);
  }

  for (const dir of workspace.additionalDirs) {
    args.push('--add-dir', dir);
  }

  const mcpServerTsPath = path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'src',
    'ipc-mcp-stdio.ts',
  );
  const tsxBinCandidates = [
    path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    path.join(process.cwd(), 'node_modules', '.bin', 'tsx.cmd'),
  ];
  const tsxBin = tsxBinCandidates.find((p) => fs.existsSync(p));
  if (tsxBin && fs.existsSync(mcpServerTsPath)) {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        nanoclaw: {
          command: tsxBin,
          args: [mcpServerTsPath],
          env: {
            NANOCLAW_CHAT_JID: input.chatJid,
            NANOCLAW_GROUP_FOLDER: input.groupFolder,
            NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
          },
        },
      },
    });
    args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
  } else {
    logger.warn(
      { mcpServerTsPath },
      'MCP server script unavailable for bare mode; IPC tools disabled',
    );
  }

  args.push('--', prompt);
  return args;
}

async function runClaudeQuery(
  group: RegisteredGroup,
  input: ContainerInput,
  prompt: string,
  sessionId: string | undefined,
  workspace: BareWorkspace,
  onProcess: (proc: ChildProcess, runName: string) => void,
  runName: string,
  envSecrets: Record<string, string>,
  onOutput: (output: ContainerOutput) => Promise<void>,
): Promise<QueryResult> {
  const claudeBin = process.env.BIMCLAW_CLAUDE_BIN || 'claude';
  const args = buildClaudeArgs(input, prompt, sessionId, workspace);

  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: workspace.homeDir,
      TZ: TIMEZONE,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    };

    // Prefer process env for cloud deployment, fallback to .env secrets.
    const apiKey =
      process.env.ANTHROPIC_API_KEY || envSecrets.ANTHROPIC_API_KEY;
    if (apiKey) {
      childEnv.ANTHROPIC_API_KEY = apiKey;
    }
    const baseUrl =
      process.env.ANTHROPIC_BASE_URL || envSecrets.ANTHROPIC_BASE_URL;
    if (baseUrl) {
      childEnv.ANTHROPIC_BASE_URL = baseUrl;
    }
    const authToken =
      process.env.ANTHROPIC_AUTH_TOKEN || envSecrets.ANTHROPIC_AUTH_TOKEN;
    if (authToken) {
      childEnv.ANTHROPIC_AUTH_TOKEN = authToken;
    }
    const oauthToken =
      process.env.CLAUDE_CODE_OAUTH_TOKEN || envSecrets.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }

    const proc = spawn(claudeBin, args, {
      cwd: workspace.groupDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onProcess(proc, runName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let newSessionId = sessionId;
    let sawErrorResult = false;
    let outputChain = Promise.resolve();
    let parseBuffer = '';
    let stderrTail = '';

    const parseLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let event: StreamJsonEvent;
      try {
        event = JSON.parse(trimmed) as StreamJsonEvent;
      } catch {
        return;
      }

      if (
        event.type === 'system' &&
        event.subtype === 'init' &&
        typeof event.session_id === 'string'
      ) {
        newSessionId = event.session_id;
      }

      if (event.type === 'result') {
        const resultText =
          typeof event.result === 'string' ? event.result : null;
        const resultIsError = event.is_error === true;
        if (resultIsError) sawErrorResult = true;
        if (typeof event.session_id === 'string') {
          newSessionId = event.session_id;
        }

        const output: ContainerOutput = {
          status: resultIsError ? 'error' : 'success',
          result: resultText,
          newSessionId,
          ...(resultIsError
            ? {
                error:
                  resultText ||
                  'Claude CLI returned an error result in stream output',
              }
            : {}),
        };

        outputChain = outputChain.then(() => onOutput(output));
      }
    };

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      parseBuffer += chunk;
      while (true) {
        const newlineIdx = parseBuffer.indexOf('\n');
        if (newlineIdx === -1) break;
        const line = parseBuffer.slice(0, newlineIdx);
        parseBuffer = parseBuffer.slice(newlineIdx + 1);
        parseLine(line);
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrTail = sanitizeLogText(`${stderrTail}${chunk}`);
      if (!stderrTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderr += chunk;
        }
      }
    });

    proc.on('close', (code) => {
      if (parseBuffer.trim()) parseLine(parseBuffer);

      outputChain
        .then(() => {
          const isErrorExit = code !== 0 || sawErrorResult;
          if (isErrorExit) {
            logger.error(
              {
                group: group.name,
                code,
                stderrTail,
                stdoutTruncated,
                stderrTruncated,
              },
              'Bare Claude query exited with error',
            );
            resolve({
              status: 'error',
              newSessionId,
              error:
                stderrTail.trim() ||
                `Claude CLI exited with code ${code ?? 'unknown'}`,
              stderrTail,
            });
            return;
          }

          resolve({
            status: 'success',
            newSessionId,
            stderrTail,
          });
        })
        .catch((err) => {
          resolve({
            status: 'error',
            newSessionId,
            error: err instanceof Error ? err.message : String(err),
            stderrTail,
          });
        });
    });

    proc.on('error', (err) => {
      resolve({
        status: 'error',
        newSessionId,
        error: `Failed to spawn Claude CLI (${claudeBin}): ${err.message}`,
      });
    });
  });
}

export async function runBareAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, runName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const isMain = input.isMain;
  const workspace = prepareWorkspace(group, isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const runName = `nanoclaw-bare-${safeName}-${Date.now()}`;
  const logsDir = path.join(workspace.groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const envSecrets = { ...readSecrets(), ...(input.secrets || {}) };
  input.secrets = envSecrets;

  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
  let timedOut = false;
  let hadStreamingOutput = false;
  let activeProc: ChildProcess | null = null;
  let sessionId = input.sessionId;

  const killOnTimeout = () => {
    timedOut = true;
    logger.error({ group: group.name, runName }, 'Bare runner timed out');
    if (activeProc && !activeProc.killed) {
      activeProc.kill('SIGTERM');
      setTimeout(() => {
        if (activeProc && !activeProc.killed) {
          activeProc.kill('SIGKILL');
        }
      }, 5000);
    }
  };

  let timeout = setTimeout(killOnTimeout, timeoutMs);
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(killOnTimeout, timeoutMs);
  };

  const emitOutput = async (output: ContainerOutput): Promise<void> => {
    hadStreamingOutput = true;
    resetTimeout();
    if (output.newSessionId) {
      sessionId = output.newSessionId;
    }
    if (onOutput) {
      await onOutput(output);
    }
  };

  try {
    // Clean up stale close sentinel from previous runs.
    try {
      fs.unlinkSync(closeSentinelPath(workspace.inputDir));
    } catch {
      // ignore
    }

    let prompt = input.prompt;
    if (input.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }

    const pending = drainIpcInput(workspace.inputDir);
    if (pending.length > 0) {
      prompt += `\n${pending.join('\n')}`;
    }

    while (true) {
      if (timedOut) break;

      const query = await runClaudeQuery(
        group,
        input,
        prompt,
        sessionId,
        workspace,
        (proc, name) => {
          activeProc = proc;
          onProcess(proc, name);
        },
        runName,
        envSecrets,
        emitOutput,
      );

      activeProc = null;
      if (query.newSessionId) {
        sessionId = query.newSessionId;
      }

      if (query.status === 'error') {
        if (timedOut) break;
        return {
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: query.error || 'Bare runner query failed',
        };
      }

      if (timedOut) break;

      // Mirror the container runner: emit a null result marker between turns
      // so host-side session tracking and idle signaling stay consistent.
      await emitOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
      });

      const nextMessage = await waitForIpcMessage(
        workspace.inputDir,
        () => timedOut,
      );
      if (nextMessage === 'timeout') break;
      if (nextMessage === null) break;
      prompt = nextMessage;
    }
  } finally {
    clearTimeout(timeout);
    delete input.secrets;
  }

  const duration = Date.now() - startTime;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `bare-runner-${ts}.log`);
  fs.writeFileSync(
    logFile,
    [
      `=== Bare Runner Log ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${group.name}`,
      `Run Name: ${runName}`,
      `Duration: ${duration}ms`,
      `Timed Out: ${timedOut}`,
      `Had Streaming Output: ${hadStreamingOutput}`,
      `Session ID: ${sessionId || 'new'}`,
      `Workspace: ${workspace.groupDir}`,
      `IPC: ${workspace.groupIpcDir}`,
      `CLAUDE_HOME: ${workspace.homeDir}`,
      `Additional Dirs: ${workspace.additionalDirs.join(', ') || '(none)'}`,
    ].join('\n'),
  );

  if (timedOut) {
    if (hadStreamingOutput) {
      return {
        status: 'success',
        result: null,
        newSessionId: sessionId,
      };
    }
    return {
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: `Bare runner timed out after ${configTimeout}ms`,
    };
  }

  return {
    status: 'success',
    result: null,
    newSessionId: sessionId,
  };
}
