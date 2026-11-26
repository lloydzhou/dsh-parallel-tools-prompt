---
name: batch-tool-calls
description: "Before each tool-using response, silently list every call whose arguments you already know and send them all together. Per call, ask: could a pending result change whether I make it or what I pass? If not, include it now. A lone call is right only when every other next call depends on its result. Typical batches: a task's opening reads and searches; every file or symbol one result points to (e.g. each frame of a stack trace); edits to different files once their content is known; read-only checks like typecheck, lint and tests. Calls in one response may run concurrently and in any order, so wait when a result decides the next call, approval is needed, or calls touch the same state (read before edit, edit before run, two edits to one file). Don't fake batches: no unrelated commands chained into one shell call, no subagents for quick calls, no speculative calls. While background work runs, do unrelated work; never poll or repeat running or finished calls. Never skip required plan, todo or approval steps."
---

# Batch ready tool calls

## The test

Before each tool-using response, silently list every call whose arguments you already know. For each one ask: **could a pending result change whether I make this call, or what I pass to it?** If not, it is ready: send it in this response. Do not print the list or spend a turn on scheduling.

A response with a single call is right only when every other call you would make next depends on that call's result.

If you think in dependency graphs: this test picks out the current ready layer, the calls with no unmet dependency. Send that whole layer at once; you never need to plan the full graph.

## Batch these

- **Opening reads and searches.** Starting a task that names `src/a.ts`, `src/b.ts` and a config file: read all three and run the search for the symbol in one response.
- **One result, several follow-ups.** A stack trace names three files, or a search returns four matches you need to inspect: read all of them together, not one per turn.
- **Independent edits.** Once you know the change for each file, edit different files in the same response.
- **Read-only checks.** After edits are done, typecheck, lint and tests that do not write shared state go together.

## Wait for these

Calls in one response may run concurrently and in any order. Keep calls in separate responses when:

- a result decides whether to make the next call or what it takes (a search must find a path before you read it; don't guess the path);
- approval is required first;
- they touch the same state: read before edit, edit before run, two edits to one file, write then read back.

`test → read failure → fix → retest` is a valid serial chain, and so is a single call when nothing else is ready.

## Don't fake batches

- Don't chain unrelated commands into one shell call (`cat a; cat b; ls c`) to look parallel; use separate tool calls. A command whose steps really depend on each other (`build && test`) is fine.
- Don't launch subagents just to parallelize quick calls.
- Don't add speculative calls you would not otherwise make.

## Background work

While a background job or subagent runs, do work that neither needs its result nor touches its state (e.g. read unrelated docs while tests run; don't edit files the tests depend on). Don't busy-poll, and never repeat a call or delegation that is running or finished.

Required plan, todo and approval workflows still apply. Actual concurrency is up to the host scheduler; the goal is fewer avoidable model round trips.
