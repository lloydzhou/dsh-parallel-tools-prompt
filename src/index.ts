import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { PARALLEL_TOOLS_PROMPT, SECTION_NAME, SECTION_ORDER } from './prompt.js';
import { installPromptDebug } from './debug.js';

export { BATCH_RULE, PARALLEL_TOOLS_PROMPT, SECTION_NAME, SECTION_ORDER } from './prompt.js';

export const name = 'parallel-tools-prompt';
export const inject = ['agents', 'systemPrompt', 'sessionProjections'];

/** Stable marker so a reload never injects the reminder twice into one session. */
export const CONTEXT_MARKER = '[parallel-tools:scheduling-v2]';
export const CONTEXT_REMINDER = `${CONTEXT_MARKER} Every response: before answering, check what else the current subgoal already has ready and issue ALL ready, independent tool calls together in this one response — same-tool calls on different targets, parallel reads, independent searches and checks. Each response is one model round trip; issuing ready work one call at a time spends one round trip per call. Hold a call only for real dependencies: its arguments need an earlier result, read-before-edit, shared-file or approval ordering. A single call is fine when nothing else is ready; never invent calls to fill a batch.`;


export const CONTEXT_SOURCE_KIND = 'parallel-tools-scheduling';

/** True when the session transcript already carries our sourced reminder. */
function hasReminder(agent: Agent): boolean {
  return agent.session.snapshotEvents().some(event =>
    event.type === 'user/message'
    && (event.data as { source?: { kind?: string } } | undefined)?.source?.kind === CONTEXT_SOURCE_KIND);
}

export const Config = z.object({
  debugEnabled: z.boolean().default(false).description('Capture normalized LLM system prompts locally, only with an explicit session and enable sentinel. Sensitive: disable after diagnosis.'),
  debugSessionId: z.string().default(''),
  debugOutputDir: z.string().default(''),
  debugMaxCalls: z.natural().min(1).max(10).default(3),
  enabled: z.boolean().default(false).description(
    'Enable static tool-call scheduling guidance. The bundle explicitly opts in; direct plugin use is disabled by default.',
  ),
  systemPromptSection: z.boolean().default(true).description(
    'Register the static scheduling guidance section in the system prompt (default true). Set false to rely on contextReminder alone.',
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
function attach(ctx: Context, agent: Agent, config: Config, presetIds: Set<string>, registrations: WeakMap<Agent, Registration>, active: Set<Registration>, reminderAgents: WeakSet<Agent>): void {
  if (registrations.has(agent)) return;
  const { header } = agent.session;
  // Durable child metadata survives resume; live ownership covers children
  // without that metadata. parentSession is fork lineage, NOT a parent Agent.
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return;
  if (!ctx.agents.roots().includes(agent)) return;
  const preset = ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
    ?? header.agentPreset;
  if (preset === undefined || !presetIds.has(preset)) return;

  // Conversation-level reminder: appended by the pre-step listener below once
  // this agent is eligible (agent.inject only accepts user-kind messages).
  if (config.contextReminder) reminderAgents.add(agent);

  const registration: Registration = {};
  // Returning the disposer is essential: ctx.effect does not implicitly adopt
  // arbitrary registrations executed inside its callback on another fiber.
  registration.release = agent.ctx.effect(() => {
    const disposeSection = config.systemPromptSection ? agent.ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: PARALLEL_TOOLS_PROMPT,
    }) : undefined;
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
  const reminderAgents = new WeakSet<Agent>();

  // Agent contexts are not children of this plugin's fiber. Explicitly give the
  // plugin ownership of their effect disposers as well as agent-local ownership.
  ctx.effect(() => async () => {
    for (const registration of [...active]) await registration.release?.();
    active.clear();
  });


  // Same channel the host's own context plugins (e.g. time-context) use: after
  // downstream listeners accept the step, append one sourced message to the
  // step's messages; the host persists it and renders it as a CONTEXT block.
  if (config.contextReminder) {
    const delivered = new WeakSet<Agent>();
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal.aborted) return decision;
      if (!reminderAgents.has(agent) || delivered.has(agent)) return decision;
      const present = hasReminder(agent) || decision.messages.some(m => (m.source?.kind as string | undefined) === CONTEXT_SOURCE_KIND);
      delivered.add(agent);
      if (present) return decision;
      return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: CONTEXT_REMINDER }],
          source: { kind: CONTEXT_SOURCE_KIND, form: 'notice', summary: 'Parallel tool-call scheduling reminder' } as unknown as MessageSource,
        })],
      };
    }, { prepend: true });
  }

  ctx.on('agent/created', ({ agent }): undefined => {
    attach(ctx, agent, config, presetIds, registrations, active, reminderAgents);
  });

  // A plugin reload disposes the previous instance's section registrations, and
  // the host does not replay `agent/created` for agents that stay alive. Attach
  // to currently live eligible roots so guidance survives reloads; the guard
  // keeps this idempotent for agents that were never affected.
  ctx.effect(() => {
    // Runs once at apply/reload time: re-attach to agents that survived the
    // previous instance's disposal. The no-op disposer satisfies the effect
    // contract; per-agent cleanup is owned by each registration instead.
    for (const agent of ctx.agents.roots()) attach(ctx, agent, config, presetIds, registrations, active, reminderAgents);
    return () => {};
  });
}
