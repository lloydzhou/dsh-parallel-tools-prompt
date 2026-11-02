---
name: batch-tool-calls
description: "Before every response that uses tools, (1) list what the current subgoal already has ready, (2) issue ALL ready, independent calls together in one response (parallel reads, searches, checks), (3) split only for real dependencies (needs an earlier result, read-before-edit, shared-file or approval order). One call per response wastes a model round trip; a single call is fine when nothing else is ready, so never invent calls to fill a batch. No planning-only turn, no shell wrappers or delegation to simulate batching."
---

# Batch ready tool calls

Each response is one model round trip. Issuing ready work one call at a time spends one round trip per call.

Before each response:

1. Check what else the current subgoal already has ready: same-tool calls on different targets, parallel reads, independent searches and checks.
2. Issue every ready, independent call together in this one response.
3. Hold a call only for real dependencies: its arguments need an earlier result, read-before-edit, shared-file or approval ordering.
4. A single call is fine when nothing else is ready. Never invent calls to fill a batch.

Plan the next batch after the results return; do not add a separate planning round.
