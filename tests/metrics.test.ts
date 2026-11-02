import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { zstdCompressSync } from 'node:zlib';
// The standalone dependency-free CLI deliberately ships JavaScript, not declarations.
// @ts-expect-error Standalone .mjs module has no TypeScript declaration file.
import { analyzeEvents, analyzeFiles } from '../scripts/analyze-session.mjs';

const cli = fileURLToPath(new URL('../scripts/analyze-session.mjs', import.meta.url));
const secret = 'PRIVATE-CONTENT-DO-NOT-PRINT';
const temporaryDirectories: string[] = [];
async function fixture(name: string, content: string | Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-metrics-'));
  temporaryDirectories.push(directory);
  const file = join(directory, name);
  await writeFile(file, content);
  return file;
}
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // Each target is the exact absolute directory returned by mkdtemp above.
    await rm(directory, { recursive: true, force: true });
  }
});
const event = (type: string, data: Record<string, unknown>, seq = 0) => ({ type, data, seq, time: 1000 });
const call = (id: number) => ({ type: 'tool-call', id: `call-${id}`, name: secret, arguments: JSON.stringify({ text: secret }) });
function response(calls: number, tokens?: number) {
  return event('assistant/message', {
    turn: 0, step: 0,
    message: { role: 'assistant', content: [{ type: 'text', text: secret }, ...Array.from({ length: calls }, (_, i) => call(i))] },
    stream: [], ...(tokens === undefined ? {} : { usage: { outputTokens: tokens } }),
  });
}
const jsonl = (events: unknown[]) => `${events.map(value => JSON.stringify(value)).join('\n')}\n`;
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

describe('session metrics use disjoint public event types', () => {
  it('counts response batches only from assistant content, not executions or streams', () => {
    const metrics = analyzeEvents([
      response(3, 12), response(1, 0), response(0),
      event('assistant/attempt', { stream: [{ type: 'tool-call-chunks', data: [call(9)] }], usage: { outputTokens: 900 } }),
      ...Array.from({ length: 5 }, (_, i) => event('tool/call', { callId: `call-${i}`, name: secret, arguments: secret })),
      event('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: secret }] } }),
      event('user/message', { message: { content: [call(8)] } }),
    ]);
    expect(metrics).toEqual({
      eventCount: 11, modelResponseEvents: 3, modelAttemptEvents: 1,
      toolExecutionEvents: 5, toolResultEvents: 1, toolCallBlocks: 4,
      toolBearingResponses: 2, multiCallResponses: 1,
      multiCallResponseProportion: 0.5, meanCallsPerToolBearingResponse: 2,
      medianCallsPerToolBearingResponse: 2,
      outputTokens: { reportedTotal: 12, knownResponseCount: 2, unknownResponseCount: 1 },
    });
    expect(JSON.stringify(metrics)).not.toContain(secret);
  });

  it('returns null for zero denominators and wholly unknown token totals', () => {
    const metrics = analyzeEvents([]);
    expect(metrics.multiCallResponseProportion).toBeNull();
    expect(metrics.meanCallsPerToolBearingResponse).toBeNull();
    expect(metrics.medianCallsPerToolBearingResponse).toBeNull();
    expect(metrics.outputTokens).toEqual({ reportedTotal: null, knownResponseCount: 0, unknownResponseCount: 0 });
    expect(analyzeEvents([response(0)]).outputTokens).toEqual({ reportedTotal: null, knownResponseCount: 0, unknownResponseCount: 1 });
    expect(analyzeEvents([response(0, 0)]).outputTokens.reportedTotal).toBe(0);
  });

  it('computes odd and even medians without including text-only responses', () => {
    expect(analyzeEvents([response(5), response(1), response(2), response(0)]).medianCallsPerToolBearingResponse).toBe(2);
    expect(analyzeEvents([response(5), response(1), response(1), response(2)]).medianCallsPerToolBearingResponse).toBe(1.5);
  });

  it.each([
    null, [], {}, { type: 'assistant/message', data: {} },
    event('assistant/message', { message: { role: 'assistant', content: 'not blocks' } }),
    event('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call' }] } }),
    response(0, -1), response(0, 1.5), response(0, Number.NaN),
    event('assistant/attempt', { stream: 'invalid' }),
    event('tool/call', { callId: 1 }),
    event('tool/result', { message: { role: 'assistant' } }),
  ])('rejects malformed metric-bearing events %#', value => {
    expect(() => analyzeEvents([value])).toThrow('invalid event structure');
  });

  it('ignores extensible event payloads and never mutates input', () => {
    const events = [response(2, 7), event('plugin:example/record', { text: secret })];
    const before = JSON.stringify(events);
    expect(analyzeEvents(events).modelResponseEvents).toBe(1);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe('explicit-file read-only CLI', () => {
  it('streams JSONL, accepts headers, and pools raw observations across files', async () => {
    const firstContent = jsonl([{ type: 'session', version: 4, id: secret, createdAt: 1000, cwd: secret, delegationDepth: 0 }, response(1, 4), response(0)]);
    const first = await fixture(`${secret}.jsonl`, firstContent);
    const second = await fixture('second.jsonl', `\n${jsonl([response(3, 8), response(5)])}`);
    const result = run(first, second);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report.files.map((entry: { fileIndex: number }) => entry.fileIndex)).toEqual([1, 2]);
    expect(report.aggregate.modelResponseEvents).toBe(4);
    expect(report.aggregate.meanCallsPerToolBearingResponse).toBe(3);
    expect(report.aggregate.medianCallsPerToolBearingResponse).toBe(3);
    expect(report.aggregate.multiCallResponseProportion).toBeCloseTo(2 / 3);
    expect(report.aggregate.outputTokens).toEqual({ reportedTotal: 12, knownResponseCount: 2, unknownResponseCount: 2 });
    for (const sensitive of [secret, first, second]) expect(result.stdout + result.stderr).not.toContain(sensitive);
    expect(await readFile(first, 'utf8')).toBe(firstContent);
  });

  it('supports concatenated zstd frames with the same metrics as JSONL', async () => {
    const parts = [jsonl([response(2, 9)]), jsonl([response(0), response(1, 3)])];
    const plain = await fixture('plain.jsonl', parts.join(''));
    const compressed = await fixture('compressed.jsonl.zstd', Buffer.concat(parts.map(part => zstdCompressSync(part))));
    const actual = await analyzeFiles([compressed]);
    expect(actual).toEqual(await analyzeFiles([plain]));
  });

  it('rejects missing input without scanning and has an explicit help route', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('supply at least one explicit session file');
    expect(run('--help').status).toBe(0);
  });

  it('rejects malformed JSON without leaking snippets, paths, or partial reports', async () => {
    const file = await fixture(`${secret}.jsonl`, `${jsonl([response(1)])}{"${secret}": BROKEN`);
    const result = run(file);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('file 1, line 2: malformed JSON');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(file);
  });

  it('rejects a malformed event and sanitizes filesystem and zstd errors', async () => {
    const malformed = await fixture('bad.jsonl', jsonl([{ type: 'assistant/message', data: {} }]));
    expect(run(malformed).stderr).toContain('invalid event structure');
    const missing = join(tmpdir(), secret, 'absent.jsonl');
    const absent = run(missing);
    expect(absent.status).toBe(1);
    expect(absent.stderr).not.toContain(missing);
    const corrupt = await fixture(`${secret}.zstd`, Buffer.from(secret));
    const result = run(corrupt);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid zstd');
    expect(result.stderr).not.toContain(secret);
  });

  it('enforces the expanded zstd size cap', async () => {
    const compressed = zstdCompressSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32));
    const file = await fixture('oversize.zstd', compressed);
    await expect(analyzeFiles([file])).rejects.toThrow('expanded data exceeds 64 MiB limit');
  });

  it('can be imported without running the CLI', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/analyze-session.mjs', import.meta.url).href)});`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
