import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { PARALLEL_TOOLS_PROMPT, SECTION_NAME, SECTION_ORDER } from './prompt.js';
import { installPromptDebug } from './debug.js';

export { PARALLEL_TOOLS_PROMPT, SECTION_NAME, SECTION_ORDER } from './prompt.js';

export const name = 'parallel-tools-prompt';
export const inject = ['agents', 'systemPrompt', 'sessionProjections'];

/** Stable marker so a reload never injects the reminder twice into one session. */
export const CONTEXT_MARKER = '[parallel-tools:scheduling]';
export const CONTEXT_REMINDER = `${CONTEXT_MARKER} Every response: before answering, check what else the current subgoal already has ready and issue ALL ready, independent tool calls together in this one response — same-tool calls on different targets, parallel reads, independent searches and checks. Each response is one model round trip; issuing ready work one call at a time spends one round trip per call. Hold a call only for real dependencies: its arguments need an earlier result, read-before-edit, shared-file or approval ordering. A single call is fine when nothing else is ready; never invent calls to fill a batch.`;

export const Config = z.object({
  debugEnabled: z.boolean().default(false).description('Capture normalized LLM system prompts locally, only with an explicit session and enable sentinel. Sensitive: disable after diagnosis.'),
  debugSessionId: z.string().default(''),
  debugOutputDir: z.string().default(''),
  debugMaxCalls: z.natural().min(1).max(10).default(3),
  enabled: z.boolean().default(false).description(
    'Enable static tool-call scheduling guidance. The bundle explicitly opts in; direct plugin use is disabled by default.',
  ),
  contextReminder: z.boolean().default(false).description(
    'Additionally inject a one-time scheduling reminder as model-facing conversation context at the next step boundary. Persists in the session transcript; survives reloads without duplication.',
  ),
  presetIds: z.array(z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))
    .max(32).default(['standard']).description(
      'Exact preset IDs to target at agent creation. Root agents only; use native-tool presets, not PTC. An empty list disables all targets.',
    ),
});

export type Config = ReturnType<typeof Config>;

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
  // Durable child metadata survives resume; live ownership covers children
  // without that metadata. parentSession is fork lineage, NOT a parent Agent.
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return;
  if (!ctx.agents.roots().includes(agent)) return;
  const preset = ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
    ?? header.agentPreset;
  if (preset === undefined || !presetIds.has(preset)) return;

  // Conversation-level reminder: rides model-facing context at the nearest step
  // boundary and persists in the transcript, so it stays proximal to generation.
  // The transcript scan keeps reloads from stacking duplicate reminders.
  if (config.contextReminder) {
    try {
      const already = agent.session.snapshotEvents().some(event =>
        event.type === 'user/message' && JSON.stringify(event.data?.content ?? '').includes(CONTEXT_MARKER));
      if (!already) {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: CONTEXT_REMINDER }],
          source: { kind: 'user' },
        }));
      }
    } catch { /* reminder must never break attach */ }
  }

  const registration: Registration = {};
  // Returning the disposer is essential: ctx.effect does not implicitly adopt
  // arbitrary registrations executed inside its callback on another fiber.
  registration.release = agent.ctx.effect(() => {
    const disposeSection = agent.ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: PARALLEL_TOOLS_PROMPT,
    });
    return () => {
      try {
        return disposeSection();
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
    for (const agent of ctx.agents.roots()) attach(ctx, agent, config, presetIds, registrations, active);
    return () => {};
  });
}
