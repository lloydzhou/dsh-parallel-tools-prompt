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

type Header = {
  agentPreset?: string;
  origin?: 'subagent';
  delegationDepth?: number;
  parentSession?: string;
};

/** Only the Agent/session facade and two public registry methods are fake.
 * Prompt registration, scoped assembly, event dispatch and effect ownership are real.
 */
async function fixture() {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  const roots: Agent[] = [];
  const projectedPresets = new Map<Agent['session'], string>();
  const rootsOf = vi.fn(() => [...roots]);
  const stateOf = vi.fn((session: Agent['session'], key: string) => {
    expect(key).toBe('agentPreset');
    return projectedPresets.get(session);
  });
  ctx.provide('agents', { roots: rootsOf });
  ctx.provide('sessionProjections', { stateOf });
  const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await promptFiber.inertia;
  // Like the real Agent host, the scope minter declares the services its
  // agent contexts may use; createScope inherits this public dependency API.
  const agentHost = ctx.plugin({ inject: ['systemPrompt'], apply() {} });
  await agentHost.inertia;

  function load(config: Partial<plugin.Config> = {}) {
    return ctx.plugin(plugin, config);
  }

  function agent(header: Header = { agentPreset: 'standard' }, options: { root?: boolean; projectedPreset?: string; sessionEvents?: Array<Record<string, unknown>> } = {}) {
    const key = {};
    const scope = createScope(agentHost.ctx, key);
    const inject = vi.fn();
    // Deliberately omit every private Agent/registry implementation detail.
    const value = {
      ctx: scope.ctx,
      session: { header, snapshotEvents: () => options.sessionEvents ?? [] },
      inject,
    } as unknown as Agent;
    if (options.root !== false) roots.push(value);
    if (options.projectedPreset !== undefined) projectedPresets.set(value.session, options.projectedPreset);
    return {
      value,
      scope: key,
      dispose: scope.dispose,
      inject,
      created: (source: 'startup' | 'resume' = 'startup') =>
        ctx.serial(scopeTarget(value, key), 'agent/created', { agent: value, source }),
      assemble: () => ctx.systemPrompt.assemble({ scope: key }),
      guidance: async () => (await ctx.systemPrompt.assemble({ scope: key })).sections
        .filter((section) => section.name === plugin.SECTION_NAME),
    };
  }
  return { ctx, rootsOf, stateOf, load, agent };
}

const expectedSection = {
  name: plugin.SECTION_NAME,
  text: plugin.PARALLEL_TOOLS_PROMPT,
  interpolate: false,
};

describe('parallel-tools prompt lifecycle with published Cordis services', () => {
  it.each([{}, { enabled: false }])('is independently disabled for config %j', async (config) => {
    const f = await fixture();
    const fiber = f.load(config);
    await fiber.inertia;
    expect(fiber.config.enabled).toBe(false);
    expect(fiber.config.debugEnabled).toBe(false);
    expect(fiber.config.debugSessionId).toBe('');
    expect(fiber.config.debugMaxCalls).toBe(3);
    const agent = f.agent();
    await agent.created();
    expect(await agent.guidance()).toEqual([]);
    expect(f.rootsOf).not.toHaveBeenCalled();
    expect(f.stateOf).not.toHaveBeenCalled();
    expect(renderPrompt(await f.ctx.systemPrompt.assemble())).toBe('');
  });

  it.each(['startup', 'resume'] as const)('includes a standard root on %s', async (source) => {
    const f = await fixture();
    await f.load({ enabled: true }).inertia;
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
    await f.load({ enabled: true }).inertia;
    const agent = f.agent({ agentPreset: 'standard', ...metadata });
    await agent.created('resume');
    expect(await agent.guidance()).toEqual([]);
  });

  it('excludes a live child without durable child metadata', async () => {
    const f = await fixture();
    await f.load({ enabled: true }).inertia;
    const parent = f.agent();
    await parent.created();
    const child = f.agent({ agentPreset: 'standard' }, { root: false });
    await child.created();
    expect(await parent.guidance()).toEqual([expectedSection]);
    expect(await child.guidance()).toEqual([]);
    expect(f.rootsOf).toHaveBeenCalled();
  });

  it('does not confuse fork lineage or zero delegation depth with live parent ownership', async () => {
    const f = await fixture();
    await f.load({ enabled: true }).inertia;
    const agent = f.agent({ agentPreset: 'standard', parentSession: 'seed-session', delegationDepth: 0 });
    await agent.created('resume');
    expect(await agent.guidance()).toEqual([expectedSection]);
  });

  it.each(['ptc', 'custom', 'Standard', 'standard-extra', undefined])('excludes nonmatching or absent preset %s', async (preset) => {
    const f = await fixture();
    await f.load({ enabled: true }).inertia;
    const agent = f.agent(preset === undefined ? {} : { agentPreset: preset });
    await agent.created();
    expect(await agent.guidance()).toEqual([]);
  });

  it('prefers projected preset state over the durable header', async () => {
    const f = await fixture();
    await f.load({ enabled: true }).inertia;
    const included = f.agent({ agentPreset: 'ptc' }, { projectedPreset: 'standard' });
    const excluded = f.agent({ agentPreset: 'standard' }, { projectedPreset: 'ptc' });
    await included.created('resume');
    await excluded.created('resume');
    expect(await included.guidance()).toEqual([expectedSection]);
    expect(await excluded.guidance()).toEqual([]);
    expect(f.stateOf).toHaveBeenCalledWith(included.value.session, 'agentPreset');
  });

  it('honors explicit preset IDs and an empty allowlist', async () => {
    const f = await fixture();
    const first = f.load({ enabled: true, presetIds: ['custom'] });
    await first.inertia;
    const custom = f.agent({ agentPreset: 'custom' });
    const standard = f.agent();
    await custom.created();
    await standard.created();
    expect(await custom.guidance()).toEqual([expectedSection]);
    expect(await standard.guidance()).toEqual([]);
    await first.dispose();
    await f.load({ enabled: true, presetIds: [] }).inertia;
    const untargeted = f.agent();
    await untargeted.created();
    expect(await untargeted.guidance()).toEqual([]);
  });

  it('registers only once when the same agent event is delivered twice', async () => {
    const f = await fixture();
    await f.load({ enabled: true }).inertia;
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
    await f.load({ enabled: true }).inertia;
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
    await f.load({ enabled: true }).inertia;
    expect(await eligible.guidance()).toEqual([expectedSection]);
    expect(await ineligible.guidance()).toEqual([]);
    expect(await child.guidance()).toEqual([]);
    const fresh = f.agent();
    await fresh.created();
    expect(await fresh.guidance()).toEqual([expectedSection]);
  });

  it('injects the conversation reminder once when contextReminder is enabled', async () => {
    const f = await fixture();
    const agent = f.agent();
    await agent.created();
    await f.load({ enabled: true, contextReminder: true }).inertia;
    expect(agent.inject).toHaveBeenCalledTimes(1);
    const message = agent.inject.mock.calls[0]?.[0] as { content: Array<{ type: string; text: string }>; source: { kind: string; form?: string } };
    // Must render as a CONTEXT block, never as a fake user bubble.
    expect(message.source.kind).toBe('runtime-context');
    expect(message.source.form).toBe('notice');
    expect(message.content[0]?.text).toContain(plugin.CONTEXT_MARKER);
    expect(message.content[0]?.text).toContain('independent tool calls together');
  });

  it('skips the reminder when disabled or when the session already carries the marker', async () => {
    const disabled = await fixture();
    const off = disabled.agent();
    await off.created();
    await disabled.load({ enabled: true }).inertia;
    expect(off.inject).not.toHaveBeenCalled();

    const marked = await fixture();
    const existing = marked.agent({ agentPreset: 'standard' }, {
      sessionEvents: [{ type: 'user/message', data: { content: [{ type: 'text', text: `${plugin.CONTEXT_MARKER} reminder body` }] } }],
    });
    await existing.created();
    await marked.load({ enabled: true, contextReminder: true }).inertia;
    expect(existing.inject).not.toHaveBeenCalled();

    // A compaction summary quoting the marker must not suppress injection.
    const quoted = await fixture();
    const summarised = quoted.agent({ agentPreset: 'standard' }, {
      sessionEvents: [{ type: 'user/message', data: { content: [{ type: 'text', text: `checkpoint summary mentions ${plugin.CONTEXT_MARKER} in passing` }] } }],
    });
    await summarised.created();
    await quoted.load({ enabled: true, contextReminder: true }).inertia;
    expect(summarised.inject).toHaveBeenCalledTimes(1);
  });

  it('reload catch-up stays idempotent with agent/created and cleans up on unload', async () => {
    const f = await fixture();
    const existing = f.agent();
    await existing.created();
    const fiber = f.load({ enabled: true });
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
    const fiber = f.load({ enabled: true });
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
    const fiber = f.load({ enabled: true });
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
    const config = { enabled: true, presetIds: ['standard'] };
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

describe('skill distribution', () => {
  it('keeps the SKILL.md description identical to the shared rule and within spec limits', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../skills/batch-tool-calls/SKILL.md', import.meta.url), 'utf8');
    const description = /^description: "(.*)"$/m.exec(text)?.[1];
    expect(description).toBe(plugin.BATCH_RULE);
    expect(plugin.BATCH_RULE.length).toBeLessThanOrEqual(1024);
    expect(plugin.PARALLEL_TOOLS_PROMPT.startsWith('Tool-call scheduling: ')).toBe(true);
  });
});
