---
name: batch-tool-calls
description: "Treat the current subgoal as a dependency DAG: tool calls are nodes; required results, conditions, approvals, and state ordering are edges. Before calling tools, identify useful calls whose prerequisites are satisfied and inputs are known. Issue all ready, independent tool calls together in one response, within tool/output limits, to reduce model round trips and enable parallel execution where supported. Gather independent evidence together even if a later decision needs all of it. Wait if an earlier result determines whether or how a call runs, or if calls could conflict through shared state (including read-before-edit). After results arrive, reassess what is ready; do not repeat completed or running work. A single call is correct when nothing else is ready; never invent work to fill a batch. Use available tools as intended, not shell wrappers or delegation solely to simulate batching. No extra turn or printed DAG solely for scheduling; preserve required plan, todo, and approval workflows."
---

# Batch ready tool calls

Think in dependencies across the current subgoal, not just the next action. The DAG is a mental model, not a graph you must print or execute with a new tool.

1. Identify useful calls whose prerequisites are satisfied and arguments are known.
2. Issue ready, independent calls together, respecting tool/output limits and shared-state ordering.
3. Wait when a result determines whether or how another call should run. After results arrive, reassess the ready set without duplicating completed or running work.
4. Do not invent work or add a scheduling-only round. Required planning, todo, and approval workflows still apply.

For example, read independent files A and B together, then make the decision that needs both. If a search must discover B's path, search first rather than guessing it. Keep conflicting edits ordered; independent evidence gathering need not wait for the final decision.

Batching reduces model round trips and allows concurrency where the host supports it; it does not override the host scheduler or guarantee a speedup.
