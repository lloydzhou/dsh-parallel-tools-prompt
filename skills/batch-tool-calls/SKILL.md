---
name: batch-tool-calls
description: "Before calling tools, briefly check what other useful work can run now without these results. Use an internal dependency DAG for the current subgoal: batch all ready, independent tool calls together in one response, within tool/output limits, with known inputs and prerequisites met. Gather independent evidence together even if later combined. Wait for results that decide whether or how to act, approvals, or shared-state ordering (including read-before-edit). While background work runs, continue work independent of its results and non-interfering with its state. After results, reassess; never repeat running/completed work. Real dependency chains and single calls are valid; never invent work. Use tools as intended, not shell wrappers or delegation to simulate batching. No printed DAG or extra scheduling turns; preserve required plan, todo, and approval workflows. Aim to reduce model round trips; actual concurrency depends on runtime."
---

# Batch ready tool calls

Before calling tools, briefly check what other useful work can run now without these results. Then use an internal dependency DAG for the current subgoal: calls are nodes; required results, conditions, approvals, and shared-state ordering are edges.

1. Batch all useful, ready, independent calls in one response when inputs are known and prerequisites are met, within tool/output limits. Collect independent evidence together even if a later decision needs it all.
2. Wait when a result determines whether or how to act, approval is pending, or shared-state ordering requires it (including read-before-edit). Real dependency chains and single calls are valid; never invent work to fill a batch.
3. While background work runs, continue useful work that neither needs its results nor interferes with its state. Follow the host's job tracking and result collection rules; do not busy-poll or duplicate running/completed calls or delegations. After results arrive, reassess what is ready.
4. Use tools as intended, not shell wrappers or delegation solely to simulate batching. Do not print a DAG or add scheduling-only turns; required plan, todo, and approval workflows still apply.

For example, read independent files A and B together, then make the decision that needs both. If a search must discover B's path, search first rather than guessing it. A test failure must be read before choosing a fix, and the fix must finish before retesting: `test → failure → fix → retest` is a valid serial chain. While tests run in the background, inspect unrelated documentation if useful, but do not edit files those tests depend on or launch the same tests again.

The aim is fewer avoidable model round trips, not a minimum batch size. Actual concurrency depends on the runtime/host scheduler; batching does not override it or guarantee lower latency, tokens, or cost.
