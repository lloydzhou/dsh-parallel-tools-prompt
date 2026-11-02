/** Stable prompt bytes: no runtime interpolation, tool inventory, or per-turn state. */
export const SECTION_NAME = 'parallel-tools:guidance';
export const SECTION_ORDER = 1050;

/** Single source of truth: also the description of skills/batch-tool-calls/SKILL.md (a test keeps them identical). */
export const BATCH_RULE = `Before every response that uses tools, (1) list what the current subgoal already has ready, (2) issue ALL ready, independent calls together in one response (parallel reads, searches, checks), (3) split only for real dependencies (needs an earlier result, read-before-edit, shared-file or approval order). One call per response wastes a model round trip; a single call is fine when nothing else is ready, so never invent calls to fill a batch. No planning-only turn, no shell wrappers or delegation to simulate batching.`;

/** The "Tool-call scheduling:" prefix is the verification marker searched for in system/message. */
export const PARALLEL_TOOLS_PROMPT = `Tool-call scheduling: ${BATCH_RULE}`;
