/** Stable prompt bytes: no runtime interpolation, tool inventory, or per-turn state. */
export const SECTION_NAME = 'parallel-tools:guidance';
export const SECTION_ORDER = 1050;

/** Shared by both injection channels and the distributed skill description. */
export const BATCH_RULE = `Treat the current subgoal as a dependency DAG: tool calls are nodes; required results, conditions, approvals, and state ordering are edges. Before calling tools, identify useful calls whose prerequisites are satisfied and inputs are known. Issue all ready, independent tool calls together in one response, within tool/output limits, to reduce model round trips and enable parallel execution where supported. Gather independent evidence together even if a later decision needs all of it. Wait if an earlier result determines whether or how a call runs, or if calls could conflict through shared state (including read-before-edit). After results arrive, reassess what is ready; do not repeat completed or running work. A single call is correct when nothing else is ready; never invent work to fill a batch. Use available tools as intended, not shell wrappers or delegation solely to simulate batching. No extra turn or printed DAG solely for scheduling; preserve required plan, todo, and approval workflows.`;

/** The "Tool-call scheduling:" prefix is the verification marker searched for in system/message. */
export const PARALLEL_TOOLS_PROMPT = `Tool-call scheduling: ${BATCH_RULE}`;

/** Same rule in the history-backed context channel, without a second policy to maintain. */
export const CONTEXT_REMINDER = BATCH_RULE;
