import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, writeFileSync, type Stats } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

/** Explicit opt-in for a temporary, sensitive normalized-prompt capture. */
export interface PromptDebugOptions {
  enabled?: boolean;
  /** Exact identity; no wildcard, prefix, child-session, or global matching. */
  sessionId: string;
  /** Operator-created, owned 0700 directory containing a regular `enabled` file. */
  outputDir: string;
  /** Maximum enabled matching calls attempted by this installation (default 3, maximum 10). */
  maxCalls?: number;
}

const MAX_BYTES = 2 * 1024 * 1024;
const PROCESS_LIMIT = 10;
// A reload or a second installation cannot reset the process-wide allowance.
const BUDGET_KEY = Symbol.for('dsh-parallel-tools-prompt.prompt-debug.budget.v1');
const budgets = globalThis as unknown as Record<symbol, { attempts: number } | undefined>;

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(value)
    ? value : undefined;
}

/** Reject symlinks in every component, not just the final output directory. */
function privateDirectory(path: string): Stats {
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory');
  }
  const stat = lstatSync(path);
  if (process.getuid === undefined || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('non-private directory');
  }
  return stat;
}

function enabled(path: string): boolean {
  const stat = lstatSync(join(path, 'enabled'));
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.();
}

function capture(options: GenerateOptions): string {
  let textBytes = 0;
  const text = (value: unknown): string => {
    if (typeof value !== 'string') throw new Error('unsupported prompt shape');
    textBytes += Buffer.byteLength(value, 'utf8');
    if (textBytes > MAX_BYTES) throw new Error('capture too large');
    return value;
  };
  const messages: Array<{ role: 'system' | 'developer'; text: string[] }> = [];
  for (const message of options.messages) {
    // Developer is not currently in dsh-llm's role union; accept its textual
    // shape defensively, without copying any arbitrary message properties.
    const role: string = message.role;
    if (role !== 'system' && role !== 'developer') continue;
    const blocks: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') blocks.push(text(block.text));
    }
    messages.push({ role, text: blocks });
  }
  const names = (options.tools ?? []).map(tool => safeId(tool.name));
  const record = {
    format: 'normalized-prompt-debug-v1',
    boundary: 'llm/stream normalized GenerateOptions; before provider adapter; NOT final HTTP payload',
    provider: safeId(options.provider),
    model: safeId(options.model),
    purpose: options.purpose === 'compaction' || options.purpose === 'session-title' ? options.purpose : undefined,
    system: options.system === undefined ? undefined : text(options.system),
    messages,
    tools: { count: names.length, names: names.filter((name): name is string => name !== undefined) },
    // GenerateOptions has no tool_choice / parallel_tool_calls vocabulary.
    // Never inspect unknown extensions, headers, URLs, or raw request objects.
  };
  const serialized = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error('capture too large');
  return serialized;
}

/**
 * Install optional public llm/stream observation. Disabled by default. The
 * operator must create outputDir with mode 0700 and its `enabled` sentinel;
 * absence creates nothing. Removing the sentinel disables subsequent captures
 * without restart (already-written captures remain sensitive). Never mkdir or
 * chmod a user path. Reject a whole capture over 2 MiB, never truncate it.
 *
 * This is normalized input at this middleware's position, NOT the final HTTP
 * request; later middleware/adapters may transform it. System/developer text
 * itself can contain secrets. No user/assistant/tool text, schemas, headers,
 * credentials, endpoints or standard logging are included. The untouched stream
 * is returned directly; no extra model calls or stream consumption occur.
 */
export function installPromptDebug(ctx: Context, options: PromptDebugOptions): () => void {
  const maxCalls = options.maxCalls ?? 3;
  if (options.enabled !== true || typeof options.sessionId !== 'string' || options.sessionId.trim() === ''
    || typeof options.outputDir !== 'string' || !isAbsolute(options.outputDir)
    || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > PROCESS_LIMIT) return () => {};
  const outputDir = resolve(options.outputDir);
  const sessionId = options.sessionId;
  let calls = 0;
  return ctx.on('llm/stream', (request, next) => {
    try {
      const budget = budgets[BUDGET_KEY] ??= { attempts: 0 };
      if (request.sessionId === sessionId && calls < maxCalls && budget.attempts < PROCESS_LIMIT) {
        const directory = privateDirectory(outputDir);
        if (enabled(outputDir)) {
          // Reserve before serializing/writing, including failures. All capture
          // work is synchronous, so concurrent calls cannot overshoot either cap.
          calls++;
          budget.attempts++;
          const data = capture(request);
          if (enabled(outputDir)) {
            const current = privateDirectory(outputDir);
            if (current.dev !== directory.dev || current.ino !== directory.ino) throw new Error('directory changed');
            const path = join(outputDir, `prompt-${process.pid}-${randomUUID()}.json`);
            const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
              const file = fstatSync(fd);
              const after = privateDirectory(outputDir);
              if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.()
                || (file.mode & 0o777) !== 0o600 || after.dev !== directory.dev || after.ino !== directory.ino) {
                throw new Error('unsafe capture file');
              }
              if (enabled(outputDir)) writeFileSync(fd, data, 'utf8');
            } finally {
              closeSync(fd);
            }
          }
        }
      }
    } catch {
      // Debugging must never fail a model call or log prompt-bearing errors.
    }
    return next();
  });
}
