/** Stable prompt bytes: no runtime interpolation, tool inventory, or per-turn state. */
export const SECTION_NAME = 'parallel-tools:guidance';
export const SECTION_ORDER = 1050;

export const PARALLEL_TOOLS_PROMPT = `Tool-call scheduling:
- Before each response, briefly check what else the current subgoal already has ready: same-tool calls on different targets, parallel reads, independent searches and checks. Issue every ready, independent call together in THIS response.
- Hold a call only when its arguments depend on an earlier result, or ordering is required (read-before-edit, shared file, approval flow). A later combined decision does not make independent collection sequential.
- A single call is correct when nothing else is ready; never invent or duplicate calls to fill a batch. Keep scheduling internal: no planning-only turn, no shell wrappers or delegation just to simulate batching.
- Several calls in one response do not force simultaneous execution; the host scheduler, permissions, and all safety rules still apply.`;
