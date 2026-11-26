import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as plugin from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Minimal public surface model: `log` is the raw event log, `nodes` the model-visible seqs. */
type FakeSurface = { log: Array<Record<string, unknown>>; nodes: number[]; replaceGeneration: number };

function fakeSurface(): FakeSurface & {
  append: (event: Record<string, unknown>) => void;
  compact: (keep?: (seq: number) => boolean) => void;
} {
  const state: FakeSurface = { log: [], nodes: [], replaceGeneration: 0 };
  return Object.assign(state, {
    append(event: Record<string, unknown>) {
      state.log.push(event);
      state.nodes.push(state.log.length - 1);
    },
    // Replace every visible node not kept by one summary node, like a compaction checkpoint.
    compact(keep: (seq: number) => boolean = () => false) {
      state.log.push({ type: 'user/message', data: { source: { kind: 'compact-checkpoint' }, content: [] } });
      state.nodes = [state.log.length - 1, ...state.nodes.filter(keep)];
      state.replaceGeneration += 1;
    },
  });
}

type Header = {
  agentPreset?: string;
  origin?: 'subagent';
  delegationDepth?: number;
  parentSession?: string;
};

/** Only the Agent/session facade and two public registry methods are fake.
 * Prompt registration, scoped assembly, event dispatch and effect ownership are real.
 * `registry` picks the host generation under test: 'list' (0.2.3-alpha.2+),
 * 'roots' (<= 0.2.3-alpha.1), or 'empty' (neither method exposed).
 */
async function fixture(registry: 'list' | 'roots' | 'empty' = 'list') {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  const live: Agent[] = [];
  const projectedPresets = new Map<Agent['session'], string>();
  const list = vi.fn(() => [...live]);
  const roots = vi.fn(() => [...live]);
  ctx.provide('agents', registry === 'list' ? { list } : registry === 'roots' ? { roots } : {});
  const presetForSession = vi.fn((session: Agent['session']) => projectedPresets.get(session) ?? null);
  ctx.provide('agentPresets', { presetForSession });
  ctx.provide('sessionProjections', { register: vi.fn(async () => ({ stateOf: () => void 0 })) });
  const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await promptFiber.inertia;
  // Like the real Agent host, the scope minter declares the services its
  // agent contexts may use; createScope inherits this public dependency API.
  const agentHost = ctx.plugin({ inject: ['systemPrompt'], apply() {} });
  await agentHost.inertia;

  function load(config: Record<string, unknown> = {}) {
    return ctx.plugin(plugin, config);
  }

  function agent(header: Header = { agentPreset: 'standard' }, options: { root?: boolean; projectedPreset?: string; sessionEvents?: Array<Record<string, unknown>>; surface?: FakeSurface } = {}) {
    const key = {};
    const scope = createScope(agentHost.ctx, key);
    const inject = vi.fn();
    // Deliberately omit every private Agent/registry implementation detail.
    // With `surface`, the session exposes the public surface/eventAt pair and
    // the raw log; without it, only the legacy snapshotEvents() log.
    const session = options.surface === undefined
      ? { header, snapshotEvents: () => options.sessionEvents ?? [] }
      : {
        header,
        surface: options.surface,
        eventAt: (seq: number) => options.surface!.log[seq],
        snapshotEvents: () => options.surface!.log,
      };
    const value = {
      ctx: scope.ctx,
      session,
      inject,
    } as unknown as Agent;
    if (options.root !== false) live.push(value);
    if (options.projectedPreset !== undefined) projectedPresets.set(value.session, options.projectedPreset);
    return {
      value,
      scope: key,
      dispose: scope.dispose,
      inject,
      created: (source: 'startup' | 'resume' = 'startup') =>
        ctx.serial(scopeTarget(value, key), 'agent/created', { agent: value, source }),
      // The last waterfall argument is the innermost `next`: the loop entering with an empty inbox.
      preStep: (step = 1) => (ctx as unknown as { waterfall: (...a: unknown[]) => Promise<unknown> }).waterfall(
        scopeTarget(value, key), 'agent/pre-step',
        { agent: value, messages: [], turn: 1, step, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [] }),
      ) as Promise<{ kind: string; messages: Array<{ content: Array<{ text: string }>; source: { kind: string; form?: string } }> }>,
      assemble: () => ctx.systemPrompt.assemble({ scope: key }),
      guidance: async () => (await ctx.systemPrompt.assemble({ scope: key })).sections
        .filter((section) => section.name === plugin.SECTION_NAME),
    };
  }
  return { ctx, list, roots, presetForSession, load, agent };
}

const expectedSection = {
  name: plugin.SECTION_NAME,
  order: plugin.SECTION_ORDER,
  text: plugin.PARALLEL_TOOLS_PROMPT,
  interpolate: false,
};

describe('parallel-tools prompt lifecycle with published Cordis services', () => {
  it.each([{}, { enabled: false }])('is independently disabled for config %j', async (config) => {
    const f = await fixture();
    const fiber = f.load(config);
    await fiber.inertia;
    expect((fiber as any)._effectiveConfig.enabled).toBe(false);
    expect((fiber as any)._effectiveConfig.debugEnabled).toBe(false);
    expect((fiber as any)._effectiveConfig.debugSessionId).toBe('');
    expect((fiber as any)._effectiveConfig.debugMaxCalls).toBe(3);
    const agent = f.agent();
    await agent.created();
    expect(await agent.guidance()).toEqual([]);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.presetForSession).not.toHaveBeenCalled();
    expect(renderPrompt(await f.ctx.systemPrompt.assemble())).toBe('');
  });

  it.each(['startup', 'resume'] as const)('includes a standard root on %s', async (source) => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const agent = f.agent();
    await agent.created(source);
    expect(await agent.guidance()).toEqual([expectedSection]);
    expect(renderPrompt(await agent.assemble())).toBe(plugin.PARALLEL_TOOLS_PROMPT);
  });

  it.each([
    { origin: 'subagent' as const },
    { delegationDepth: 1 },
    { delegationDepth: 3 },
  ])('excludes durable child metadata even when resumed as a live root: %j', async (metadata) => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const agent = f.agent({ agentPreset: 'standard', ...metadata });
    await agent.created('resume');
    expect(await agent.guidance()).toEqual([]);
  });

  it('excludes a live child without durable child metadata', async () => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const parent = f.agent();
    await parent.created();
    const child = f.agent({ agentPreset: 'standard' }, { root: false });
    await child.created();
    expect(await parent.guidance()).toEqual([expectedSection]);
    expect(await child.guidance()).toEqual([]);
    expect(f.list).toHaveBeenCalled();
  });

  it('does not confuse fork lineage or zero delegation depth with live parent ownership', async () => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const agent = f.agent({ agentPreset: 'standard', parentSession: 'seed-session', delegationDepth: 0 });
    await agent.created('resume');
    expect(await agent.guidance()).toEqual([expectedSection]);
  });

  it.each(['ptc', 'custom', 'Standard', 'standard-extra', undefined])('excludes nonmatching or absent preset %s', async (preset) => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const agent = f.agent(preset === undefined ? {} : { agentPreset: preset });
    await agent.created();
    expect(await agent.guidance()).toEqual([]);
  });

  it('prefers projected preset state over the durable header', async () => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const included = f.agent({ agentPreset: 'ptc' }, { projectedPreset: 'standard' });
    const excluded = f.agent({ agentPreset: 'standard' }, { projectedPreset: 'ptc' });
    await included.created('resume');
    await excluded.created('resume');
    expect(await included.guidance()).toEqual([expectedSection]);
    expect(await excluded.guidance()).toEqual([]);
    expect(f.presetForSession).toHaveBeenCalledWith(included.value.session);
  });

  it('honors explicit preset IDs and an empty allowlist', async () => {
    const f = await fixture();
    const first = f.load({ enabled: true, systemPromptSection: true, presetIds: ['custom'] });
    await first.inertia;
    const custom = f.agent({ agentPreset: 'custom' });
    const standard = f.agent();
    await custom.created();
    await standard.created();
    expect(await custom.guidance()).toEqual([expectedSection]);
    expect(await standard.guidance()).toEqual([]);
    await first.dispose();
    await f.load({ enabled: true, systemPromptSection: true, presetIds: [] }).inertia;
    const untargeted = f.agent();
    await untargeted.created();
    expect(await untargeted.guidance()).toEqual([]);
  });

  it('registers only once when the same agent event is delivered twice', async () => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const changes = vi.fn();
    f.ctx.on('system-prompt/change', changes);
    const agent = f.agent();
    await agent.created();
    await agent.created('resume');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(await agent.guidance()).toEqual([expectedSection]);
  });

  it('never registers globally or leaks into an unrelated scope', async () => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const targeted = f.agent();
    const unrelated = f.agent({ agentPreset: 'ptc' });
    await targeted.created();
    await unrelated.created();
    expect(await targeted.guidance()).toEqual([expectedSection]);
    expect((await f.ctx.systemPrompt.assemble()).sections.some((section) => section.name === plugin.SECTION_NAME)).toBe(false);
    expect(await unrelated.guidance()).toEqual([]);
  });

  it('re-attaches eligible roots that predate plugin loading (reload catch-up)', async () => {
    const f = await fixture();
    const eligible = f.agent();
    const ineligible = f.agent({ agentPreset: 'ptc' });
    const child = f.agent({ agentPreset: 'standard', origin: 'subagent' as const });
    await eligible.created();
    await ineligible.created();
    await child.created();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    expect(await eligible.guidance()).toEqual([expectedSection]);
    expect(await ineligible.guidance()).toEqual([]);
    expect(await child.guidance()).toEqual([]);
    const fresh = f.agent();
    await fresh.created();
    expect(await fresh.guidance()).toEqual([expectedSection]);
  });

  it.each(['roots', 'empty'] as const)('survives a legacy %j agent registry without crashing', async (registry) => {
    const f = await fixture(registry);
    const fiber = f.load({ enabled: true, systemPromptSection: true, contextReminder: true });
    await fiber.inertia;
    const agent = f.agent();
    await agent.created('resume');
    if (registry === 'roots') {
      // dsh-agent <= 0.2.3-alpha.1 exposes roots() only; probing must prefer it.
      expect(f.list).not.toHaveBeenCalled();
      expect(f.roots).toHaveBeenCalled();
      expect(await agent.guidance()).toEqual([expectedSection]);
    } else {
      // Fail soft: an unknown registry API degrades to no attached sections.
      expect(await agent.guidance()).toEqual([]);
    }
    // The context reminder never touches the registry, so it still delivers.
    expect((await agent.preStep()).messages).toHaveLength(1);
  });

  it('appends the reminder once via pre-step as a sourced context message', async () => {
    const f = await fixture();
    const agent = f.agent();
    await agent.created();
    await f.load({ enabled: true, contextReminder: true }).inertia;
    const first = await agent.preStep(1);
    expect(first.messages).toHaveLength(1);
    const message = first.messages[0]!;
    // Own source kind: never a fake user bubble.
    expect(message.source.kind).toBe(plugin.CONTEXT_SOURCE_KIND);
    expect(message.source.form).toBe('notice');
    expect(message.content[0]?.text).toBe(plugin.CONTEXT_REMINDER);
    expect(message.content[0]?.text).toContain('send them all together');
    expect((await agent.preStep(2)).messages).toHaveLength(0);
    expect(agent.inject).not.toHaveBeenCalled();
  });

  it('defaults to context only; both switches can be combined', async () => {
    const dflt = await fixture();
    const a = dflt.agent();
    await a.created();
    await dflt.load({ enabled: true }).inertia;
    expect(renderPrompt(await a.assemble())).toBe('');
    expect((await a.preStep()).messages).toHaveLength(1);

    const both = await fixture();
    const b = both.agent();
    await b.created();
    await both.load({ enabled: true, systemPromptSection: true, contextReminder: true }).inertia;
    expect(await b.guidance()).toEqual([expectedSection]);
    expect((await b.preStep()).messages).toHaveLength(1);
  });

  it.each([
    { header: { agentPreset: 'standard', origin: 'subagent' as const }, root: true },
    { header: { agentPreset: 'standard', delegationDepth: 2 }, root: true },
    { header: { agentPreset: 'standard' }, root: false },
    { header: { agentPreset: 'minimal' }, root: true },
    { header: { agentPreset: 'creator' }, root: true },
    { header: { agentPreset: 'custom' }, root: true },
    { header: {}, root: true },
  ])('reminds every agent independently of system eligibility: %j', async ({ header, root }) => {
    const f = await fixture();
    await f.load({ enabled: true, systemPromptSection: true }).inertia;
    const agent = f.agent(header, { root });
    await agent.created('resume');
    expect(await agent.guidance()).toEqual([]);
    expect((await agent.preStep()).messages).toHaveLength(1);
    expect((await agent.preStep(2)).messages).toHaveLength(0);
  });

  it('reminds preexisting live children without requiring an agent/created replay or preset allowlist', async () => {
    const f = await fixture();
    const child = f.agent({}, { root: false });
    await f.load({ enabled: true, presetIds: [] }).inertia;
    expect((await child.preStep()).messages).toHaveLength(1);
    expect((await child.preStep(2)).messages).toHaveLength(0);
  });

  it('does not repeat an inherited reminder for a child across plugin reloads', async () => {
    const f = await fixture();
    const events: Array<Record<string, unknown>> = [];
    const child = f.agent({ origin: 'subagent' }, { root: false, sessionEvents: events });
    const first = f.load({ enabled: true });
    await first.inertia;
    const reminder = (await child.preStep()).messages[0]!;
    events.push({ type: 'user/message', data: reminder });
    await first.dispose();
    await f.load({ enabled: true }).inertia;
    expect((await child.preStep()).messages).toHaveLength(0);
    const inherited = f.agent({ origin: 'subagent' }, { root: false, sessionEvents: events });
    expect((await inherited.preStep()).messages).toHaveLength(0);
  });

  it('re-delivers once after a compaction removes the reminder from the visible surface', async () => {
    const f = await fixture();
    const surface = fakeSurface();
    const agent = f.agent(undefined, { surface });
    await f.load({ enabled: true }).inertia;
    const first = (await agent.preStep()).messages;
    expect(first).toHaveLength(1);
    surface.append({ type: 'user/message', data: first[0] });
    expect((await agent.preStep(2)).messages).toHaveLength(0);
    // Compaction shadows the reminder: still in the raw log, no longer model-visible.
    surface.compact();
    const again = (await agent.preStep(3)).messages;
    expect(again).toHaveLength(1);
    expect(again[0]!.source.kind).toBe(plugin.CONTEXT_SOURCE_KIND);
    surface.append({ type: 'user/message', data: again[0] });
    // No further compaction: no repeat.
    expect((await agent.preStep(4)).messages).toHaveLength(0);
    expect((await agent.preStep(5)).messages).toHaveLength(0);
  });

  it('does not re-deliver when a compaction keeps the reminder visible', async () => {
    const f = await fixture();
    const surface = fakeSurface();
    const agent = f.agent(undefined, { surface });
    await f.load({ enabled: true }).inertia;
    surface.append({ type: 'user/message', data: { source: { kind: 'user' }, content: [] } });
    const reminder = (await agent.preStep()).messages[0]!;
    surface.append({ type: 'user/message', data: reminder });
    const reminderSeq = surface.log.length - 1;
    surface.compact(seq => seq === reminderSeq);
    expect((await agent.preStep(2)).messages).toHaveLength(0);
  });

  it('trusts the visible surface over the raw log for inherited reminders', async () => {
    const f = await fixture();
    const surface = fakeSurface();
    surface.append({ type: 'user/message', data: { source: { kind: plugin.CONTEXT_SOURCE_KIND }, content: [] } });
    surface.compact();
    const agent = f.agent(undefined, { surface });
    await f.load({ enabled: true }).inertia;
    expect((await agent.preStep()).messages).toHaveLength(1);
  });

  it('skips PTC agents by default and honors an explicit exclusion list', async () => {
    const f = await fixture();
    await f.load({ enabled: true }).inertia;
    const ptc = f.agent({ agentPreset: 'ptc' });
    const child = f.agent({ agentPreset: 'ptc', origin: 'subagent' }, { root: false });
    const none = f.agent({});
    expect((await ptc.preStep()).messages).toHaveLength(0);
    expect((await child.preStep()).messages).toHaveLength(0);
    expect((await none.preStep()).messages).toHaveLength(1);

    const custom = await fixture();
    await custom.load({ enabled: true, contextExcludePresetIds: ['minimal'] }).inertia;
    expect((await custom.agent({ agentPreset: 'ptc' }).preStep()).messages).toHaveLength(1);
    expect((await custom.agent({ agentPreset: 'minimal' }).preStep()).messages).toHaveLength(0);
  });

  it('reminds a session once it switches away from an excluded preset', async () => {
    const f = await fixture();
    await f.load({ enabled: true }).inertia;
    const header: Header = { agentPreset: 'ptc' };
    const agent = f.agent(header);
    expect((await agent.preStep()).messages).toHaveLength(0);
    header.agentPreset = 'standard';
    expect((await agent.preStep(2)).messages).toHaveLength(1);
    expect((await agent.preStep(3)).messages).toHaveLength(0);
  });

  it('injects nothing with both channels disabled', async () => {
    const f = await fixture();
    await f.load({ enabled: true, contextReminder: false, systemPromptSection: false }).inertia;
    const agent = f.agent();
    await agent.created();
    expect(renderPrompt(await agent.assemble())).toBe('');
    expect((await agent.preStep()).messages).toHaveLength(0);
  });

  it('systemPromptSection:false keeps the reminder but renders no system section', async () => {
    const f = await fixture();
    const agent = f.agent();
    await agent.created();
    await f.load({ enabled: true, systemPromptSection: false, contextReminder: true }).inertia;
    // Registered but empty: renders nothing in the system prompt.
    expect(renderPrompt(await agent.assemble())).toBe('');
    expect((await agent.preStep()).messages).toHaveLength(1);
  });

  it('skips the reminder when disabled or when the transcript already carries it', async () => {
    const disabled = await fixture();
    const off = disabled.agent();
    await off.created();
    await disabled.load({ enabled: true, systemPromptSection: true, contextReminder: false }).inertia;
    expect((await off.preStep()).messages).toHaveLength(0);

    const marked = await fixture();
    const existing = marked.agent({ agentPreset: 'standard' }, {
      sessionEvents: [{ type: 'user/message', data: { source: { kind: plugin.CONTEXT_SOURCE_KIND }, content: [{ type: 'text', text: 'x' }] } }],
    });
    await existing.created();
    await marked.load({ enabled: true, contextReminder: true }).inertia;
    expect((await existing.preStep()).messages).toHaveLength(0);

    // Ordinary user messages (even ones quoting the reminder text) must not suppress delivery.
    const legacy = await fixture();
    const old = legacy.agent({ agentPreset: 'standard' }, {
      sessionEvents: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: plugin.CONTEXT_REMINDER }] } }],
    });
    await old.created();
    await legacy.load({ enabled: true, contextReminder: true }).inertia;
    expect((await old.preStep()).messages).toHaveLength(1);
  });

  it('reload catch-up stays idempotent with agent/created and cleans up on unload', async () => {
    const f = await fixture();
    const existing = f.agent();
    await existing.created();
    const fiber = f.load({ enabled: true, systemPromptSection: true });
    await fiber.inertia;
    expect(await existing.guidance()).toEqual([expectedSection]);
    // A replayed agent/created after catch-up must not duplicate the section.
    await existing.created('resume');
    const assembled = await existing.assemble();
    expect(assembled.sections.filter((section) => section.name === plugin.SECTION_NAME)).toHaveLength(1);
    expect(await existing.guidance()).toEqual([expectedSection]);
    await fiber.dispose();
    expect(await existing.guidance()).toEqual([]);
  });

  it('unloading the plugin removes actual sections while agent scopes stay alive', async () => {
    const f = await fixture();
    const fiber = f.load({ enabled: true, systemPromptSection: true });
    await fiber.inertia;
    const agents = [f.agent(), f.agent()];
    for (const agent of agents) {
      agent.value.ctx.systemPrompt.section({ name: 'fixture:keep', order: 0, text: 'Still alive' });
      await agent.created();
      expect(await agent.guidance()).toEqual([expectedSection]);
    }
    await fiber.dispose();
    for (const agent of agents) {
      expect(await agent.guidance()).toEqual([]);
      expect(renderPrompt(await agent.assemble())).toBe('Still alive');
    }
    const later = f.agent();
    await later.created();
    expect(await later.guidance()).toEqual([]);
  });

  it('agent scope disposal removes its section without affecting another agent', async () => {
    const f = await fixture();
    const fiber = f.load({ enabled: true, systemPromptSection: true });
    await fiber.inertia;
    const first = f.agent();
    const second = f.agent();
    await first.created();
    await second.created();
    expect(await first.guidance()).toEqual([expectedSection]);
    await first.dispose();
    expect(await first.guidance()).toEqual([]);
    expect(await second.guidance()).toEqual([expectedSection]);
    await fiber.dispose();
    expect(await second.guidance()).toEqual([]);
  });

  it('keeps identical static prompt bytes across assemblies, agents and reloads', async () => {
    const f = await fixture();
    const config = { enabled: true, systemPromptSection: true, presetIds: ['standard'] };
    const fiber = f.load(config);
    await fiber.inertia;
    const first = f.agent();
    const second = f.agent();
    await first.created();
    await second.created('resume');
    const initial = renderPrompt(await first.assemble());
    expect(initial).toBe(plugin.PARALLEL_TOOLS_PROMPT);
    expect(renderPrompt(await first.assemble())).toBe(initial);
    expect(renderPrompt(await second.assemble())).toBe(initial);
    await fiber.dispose();
    await f.load(config).inertia;
    const reloaded = f.agent();
    await reloaded.created();
    expect(renderPrompt(await reloaded.assemble())).toBe(initial);
    expect(await reloaded.guidance()).toEqual([expectedSection]);
  });
});

describe('shared dependency-aware scheduling rule', () => {
  it('uses the same rule in both channels; the history-backed one states that it persists', () => {
    expect(plugin.PARALLEL_TOOLS_PROMPT).toBe(`Tool-call scheduling: ${plugin.BATCH_RULE}`);
    expect(plugin.CONTEXT_REMINDER).toBe(
      `Tool-call scheduling (applies to every remaining step of this session): ${plugin.BATCH_RULE}`,
    );
  });

  it('opens with a silent, per-call readiness test and a bar for lone calls', () => {
    expect(plugin.BATCH_RULE.startsWith(
      'Before each tool-using response, silently list every call whose arguments you already know and send them all together.',
    )).toBe(true);
    for (const requirement of [
      'could a pending result change whether I make it or what I pass? If not, include it now.',
      'A lone call is right only when every other next call depends on its result.',
    ]) expect(plugin.BATCH_RULE).toContain(requirement);
  });

  it('names the commonly missed batches, including one result unlocking several calls', () => {
    for (const requirement of [
      "a task's opening reads and searches",
      'every file or symbol one result points to (e.g. each frame of a stack trace)',
      'edits to different files once their content is known',
      'read-only checks like typecheck, lint and tests',
    ]) expect(plugin.BATCH_RULE).toContain(requirement);
  });

  it('grounds waiting in concurrent execution and keeps safety guardrails', () => {
    for (const requirement of [
      'Calls in one response may run concurrently and in any order, so wait when a result decides the next call, approval is needed, or calls touch the same state',
      'read before edit, edit before run, two edits to one file',
      'no unrelated commands chained into one shell call, no subagents for quick calls, no speculative calls',
      'While background work runs, do unrelated work; never poll or repeat running or finished calls.',
      'Never skip required plan, todo or approval steps.',
    ]) expect(plugin.BATCH_RULE).toContain(requirement);
  });
});

describe('skill distribution', () => {
  it('keeps the SKILL.md description identical to the shared rule and within spec limits', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../skills/batch-tool-calls/SKILL.md', import.meta.url), 'utf8');
    const description = /^description: "(.*)"$/m.exec(text)?.[1];
    expect(description).toBe(plugin.BATCH_RULE);
    expect(plugin.BATCH_RULE.length).toBeLessThanOrEqual(1024);
    expect(plugin.PARALLEL_TOOLS_PROMPT.startsWith('Tool-call scheduling: ')).toBe(true);
  });

  it('expands the test, batch/wait examples, anti-faking and background rules in the body', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../skills/batch-tool-calls/SKILL.md', import.meta.url), 'utf8');
    const body = text.split('\n---\n')[1]!;
    for (const requirement of [
      'could a pending result change whether I make this call, or what I pass to it?',
      'A response with a single call is right only when every other call you would make next depends on that call',
      'A stack trace names three files', 'read all of them together, not one per turn',
      "a search must find a path before you read it; don't guess the path",
      '`test → read failure → fix → retest` is a valid serial chain',
      "Don't chain unrelated commands into one shell call", '(`build && test`) is fine',
      "don't edit files the tests depend on", 'never repeat a call or delegation that is running or finished',
      'Required plan, todo and approval workflows still apply.',
    ]) expect(body).toContain(requirement);
  });
});
