#!/usr/bin/env node
/**
 * Main entry point for mscode.
 *
 * - No args: interactive TUI
 * - --prompt "...": headless non-interactive mode
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isStreamDestroyedError } from './error-classification.js';
import { loadSettings } from './onboarding/settings.js';
import { detectTerminalTheme } from './tui/detect-theme.js';
import { MastraTUI } from './tui/index.js';
import { applyThemeMode } from './tui/theme.js';
import { getAppDataDir } from './utils/project.js';
import { releaseAllThreadLocks } from './utils/thread-lock.js';
import { createMastraCode } from './index.js';

let harness: Awaited<ReturnType<typeof createMastraCode>>['harness'];
let mcpManager: Awaited<ReturnType<typeof createMastraCode>>['mcpManager'];
let hookManager: Awaited<ReturnType<typeof createMastraCode>>['hookManager'];
let authStorage: Awaited<ReturnType<typeof createMastraCode>>['authStorage'];

// ── Headless arg parsing ──────────────────────────────────────────────────────

function hasHeadlessFlag(argv: string[]): boolean {
  return argv.some(a => a === '--prompt' || a === '-p');
}

function parseHeadlessArgs(argv: string[]): { prompt?: string; timeout?: number; format: 'default' | 'json'; continue_: boolean } {
  let prompt: string | undefined;
  let timeout: number | undefined;
  let format: 'default' | 'json' = 'default';
  let continue_ = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--prompt' || arg === '-p') && argv[i + 1]) {
      prompt = argv[++i];
    } else if (arg === '--continue' || arg === '-c') {
      continue_ = true;
    } else if (arg === '--timeout' && argv[i + 1]) {
      timeout = parseInt(argv[++i]!, 10);
      if (isNaN(timeout)) {
        process.stderr.write('Error: --timeout must be a number\n');
        process.exit(1);
      }
    } else if (arg === '--format' && argv[i + 1]) {
      const val = argv[++i]!;
      if (val !== 'default' && val !== 'json') {
        process.stderr.write('Error: --format must be "default" or "json"\n');
        process.exit(1);
      }
      format = val;
    } else if (arg === '--help' || arg === '-h') {
      printHeadlessUsage();
      process.exit(0);
    } else if (!arg!.startsWith('-') && !prompt) {
      prompt = arg;
    }
  }

  return { prompt, timeout, format, continue_ };
}

function printHeadlessUsage(): void {
  process.stdout.write(`
Usage: mscode --prompt <text> [options]

Headless (non-interactive) mode options:
  --prompt, -p <text>   The task to execute (required, or pipe via stdin)
  --continue, -c        Resume the most recent thread instead of creating a new one
  --timeout <seconds>   Exit with code 2 if not complete within timeout
  --format <type>       Output format: "default" or "json" (default: "default")

Examples:
  mscode --prompt "Fix the bug in auth.ts"
  mscode --prompt "Add tests" --timeout 300
  mscode -c --prompt "Continue where you left off"
  mscode --prompt "Refactor utils" --format json
  echo "task description" | mscode --prompt -

Run without --prompt for the interactive TUI.
`);
}

// ── Global error handlers ─────────────────────────────────────────────────────

process.on('uncaughtException', error => {
  if (isStreamDestroyedError(error)) return;
  handleFatalError(error);
});
process.on('unhandledRejection', reason => {
  if (isStreamDestroyedError(reason)) return;
  handleFatalError(reason instanceof Error ? reason : new Error(String(reason)));
});

// ── Headless mode ─────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

async function headlessMain() {
  const args = parseHeadlessArgs(process.argv);

  // Read from stdin if no prompt provided and stdin is piped
  let prompt = args.prompt;
  if (!prompt && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (!prompt) {
    printHeadlessUsage();
    process.stderr.write('Error: --prompt is required (or pipe via stdin)\n');
    process.exit(1);
  }

  const emit = args.format === 'json'
    ? (data: Record<string, unknown>) => process.stdout.write(JSON.stringify(data) + '\n')
    : null;

  const result = await createMastraCode({
    initialState: { yolo: true },
  });
  harness = result.harness;
  mcpManager = result.mcpManager;

  if (mcpManager?.hasServers()) {
    await mcpManager.init();
  }

  // Redirect console.error/warn to log file
  setupLogRedirect();

  await harness.init();

  // ── Timeout ──────────────────────────────────────────────────────────────
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (args.timeout) {
    timeoutId = setTimeout(() => {
      if (args.format === 'json') {
        emit!({ type: 'timeout', seconds: args.timeout });
      } else {
        process.stderr.write(`\nTimeout: ${args.timeout}s elapsed. Aborting.\n`);
      }
      harness.abort();
      void asyncCleanup().then(() => process.exit(2));
    }, args.timeout * 1000);
  }

  // ── Track last emitted text for delta computation ────────────────────────
  let lastTextLength = 0;

  // ── Subscribe to events ──────────────────────────────────────────────────
  const done = new Promise<number>(resolve => {
    harness.subscribe(event => {
      // Handle untyped sandbox_access_request event
      const ev = event as any;
      if (ev.type === 'sandbox_access_request') {
        harness!.respondToQuestion({ questionId: ev.questionId, answer: 'Yes' });
        if (args.format === 'json') {
          emit!({ type: 'sandbox_access_request', path: ev.path, reason: ev.reason, autoApproved: true });
        } else {
          process.stderr.write(`[auto-approved sandbox] ${ev.path}\n`);
        }
        return;
      }

      if (args.format === 'json') {
        emit!({ type: event.type, ...event });
        if (event.type === 'agent_end') {
          resolve(event.reason === 'error' || event.reason === 'aborted' ? 1 : 0);
        }
        return;
      }

      // Default format — human-readable output
      switch (event.type) {
        case 'agent_start':
          lastTextLength = 0;
          break;

        case 'message_update': {
          const textParts = event.message.content.filter(
            (c): c is { type: 'text'; text: string } => c.type === 'text',
          );
          const fullText = textParts.map(p => p.text).join('');
          if (fullText.length > lastTextLength) {
            process.stdout.write(fullText.slice(lastTextLength));
            lastTextLength = fullText.length;
          }
          break;
        }

        case 'message_end':
          lastTextLength = 0;
          process.stdout.write('\n');
          break;

        case 'tool_start':
          process.stderr.write(`[tool] ${event.toolName}\n`);
          break;

        case 'tool_end':
          if (event.isError) {
            process.stderr.write(`[tool error] ${truncate(String(event.result), 200)}\n`);
          }
          break;

        case 'shell_output':
          process.stderr.write(event.output);
          break;

        case 'subagent_start':
          process.stderr.write(`[subagent:${event.agentType}] ${truncate(event.task, 100)}\n`);
          break;

        case 'subagent_end':
          if (event.isError) {
            process.stderr.write(`[subagent error] ${truncate(event.result, 200)}\n`);
          }
          break;

        case 'tool_approval_required':
          harness.respondToToolApproval({ decision: 'approve' });
          process.stderr.write(`[auto-approved] ${event.toolName}\n`);
          break;

        case 'ask_question':
          harness.respondToQuestion({
            questionId: event.questionId,
            answer: 'Proceed with your best judgment. Do not ask further questions.',
          });
          process.stderr.write(`[auto-answered] ${truncate(event.question, 100)}\n`);
          break;

        case 'plan_approval_required':
          void harness.respondToPlanApproval({
            planId: event.planId,
            response: { action: 'approved' },
          });
          process.stderr.write(`[auto-approved plan] ${event.title}\n`);
          break;

        case 'error':
          process.stderr.write(`[error] ${event.error.message}\n`);
          break;

        case 'agent_end':
          resolve(event.reason === 'error' || event.reason === 'aborted' ? 1 : 0);
          break;
      }
    });
  });

  // ── Resume or create thread ──────────────────────────────────────────────
  if (args.continue_) {
    const threads = await harness.listThreads();
    if (threads.length > 0) {
      const sorted = [...threads].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      await harness.switchThread({ threadId: sorted[0]!.id });
      if (args.format !== 'json') {
        process.stderr.write(`[continued] thread ${sorted[0]!.id}\n`);
      }
    }
  }

  // ── Send the prompt ──────────────────────────────────────────────────────
  await harness.sendMessage({ content: prompt });

  // ── Wait for completion ──────────────────────────────────────────────────
  const exitCode = await done;
  if (timeoutId) clearTimeout(timeoutId);
  await asyncCleanup();
  process.exit(exitCode);
}

// ── Interactive TUI mode ──────────────────────────────────────────────────────

async function tuiMain() {
  const result = await createMastraCode();
  harness = result.harness;
  mcpManager = result.mcpManager;
  hookManager = result.hookManager;
  authStorage = result.authStorage;

  if (result.storageWarning) {
    console.info(`⚠ ${result.storageWarning}`);
  }

  if (mcpManager?.hasServers()) {
    await mcpManager.init();
    const statuses = mcpManager.getServerStatuses();
    const connected = statuses.filter(s => s.connected);
    const failed = statuses.filter(s => !s.connected);
    const totalTools = connected.reduce((sum, s) => sum + s.toolCount, 0);
    console.info(`MCP: ${connected.length} server(s) connected, ${totalTools} tool(s)`);
    for (const s of failed) {
      console.info(`MCP: Failed to connect to "${s.name}": ${s.error}`);
    }
  }

  setupLogRedirect();

  // Detect and apply terminal theme
  const envTheme = process.env.MASTRA_THEME?.toLowerCase();
  let themeMode: 'dark' | 'light';
  if (envTheme === 'dark' || envTheme === 'light') {
    themeMode = envTheme;
  } else {
    const settings = loadSettings();
    const themePref = settings.preferences.theme;
    themeMode = themePref === 'dark' || themePref === 'light' ? themePref : await detectTerminalTheme();
  }
  applyThemeMode(themeMode);

  const tui = new MastraTUI({
    harness,
    hookManager,
    authStorage,
    mcpManager,
    appName: 'Mastra Code',
    version: '0.1.0',
    inlineQuestions: true,
  });

  tui.run().catch(error => {
    handleFatalError(error);
  });
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function setupLogRedirect(): void {
  const logFile = path.join(getAppDataDir(), 'debug.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const fmt = (a: unknown): string => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  console.error = (...args: unknown[]) => {
    logStream.write(`[ERROR] ${new Date().toISOString()} ${args.map(fmt).join(' ')}\n`);
  };
  console.warn = (...args: unknown[]) => {
    logStream.write(`[WARN] ${new Date().toISOString()} ${args.map(fmt).join(' ')}\n`);
  };
}

const asyncCleanup = async () => {
  releaseAllThreadLocks();
  await Promise.allSettled([mcpManager?.disconnect(), harness?.stopHeartbeats()]);
};

process.on('beforeExit', () => {
  void asyncCleanup();
});
process.on('exit', () => {
  releaseAllThreadLocks();
});
process.on('SIGINT', () => {
  void asyncCleanup().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void asyncCleanup().finally(() => process.exit(0));
});

function hasEconnrefused(err: unknown, depth = 0): boolean {
  if (!err || depth > 5) return false;
  const e = err as any;
  if (e.code === 'ECONNREFUSED') return true;
  if (e.cause) return hasEconnrefused(e.cause, depth + 1);
  if (Array.isArray(e.errors)) return e.errors.some((inner: unknown) => hasEconnrefused(inner, depth + 1));
  return false;
}

function handleFatalError(error: unknown): never {
  const write = (msg: string) => process.stderr.write(msg + '\n');

  if (hasEconnrefused(error)) {
    const settings = loadSettings();
    const connStr = settings.storage?.pg?.connectionString;
    const target = connStr ?? 'localhost:5432';
    write(
      `\nFailed to connect to PostgreSQL at ${target}.` +
        `\nMake sure the database is running and accessible.` +
        `\n\nTo switch back to LibSQL:` +
        `\n  Set MASTRA_STORAGE_BACKEND=libsql or change the backend in /settings\n`,
    );
    process.exit(1);
  }

  write(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const main = hasHeadlessFlag(process.argv) ? headlessMain : tuiMain;

main().catch(error => {
  handleFatalError(error);
});
