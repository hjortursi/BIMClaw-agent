import { readEnvFile } from '../env.js';
import {
  BimGroupConfig,
  BimNotificationPreferences,
  BimOAuthConfig,
  BimToolPermissions,
  RegisteredGroup,
} from '../types.js';

export type BimToolId =
  | 'procore-tools'
  | 'acc-tools'
  | 'deadline-checker'
  | 'weekly-summary';

const envConfig = readEnvFile([
  'BIMCLAW_API_ENABLED',
  'BIMCLAW_API_HOST',
  'BIMCLAW_API_PORT',
  'BIMCLAW_API_TOKEN',
  'BIMCLAW_DEFAULT_TENANT_ID',
  'BIMCLAW_PROCORE_BASE_URL',
  'BIMCLAW_PROCORE_ACCESS_TOKEN',
  'BIMCLAW_PROCORE_REFRESH_TOKEN',
  'BIMCLAW_PROCORE_TOKEN_EXPIRES_AT',
  'BIMCLAW_ACC_BASE_URL',
  'BIMCLAW_ACC_ACCESS_TOKEN',
  'BIMCLAW_ACC_REFRESH_TOKEN',
  'BIMCLAW_ACC_TOKEN_EXPIRES_AT',
]);

function envValue(name: string): string | undefined {
  return process.env[name] || envConfig[name];
}

export const BIMCLAW_API_ENABLED = envValue('BIMCLAW_API_ENABLED') === 'true';
export const BIMCLAW_API_HOST = envValue('BIMCLAW_API_HOST') || '0.0.0.0';
export const BIMCLAW_API_PORT = parseInt(
  envValue('BIMCLAW_API_PORT') || '8787',
  10,
);
export const BIMCLAW_API_TOKEN = envValue('BIMCLAW_API_TOKEN');
export const BIMCLAW_DEFAULT_TENANT_ID =
  envValue('BIMCLAW_DEFAULT_TENANT_ID') || 'default-bim-tenant';

const DEFAULT_TOOL_PERMISSIONS: BimToolPermissions = {
  procoreTools: true,
  accTools: true,
  deadlineChecker: true,
  weeklySummary: true,
};

const DEFAULT_NOTIFICATION_PREFERENCES: BimNotificationPreferences = {
  deadlineAlerts: true,
  weeklySummary: true,
  daysBeforeDeadline: [7, 3, 1],
  deliveryChannel: 'both',
  language: 'is',
};

function mergeProviderConfig(
  tenantId: string,
  provider: 'procore' | 'acc',
  source?: BimOAuthConfig,
): BimOAuthConfig | undefined {
  const prefix = provider.toUpperCase();
  const accessToken =
    source?.accessToken || envValue(`BIMCLAW_${prefix}_ACCESS_TOKEN`);
  if (!accessToken) return undefined;

  const baseUrlEnv = envValue(`BIMCLAW_${prefix}_BASE_URL`);
  const refreshTokenEnv = envValue(`BIMCLAW_${prefix}_REFRESH_TOKEN`);
  const expiresAtEnv = envValue(`BIMCLAW_${prefix}_TOKEN_EXPIRES_AT`);

  return {
    tenantId: source?.tenantId || tenantId,
    accessToken,
    refreshToken: source?.refreshToken || refreshTokenEnv,
    expiresAt: source?.expiresAt || expiresAtEnv,
    baseUrl: source?.baseUrl || baseUrlEnv,
  };
}

export function resolveBimGroupConfig(group: RegisteredGroup): BimGroupConfig {
  const tenantId =
    group.bimConfig?.tenantId || BIMCLAW_DEFAULT_TENANT_ID || group.folder;
  const toolPermissions: BimToolPermissions = {
    ...DEFAULT_TOOL_PERMISSIONS,
    ...(group.bimConfig?.toolPermissions || {}),
  };
  const notificationPreferences: BimNotificationPreferences = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...(group.bimConfig?.notificationPreferences || {}),
  };

  return {
    tenantId,
    procore: mergeProviderConfig(tenantId, 'procore', group.bimConfig?.procore),
    acc: mergeProviderConfig(tenantId, 'acc', group.bimConfig?.acc),
    toolPermissions,
    notificationPreferences,
  };
}

function toolToPermissionKey(tool: BimToolId): keyof BimToolPermissions {
  switch (tool) {
    case 'procore-tools':
      return 'procoreTools';
    case 'acc-tools':
      return 'accTools';
    case 'deadline-checker':
      return 'deadlineChecker';
    case 'weekly-summary':
      return 'weeklySummary';
  }
}

export function isBimToolAllowed(
  group: RegisteredGroup,
  tool: BimToolId,
): boolean {
  const config = resolveBimGroupConfig(group);
  const key = toolToPermissionKey(tool);
  return config.toolPermissions?.[key] !== false;
}

export function summarizeBimConfig(group: RegisteredGroup): {
  tenantId: string;
  hasProcoreToken: boolean;
  hasAccToken: boolean;
  toolPermissions: BimToolPermissions;
  notificationPreferences: BimNotificationPreferences;
} {
  const config = resolveBimGroupConfig(group);
  return {
    tenantId: config.tenantId,
    hasProcoreToken: !!config.procore?.accessToken,
    hasAccToken: !!config.acc?.accessToken,
    toolPermissions:
      (config.toolPermissions as BimToolPermissions) ||
      DEFAULT_TOOL_PERMISSIONS,
    notificationPreferences:
      (config.notificationPreferences as BimNotificationPreferences) ||
      DEFAULT_NOTIFICATION_PREFERENCES,
  };
}
