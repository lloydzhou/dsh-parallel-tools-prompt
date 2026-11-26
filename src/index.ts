import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cordis';
import { CONTEXT_REMINDER, PARALLEL_TOOLS_PROMPT, SECTION_NAME, SECTION_ORDER } from './prompt.js';
import { installPromptDebug } from './debug.js';

export { BATCH_RULE, CONTEXT_REMINDER, PARALLEL_TOOLS_PROMPT, SECTION_NAME, SECTION_ORDER } from './prompt.js';

export const name = 'parallel-tools-prompt';
export const inject = ['agents', 'systemPrompt', 'agentPresets'];

/** Source kind of the reminder message; the host renders unknown context kinds as CONTEXT blocks. */
export const CONTEXT_SOURCE_KIND = 'parallel-tools-scheduling';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    [CONTEXT_SOURCE_KIND]: { kind: typeof CONTEXT_SOURCE_KIND; form: 'notice'; summary: string };
  }
}

type EventLike = { type?: string; data?: unknown } | undefined;
type SurfaceSession = {
  surface?: { readonly nodes: readonly number[]; readonly replaceGeneration: number };
  eventAt?: (seq: number) => EventLike;
  snapshotEvents: () => readonly EventLike[];
};

function isReminderEvent(event: EventLike): boolean {
  return event?.type === 'user/message'
    && (event.data as { source?: { kind?: string } } | undefined)?.source?.kind === CONTEXT_SOURCE_KIND;
}

/**
 * True when the reminder is still model-visible. Reads the session surface
 * (the projected history after compaction/pruning replacements), like the
 * host's own agent-instructions plugin; the raw event log would still contain
 * a reminder that compaction has already replaced with a summary. Hosts
 * without a surface fall back to the full log.
 */
function hasReminder(agent: Agent): boolean {
  const session = agent.session as unknown as SurfaceSession;
  const { surface, eventAt } = session;
  if (surface !== undefined && typeof eventAt === 'function') {
    const nodes = surface.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (isReminderEvent(eventAt.call(session, nodes[i]!))) return true;
    }
    return false;
  }
  return session.snapshotEvents().some(isReminderEvent);
}

/** Surface replacement counter; changes only on compaction/prune replacements. */
function surfaceGeneration(agent: Agent): number {
  return (agent.session as unknown as SurfaceSession).surface?.replaceGeneration ?? 0;
}

export const Config = z.object({
  debugEnabled: z.boolean().default(false).description('Capture normalized LLM system prompts locally, only with an explicit session and enable sentinel. Sensitive: disable after diagnosis.'),
  debugSessionId: z.string().default(''),
  debugOutputDir: z.string().default(''),
  debugMaxCalls: z.natural().min(1).max(10).default(3),
  enabled: z.boolean().default(false).description(
    'Enable static tool-call scheduling guidance. The bundle explicitly opts in; direct plugin use is disabled by default.',
  ),
  systemPromptSection: z.boolean().default(false).volatile().description(
    'Inject static scheduling guidance as a system-prompt section for eligible roots (default false). May be combined with contextReminder; with both off the plugin injects nothing.',
  ),
  contextReminder: z.boolean().default(true).volatile().description(
    'Inject a one-time scheduling reminder as a CONTEXT message for all agents, including subagents and all presets, at the next step boundary (default true). Persists in the session transcript; never duplicated across reloads. Independent of systemPromptSection and presetIds.',
  ),
  contextExcludePresetIds: z.array(z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))
    .max(32).default(['ptc']).description(
      'Exact preset IDs that never receive the CONTEXT reminder (default [ptc]: PTC exposes only run_code, whose root calls are exclusive; batching there belongs inside one program). Agents without a preset are always reminded.',
    ),
  presetIds: z.array(z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))
    .max(32).default(['standard']).description(
      'Exact preset IDs for the system-prompt channel only. Root agents only; use native-tool presets, not PTC. An empty list disables system-prompt targets, not context reminders.',
    ),
});

export type Config = ReturnType<typeof Config>;

/** Read a switch live: volatile fields are references whose value may change without a reload. */
function flag(value: boolean | Volatile<boolean>): boolean {
  return typeof value === 'boolean' ? value : value.get();
}

/**
 * Read the live agent registry across host generations. The registry API moved
 * from `roots()` (dsh-agent <= 0.2.3-alpha.1) to `list()` (since
 * 0.2.3-alpha.2); calling a removed method crashes the plugin with
 * "ctx.agents.roots is not a function or its return value is not iterable".
 * Probe both names and fail soft with an empty roster, so any future rename
 * degrades to "no guidance attached" instead of a hard plugin error.
 */
function liveAgents(ctx: Context): readonly Agent[] {
  const registry = ctx.agents as { list?: () => Agent[]; roots?: () => Agent[] };
  if (typeof registry.list === 'function') return registry.list();
  if (typeof registry.roots === 'function') return registry.roots();
  return [];
}

/**
 * Defensive projected-preset lookup: `presetForSession` shipped alongside the
 * registry rename in 0.2.3-alpha.2. On hosts where the service exists without
 * the method, fall back to the durable session header instead of throwing.
 */
function projectedPreset(ctx: Context, session: Agent['session']): string | null {
  const presets = ctx.agentPresets as { presetForSession?: (session: Agent['session']) => string | null };
  return typeof presets.presetForSession === 'function' ? presets.presetForSession(session) : null;
}

type Registration = { release?: () => void | Promise<void> };

/**
 * Attach or re-attach the guidance section to one already-eligible live agent.
 * Idempotent via the registration guard; shared by `agent/created` and
 * reload-time catch-up, so a plugin reload cannot silently drop guidance from
 * agents that survive it (the old instance's disposal removed its sections).
 */
function attach(ctx: Context, agent: Agent, config: Config, presetIds: Set<string>, registrations: WeakMap<Agent, Registration>, active: Set<Registration>): void {
  if (registrations.has(agent)) return;
  const { header } = agent.session;
  // Durable child metadata survives resume; every delegated child carries
  // origin/delegationDepth, so this also covers runtime ownership. parentSession
  // is fork lineage, NOT a parent Agent.
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return;
  // Live check only: the registry lookup still drops agents whose registration detached.
  if (!liveAgents(ctx).includes(agent)) return;
  const preset = projectedPreset(ctx, agent.session)
    ?? header.agentPreset;
  if (preset == null || !presetIds.has(preset)) return;

  const registration: Registration = {};
  // Returning the disposer is essential: ctx.effect does not implicitly adopt
  // arbitrary registrations executed inside its callback on another fiber.
  registration.release = agent.ctx.effect(() => {
    // Registered unconditionally; the text is resolved at assembly time, so the
    // switch applies the next time the host assembles a system prompt.
    const disposeSection = agent.ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: () => (flag(config.systemPromptSection) ? PARALLEL_TOOLS_PROMPT : ''),
    });
    return () => {
      try {
        return disposeSection?.();
      } finally {
        registrations.delete(agent);
        active.delete(registration);
      }
    };
  });
  registrations.set(agent, registration);
  active.add(registration);
}

/** Host-only: new/resumed agent lifecycles plus reload-time re-attachment. */
export function apply(ctx: Context, config: Config): void {
  if (config.debugEnabled) {
    installPromptDebug(ctx, { enabled: true, sessionId: config.debugSessionId,
      outputDir: config.debugOutputDir, maxCalls: config.debugMaxCalls });
  }
  if (!config.enabled) return;

  const presetIds = new Set(config.presetIds);
  const registrations = new WeakMap<Agent, Registration>();
  const active = new Set<Registration>();

  // Agent contexts are not children of this plugin's fiber. Explicitly give the
  // plugin ownership of their effect disposers as well as agent-local ownership.
  ctx.effect(() => async () => {
    for (const registration of [...active]) await registration.release?.();
    active.clear();
  });


  // Same channel the host's own context plugins (e.g. time-context) use: after
  // downstream listeners accept the step, append one sourced message to the
  // step's messages; the host persists it and renders it as a CONTEXT block.
  {
    // Per agent: the surface replacement generation at which the reminder was
    // last confirmed visible (or delivered). Unchanged generation means no
    // compaction since, so the reminder is still visible and nothing is
    // re-scanned. After a compaction the surface is checked once more and the
    // reminder is re-delivered only if the replacement removed it.
    const checked = new WeakMap<Agent, number>();
    const excluded = new Set(config.contextExcludePresetIds);
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal.aborted) return decision;
      if (!flag(config.contextReminder)) return decision;
      // Checked every step (cheap), before the generation cache, so a session
      // that later switches away from an excluded preset still gets reminded.
      if (excluded.size > 0) {
        const preset = projectedPreset(ctx, agent.session) ?? agent.session.header.agentPreset;
        if (preset != null && excluded.has(preset)) return decision;
      }
      const generation = surfaceGeneration(agent);
      if (checked.get(agent) === generation) return decision;
      checked.set(agent, generation);
      const present = hasReminder(agent) || decision.messages.some(m => m.source.kind === CONTEXT_SOURCE_KIND);
      if (present) return decision;
      return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: CONTEXT_REMINDER }],
          source: { kind: CONTEXT_SOURCE_KIND, form: 'notice', summary: 'Parallel tool-call scheduling reminder' },
        })],
      };
    }, { prepend: true });
  }

  ctx.on('agent/created', ({ agent }): undefined => {
    attach(ctx, agent, config, presetIds, registrations, active);
  });

  // A plugin reload disposes the previous instance's section registrations, and
  // the host does not replay `agent/created` for agents that stay alive. Attach
  // to currently live eligible roots so guidance survives reloads; the guard
  // keeps this idempotent for agents that were never affected.
  ctx.effect(() => {
    // Runs once at apply/reload time: re-attach to agents that survived the
    // previous instance's disposal. The no-op disposer satisfies the effect
    // contract; per-agent cleanup is owned by each registration instead.
    for (const agent of liveAgents(ctx)) attach(ctx, agent, config, presetIds, registrations, active);
    return () => {};
  });
}
