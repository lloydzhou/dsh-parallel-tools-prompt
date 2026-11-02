import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPromptDebug, type PromptDebugOptions } from '../src/debug.js';

const roots: string[] = [];
const contexts: Context[] = [];
const budgetKey = Symbol.for('dsh-parallel-tools-prompt.prompt-debug.budget.v1');
beforeEach(() => { delete (globalThis as unknown as Record<symbol, unknown>)[budgetKey]; });
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'prompt-debug-test-'));
  roots.push(root);
  const outputDir = join(root, 'private');
  const ctx = new Context();
  contexts.push(ctx);
  const options: PromptDebugOptions = { enabled: true, sessionId: 'session-target', outputDir };
  function enable() {
    mkdirSync(outputDir, { mode: 0o700 });
    writeFileSync(join(outputDir, 'enabled'), '', { mode: 0o600 });
  }
  function files() { return readdirSync(outputDir).filter(name => name.endsWith('.json')); }
  function records() { return files().map(name => JSON.parse(readFileSync(join(outputDir, name), 'utf8'))); }
  function invoke(request = requestOptions(), next = () => empty()) {
    return ctx.waterfall('llm/stream', request, next);
  }
  return { ctx, root, outputDir, options, enable, files, records, invoke };
}

function requestOptions(extra: Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: 'deepseek', model: 'deepseek-chat', sessionId: 'session-target',
    system: 'Complete system\n\n尾部\u0000',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'System message' }], source: { kind: 'plugin', plugin: 'secret-source' } },
      { role: 'developer', content: [{ type: 'text', text: 'Developer message' }] },
      { role: 'user', content: [{ type: 'text', text: 'SECRET_USER' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'SECRET_ASSISTANT' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'SECRET_TOOL' }] },
    ],
    tools: [{ name: 'bash', description: 'SECRET_DESCRIPTION', parameters: { secret: 'SECRET_SCHEMA' } }],
    headers: { authorization: 'SECRET_HEADER' }, apiKey: 'SECRET_KEY', baseURL: 'https://SECRET_ENDPOINT',
    ...extra,
  } as unknown as GenerateOptions;
}
async function* empty(): AsyncGenerator<StreamChunk> { /* no chunks */ }
function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.freeze(value);
  for (const member of Object.values(value)) freezeDeep(member);
}

describe('temporary normalized prompt debug', () => {
  it('defaults off and never creates an absent directory or sentinel', () => {
    const f = fixture();
    const { enabled: _, ...off } = f.options;
    installPromptDebug(f.ctx, off);
    f.invoke();
    expect(existsSync(f.outputDir)).toBe(false);
    installPromptDebug(f.ctx, f.options);
    f.invoke();
    expect(existsSync(f.outputDir)).toBe(false);
    mkdirSync(f.outputDir, { mode: 0o700 });
    f.invoke();
    expect(readdirSync(f.outputDir)).toEqual([]);
  });

  it('captures exact complete system/developer text, not other payloads, without mutation', () => {
    const f = fixture(); f.enable();
    installPromptDebug(f.ctx, f.options);
    const request = requestOptions({ purpose: 'compaction', tool_choice: { secret: 'SECRET_CHOICE' }, parallel_tool_calls: 'SECRET_PARALLEL' });
    const before = JSON.stringify(request);
    freezeDeep(request);
    const source = empty();
    const next = vi.fn(() => source);
    expect(f.invoke(request, next)).toBe(source);
    expect(next).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(request)).toBe(before);
    const [record] = f.records();
    expect(record.system).toBe(request.system);
    expect(record.messages).toEqual([
      { role: 'system', text: ['System message'] },
      { role: 'developer', text: ['Developer message'] },
    ]);
    expect(record.tools).toEqual({ count: 1, names: ['bash'] });
    expect(record.purpose).toBe('compaction');
    expect(record.boundary).toContain('NOT final HTTP');
    expect(JSON.stringify(record)).not.toContain('SECRET');
    expect(JSON.stringify(record)).not.toContain('secret-source');
    expect(statSync(f.outputDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.outputDir, f.files()[0]!)).mode & 0o777).toBe(0o600);
  });

  it('filters exact sessions and disables immediately when sentinel is removed', () => {
    const f = fixture(); f.enable(); installPromptDebug(f.ctx, f.options);
    for (const sessionId of [undefined, '', 'session-target-child', 'other', 'session-targe']) f.invoke(requestOptions({ sessionId }));
    expect(f.files()).toHaveLength(0);
    f.invoke();
    unlinkSync(join(f.outputDir, 'enabled'));
    f.invoke();
    expect(f.files()).toHaveLength(1);
    writeFileSync(join(f.outputDir, 'enabled'), '', { mode: 0o600 });
    f.invoke();
    expect(f.files()).toHaveLength(2);
  });

  it('defaults to three attempts and does not reset on sentinel toggling', () => {
    const f = fixture(); f.enable(); installPromptDebug(f.ctx, f.options);
    for (let i = 0; i < 8; i++) f.invoke();
    expect(f.files()).toHaveLength(3);
    unlinkSync(join(f.outputDir, 'enabled'));
    writeFileSync(join(f.outputDir, 'enabled'), '');
    f.invoke();
    expect(f.files()).toHaveLength(3);
  });

  it('enforces configured and process-wide caps across installations', () => {
    const first = fixture(); first.enable(); installPromptDebug(first.ctx, { ...first.options, maxCalls: 2 });
    for (let i = 0; i < 4; i++) first.invoke();
    expect(first.files()).toHaveLength(2);
    const second = fixture(); second.enable(); installPromptDebug(second.ctx, { ...second.options, maxCalls: 10 });
    for (let i = 0; i < 20; i++) second.invoke();
    expect(second.files()).toHaveLength(8);
    const third = fixture(); third.enable(); installPromptDebug(third.ctx, third.options);
    third.invoke(); expect(third.files()).toHaveLength(0);
  });

  it.each([0, 11, -1, 1.5, NaN])('fails closed for invalid maxCalls %s', maxCalls => {
    const f = fixture(); f.enable(); installPromptDebug(f.ctx, { ...f.options, maxCalls });
    f.invoke(); expect(f.files()).toHaveLength(0);
  });

  it('rejects oversized and JSON-escaped captures whole, counting failed attempts', () => {
    const f = fixture(); f.enable(); installPromptDebug(f.ctx, { ...f.options, maxCalls: 2 });
    f.invoke(requestOptions({ system: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    f.invoke(requestOptions({ system: '\u0000'.repeat(400_000) }));
    f.invoke();
    expect(f.files()).toHaveLength(0);
  });

  it('does not follow output directory, ancestor, or sentinel symlinks', () => {
    const f = fixture();
    const real = join(f.root, 'real'); mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, 'enabled'), '');
    symlinkSync(real, f.outputDir);
    installPromptDebug(f.ctx, f.options); f.invoke();
    expect(readdirSync(real)).toEqual(['enabled']);
    const g = fixture(); g.enable();
    unlinkSync(join(g.outputDir, 'enabled'));
    const target = join(g.root, 'target'); writeFileSync(target, '');
    symlinkSync(target, join(g.outputDir, 'enabled'));
    installPromptDebug(g.ctx, g.options); g.invoke(); expect(g.files()).toHaveLength(0);
    const h = fixture();
    const alias = join(h.root, 'alias'); symlinkSync(f.root, alias);
    installPromptDebug(h.ctx, { ...h.options, outputDir: join(alias, 'real') }); h.invoke();
    expect(readdirSync(real)).toEqual(['enabled']);
  });

  it('rejects non-private directories and leaves their permissions unchanged', () => {
    const f = fixture(); f.enable(); chmodSync(f.outputDir, 0o755);
    installPromptDebug(f.ctx, f.options); f.invoke();
    expect(f.files()).toHaveLength(0);
    expect(statSync(f.outputDir).mode & 0o777).toBe(0o755);
  });

  it('passes chunks and downstream errors through unchanged even when capture fails', async () => {
    const f = fixture(); f.enable(); installPromptDebug(f.ctx, f.options);
    const failure = new Error('stream failure');
    const chunk = { type: 'text-delta', text: 'SECRET_STREAM' } as unknown as StreamChunk;
    async function* source() { yield chunk; throw failure; }
    const stream = source();
    const result = f.invoke(requestOptions({ system: 23 }), () => stream);
    expect(result).toBe(stream);
    const iterator = result[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(chunk);
    await expect(iterator.next()).rejects.toBe(failure);
    expect(f.files()).toHaveLength(0);
    expect(() => f.invoke(requestOptions(), () => { throw failure; })).toThrow(failure);
  });

  it('disposes observation and rejects malformed metadata rather than serializing objects', () => {
    const f = fixture(); f.enable();
    const dispose = installPromptDebug(f.ctx, f.options);
    f.invoke(requestOptions({ provider: { secret: 'SECRET_PROVIDER' }, model: 'https://SECRET_ENDPOINT', purpose: { secret: 'SECRET_PURPOSE' } }));
    const [record] = f.records();
    expect(record.provider).toBeUndefined(); expect(record.model).toBeUndefined(); expect(record.purpose).toBeUndefined();
    dispose(); f.invoke(); expect(f.files()).toHaveLength(1);
  });
});
