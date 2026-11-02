#!/usr/bin/env node
/**
 * Read-only descriptive metrics for explicitly named DSH session logs.
 * No session discovery, network, content output, replay, or deduplication.
 * Counts include inherited/seed events and repeated input files. These are NOT
 * billed API counts, concurrency measurements, LLM latency, or causal savings.
 * JSONL is read with readline; zstd is synchronous and limited to 64 MiB both
 * compressed and expanded. Requires Node's built-in zstd support (Node >=24.9).
 * Only the event envelope and metric-bearing fields are validated, not the full
 * extensible DSH schema. Unknown event types are counted but otherwise ignored.
 */
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAX_ZSTD_BYTES = 64 * 1024 * 1024;
const HELP = `Usage: node scripts/analyze-session.mjs FILE.jsonl [FILE.jsonl.zstd ...]
Explicit files only; no default scan, network, writes, or content/path output.
Outputs per-file (1-based fileIndex) and pooled aggregate JSON metrics.
Batch sizes come only from assistant/message content tool-call blocks.
Tool execution events (tool/call) and assistant/attempt events are separate.
Multi-call proportion uses tool-bearing responses as its denominator.
Missing denominators and unreported output-token totals are null, not zero.
Raw log counts include inherited history and repeated files; no deduplication.
Not billed API counts, actual concurrency, LLM latency, or causal A/B savings.
JSONL streams via readline. Zstd buffers synchronously: 64 MiB input/output cap.
Unknown events are ignored for metrics; this is not full schema validation.
`;

class InputError extends Error {}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
function requireValid(condition) {
  if (!condition) throw new InputError('invalid event structure');
}
function accumulator() {
  return {
    eventCount: 0, modelResponseEvents: 0, modelAttemptEvents: 0,
    toolExecutionEvents: 0, toolResultEvents: 0, toolCallBlocks: 0,
    toolBearingResponses: 0, multiCallResponses: 0,
    knownResponseCount: 0, unknownResponseCount: 0, reportedTotal: 0,
    batchSizes: new Map(),
  };
}
function add(state, event) {
  requireValid(object(event) && typeof event.type === 'string' && event.type.length > 0);
  if (event.type === 'session') {
    requireValid(count(event.version) && typeof event.id === 'string' && count(event.createdAt));
    return;
  }
  requireValid(object(event.data) && count(event.seq) && count(event.time));
  state.eventCount++;
  const { data } = event;
  if (event.type === 'assistant/message') {
    requireValid(object(data.message) && data.message.role === 'assistant' && Array.isArray(data.message.content));
    let calls = 0;
    for (const block of data.message.content) {
      requireValid(object(block) && typeof block.type === 'string');
      if (block.type === 'tool-call') {
        requireValid(typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string');
        calls++;
      }
    }
    state.modelResponseEvents++;
    state.toolCallBlocks += calls;
    if (calls > 0) {
      state.toolBearingResponses++;
      if (calls > 1) state.multiCallResponses++;
      state.batchSizes.set(calls, (state.batchSizes.get(calls) ?? 0) + 1);
    }
    if (data.usage !== undefined) requireValid(object(data.usage));
    const tokens = data.usage?.outputTokens;
    if (tokens === undefined) state.unknownResponseCount++;
    else {
      requireValid(count(tokens));
      state.knownResponseCount++;
      state.reportedTotal += tokens;
      requireValid(Number.isSafeInteger(state.reportedTotal));
    }
  } else if (event.type === 'assistant/attempt') {
    requireValid(Array.isArray(data.stream));
    state.modelAttemptEvents++;
  } else if (event.type === 'tool/call') {
    requireValid(typeof data.callId === 'string' && typeof data.name === 'string' && typeof data.arguments === 'string');
    state.toolExecutionEvents++;
  } else if (event.type === 'tool/result') {
    requireValid(object(data.message) && data.message.role === 'tool');
    state.toolResultEvents++;
  }
}
function finish(state) {
  const { batchSizes, knownResponseCount, unknownResponseCount, reportedTotal, ...metrics } = state;
  const n = state.toolBearingResponses;
  let median = null;
  if (n) {
    const left = Math.floor((n - 1) / 2);
    const right = Math.floor(n / 2);
    let seen = 0;
    let sum = 0;
    for (const [size, frequency] of [...batchSizes].sort((a, b) => a[0] - b[0])) {
      if (left >= seen && left < seen + frequency) sum += size;
      if (right >= seen && right < seen + frequency) sum += size;
      seen += frequency;
    }
    median = sum / 2;
  }
  return {
    ...metrics,
    multiCallResponseProportion: n ? state.multiCallResponses / n : null,
    meanCallsPerToolBearingResponse: n ? state.toolCallBlocks / n : null,
    medianCallsPerToolBearingResponse: median,
    outputTokens: { reportedTotal: knownResponseCount ? reportedTotal : null, knownResponseCount, unknownResponseCount },
  };
}

/** Pure metrics over iterable public SessionEvent objects (optional session header). */
export function analyzeEvents(events) {
  const state = accumulator();
  for (const event of events) add(state, event);
  return finish(state);
}

async function inputStream(file) {
  if (!file.endsWith('.jsonl') && !file.endsWith('.zstd')) throw new InputError('expected .jsonl or .zstd file');
  const handle = await open(file, 'r');
  let transferred = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InputError('expected a regular file');
    if (file.endsWith('.zstd')) {
      if (stat.size > MAX_ZSTD_BYTES) throw new InputError('zstd input exceeds 64 MiB limit');
      const compressed = await handle.readFile();
      if (compressed.length > MAX_ZSTD_BYTES) throw new InputError('zstd input exceeds 64 MiB limit');
      let decoded;
      try { decoded = zstdDecompressSync(compressed, { maxOutputLength: MAX_ZSTD_BYTES }); }
      catch { throw new InputError('invalid zstd or expanded data exceeds 64 MiB limit'); }
      return Readable.from([decoded]);
    }
    // The verified handle is reused: no second path lookup or implicit scanning.
    const stream = handle.createReadStream({ autoClose: true });
    transferred = true;
    return stream;
  } finally {
    if (!transferred) await handle.close();
  }
}

/** Analyze only supplied files; never include their names or content in results/errors. */
export async function analyzeFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new InputError('supply at least one explicit session file');
  const aggregate = accumulator();
  const results = [];
  for (const [index, file] of files.entries()) {
    let lineNumber = 0;
    let input;
    let lines;
    const local = accumulator();
    try {
      input = await inputStream(file);
      lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); }
        catch { throw new InputError('malformed JSON'); }
        add(local, event);
        add(aggregate, event);
      }
    } catch (error) {
      const reason = error instanceof InputError ? error.message : 'unable to read session';
      throw new InputError(`file ${index + 1}${lineNumber ? `, line ${lineNumber}` : ''}: ${reason}`);
    } finally {
      lines?.close();
      input?.destroy();
    }
    results.push({ fileIndex: index + 1, metrics: finish(local) });
  }
  return { files: results, aggregate: finish(aggregate) };
}

async function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return;
  }
  try {
    if (args.some(arg => arg.startsWith('-'))) throw new InputError('unknown option; use --help (prefix dash-leading paths with ./)');
    process.stdout.write(`${JSON.stringify(await analyzeFiles(args), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`analyze-session: ${error instanceof InputError ? error.message : 'analysis failed'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
