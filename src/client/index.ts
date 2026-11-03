/**
 * Browser half: two switches on the bundle's detail page that choose where the
 * scheduling guidance is injected. The host plugin owns the `systemPromptSection`
 * and `contextReminder` fields (declared `.volatile()`), so writes apply live.
 */
import { jsx, jsxs } from 'react/jsx-runtime';
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';

/** Services this browser plugin needs (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms'];

/** Package name keys the bundle-config slot; the entry id is the settings namespace. */
const PACKAGE = 'dsh-parallel-tools-prompt';
const NAMESPACE = 'parallel-tools-prompt';
const LOCALE = 'settings.parallelToolsPrompt';

const en = {
  systemPrompt: 'Inject into system prompt',
  systemPromptHint: 'Static guidance section in the system prompt (default on). Applies to sessions that assemble their prompt after the change.',
  context: 'Inject as context message',
  contextHint: 'One-time CONTEXT message delivered at the next step, kept in the session history.',
  note: 'Both can be on together; with both off the plugin injects nothing.',
  unavailable: 'The plugin is not loaded or its settings are not served, so it cannot be configured right now.',
  readOnly: 'This deployment stores settings read-only.',
};
const zh = {
  systemPrompt: '注入到系统提示词',
  systemPromptHint: '在系统提示词中加入固定的调度指引（默认开启）。对修改之后重新组装提示词的会话生效。',
  context: '以 CONTEXT 消息注入',
  contextHint: '在下一步骤送达一条 CONTEXT 消息，并保留在会话历史中。',
  note: '两者可同时开启；都关闭时插件不注入任何内容。',
  unavailable: '插件未加载或其设置未提供，暂时无法配置。',
  readOnly: '本部署的设置为只读。',
};

interface FormView { status?: string; writable?: boolean; value?: Record<string, unknown> }
interface CardProps {
  t: (key: string) => string;
  view?: string;
  useConfig: <T>(select: (view: FormView) => T) => T;
  setField: (field: string, value: boolean) => void;
}

const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0' };
const hintStyle = { fontSize: 12, opacity: 0.7, marginTop: 2 };

function Row(props: { title: string; hint: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }): unknown {
  return jsxs('div', {
    style: rowStyle,
    children: [
      jsxs('div', { children: [jsx('div', { children: props.title }), jsx('div', { style: hintStyle, children: props.hint })] }),
      jsx(Switch, { checked: props.checked, label: props.title, disabled: props.disabled, onChange: props.onChange }),
    ],
  });
}

function Card(props: CardProps): unknown {
  const { t } = props;
  const form = props.useConfig(view => view);
  if (form.status !== 'ready') return jsx('div', { style: hintStyle, children: t('unavailable') });
  const values = form.value ?? {};
  const disabled = form.writable !== true;
  return jsxs('div', {
    children: [
      Row({
        title: t('systemPrompt'), hint: t('systemPromptHint'), disabled,
        checked: values['systemPromptSection'] !== false,
        onChange: checked => props.setField('systemPromptSection', checked),
      }),
      Row({
        title: t('context'), hint: t('contextHint'), disabled,
        checked: values['contextReminder'] === true,
        onChange: checked => props.setField('contextReminder', checked),
      }),
      jsx('div', { style: hintStyle, children: disabled ? t('readOnly') : t('note') }),
    ],
  });
}

interface BrowserContext {
  effect(fn: () => unknown): void;
  locale: { register(ns: string, dict: Record<string, Record<string, string>>): unknown };
  configForms: {
    get(ns: string): { set(field: string, value: unknown): Promise<boolean> };
    whileServed(ns: string[], fn: () => unknown): unknown;
  };
  slots: {
    inject(slot: string, fn: () => unknown): unknown;
    register(entry: Record<string, unknown>, component: unknown): unknown;
  };
}

/** Mount the switches while the host serves this plugin's settings namespace. */
export function apply(ctx: BrowserContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE, { en, zh }));
  const form = ctx.configForms.get(NAMESPACE);
  const face = () => ({
    hooks: { config: form },
    setField: (field: string, value: boolean) => { void form.set(field, value); },
  });
  ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE,
    locale: LOCALE,
    inject: face,
  }, Card))));
}
