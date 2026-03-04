/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { ChildProcess, execSync } from 'child_process';

import type { ContainerInput, ContainerOutput } from './container-runner.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';
export type AgentRuntimeMode = 'container' | 'bare';
let runtimeModeCache: AgentRuntimeMode | null = null;

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isBareModeRequested(): boolean {
  if (parseBoolean(process.env.BIMCLAW_BARE_MODE)) return true;
  const envFile = readEnvFile(['BIMCLAW_BARE_MODE']);
  return parseBoolean(envFile.BIMCLAW_BARE_MODE);
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Detect the active runtime mode for agent execution. */
export function getAgentRuntimeMode(): AgentRuntimeMode {
  if (runtimeModeCache) return runtimeModeCache;

  if (isBareModeRequested()) {
    runtimeModeCache = 'bare';
    logger.info('BIMCLAW_BARE_MODE enabled, using bare runner');
    return runtimeModeCache;
  }

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    runtimeModeCache = 'container';
  } catch (err) {
    runtimeModeCache = 'bare';
    logger.warn(
      { err },
      'Container runtime unavailable, falling back to bare runner',
    );
  }

  return runtimeModeCache;
}

/** True when bare runner mode is active. */
export function isBareModeActive(): boolean {
  return getAgentRuntimeMode() === 'bare';
}

/** @internal - for tests only */
export function _resetRuntimeModeCacheForTests(): void {
  runtimeModeCache = null;
}

/** Run an agent with the currently selected runtime. */
export async function runAgentWithRuntime(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, runtimeProcessName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  if (isBareModeActive()) {
    const { runBareAgent } = await import('./bare-runner.js');
    return runBareAgent(group, input, onProcess, onOutput);
  }

  const { runContainerAgent } = await import('./container-runner.js');
  return runContainerAgent(group, input, onProcess, onOutput);
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Ensure selected runtime prerequisites are met. */
export function ensureAgentRuntimeRunning(): void {
  if (isBareModeActive()) {
    logger.info('Bare mode active: skipping container runtime checks');
    return;
  }
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
