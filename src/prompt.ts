/** Stable prompt bytes: no runtime interpolation, tool inventory, or per-turn state. */
export const SECTION_NAME = 'parallel-tools:guidance';
export const SECTION_ORDER = 1050;

/** Shared by both injection channels and the distributed skill description. */
export const BATCH_RULE = `Before calling tools, briefly check what other useful work can run now without these results. Use an internal dependency DAG for the current subgoal: batch all ready, independent tool calls together in one response, within tool/output limits, with known inputs and prerequisites met. Gather independent evidence together even if later combined. Wait for results that decide whether or how to act, approvals, or shared-state ordering (including read-before-edit). While background work runs, continue work independent of its results and non-interfering with its state. After results, reassess; never repeat running/completed work. Real dependency chains and single calls are valid; never invent work. Use tools as intended, not shell wrappers or delegation to simulate batching. No printed DAG or extra scheduling turns; preserve required plan, todo, and approval workflows. Aim to reduce model round trips; actual concurrency depends on runtime.`;

/** The "Tool-call scheduling:" prefix is the verification marker searched for in system/message. */
export const PARALLEL_TOOLS_PROMPT = `Tool-call scheduling: ${BATCH_RULE}`;

/** Same rule in the history-backed context channel, without a second policy to maintain. */
export const CONTEXT_REMINDER = BATCH_RULE;
