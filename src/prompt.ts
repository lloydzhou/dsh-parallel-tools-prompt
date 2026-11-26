/** Stable prompt bytes: no runtime interpolation, tool inventory, or per-turn state. */
export const SECTION_NAME = 'parallel-tools:guidance';
/**
 * After every per-tool section (TOOL_* 1000–3000, MCP_SERVERS 3100) so the
 * guidance neither splits the tool descriptions nor precedes the jobs/subagent
 * sections it refers to; before TOOLS_SDK (5000) and output/persona sections.
 */
export const SECTION_ORDER = 3200;

/** Shared by both injection channels and the distributed skill description. */
export const BATCH_RULE = `Before each tool-using response, silently list every call whose arguments you already know and send them all together. Per call, ask: could a pending result change whether I make it or what I pass? If not, include it now. A lone call is right only when every other next call depends on its result. Typical batches: a task's opening reads and searches; every file or symbol one result points to (e.g. each frame of a stack trace); edits to different files once their content is known; read-only checks like typecheck, lint and tests. Calls in one response may run concurrently and in any order, so wait when a result decides the next call, approval is needed, or calls touch the same state (read before edit, edit before run, two edits to one file). Don't fake batches: no unrelated commands chained into one shell call, no subagents for quick calls, no speculative calls. While background work runs, do unrelated work; never poll or repeat running or finished calls. Never skip required plan, todo or approval steps.`;

/** The "Tool-call scheduling:" prefix is the verification marker searched for in system/message. */
export const PARALLEL_TOOLS_PROMPT = `Tool-call scheduling: ${BATCH_RULE}`;

/**
 * Same rule in the history-backed context channel. Delivered once per visible
 * history, so the prefix states it persists rather than describing one step.
 */
export const CONTEXT_REMINDER = `Tool-call scheduling (applies to every remaining step of this session): ${BATCH_RULE}`;
