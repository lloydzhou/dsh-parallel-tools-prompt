// The browser host supplies these modules at runtime (see scripts/build-client.mjs);
// only the surface this page uses is declared.
declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: Record<string, unknown>, key?: string): unknown;
  export function jsxs(type: unknown, props: Record<string, unknown>, key?: string): unknown;
}
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export const Switch: unknown;
}
