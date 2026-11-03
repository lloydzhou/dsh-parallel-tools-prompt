// Bundle src/client into lib/client.js in the format the DSH browser module
// system loads: a CommonJS body wrapped in window.__ModuleLoader__.load, with the
// host-provided modules left as external require() calls.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const result = await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  legalComments: 'none',
});
const body = result.outputFiles[0].text.trimEnd().split('\n').map(line => (line === '' ? line : `\t\t${line}`)).join('\n');
const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`;
mkdirSync(join(root, 'lib'), { recursive: true });
writeFileSync(join(root, 'lib/client.js'), out);
console.log(`lib/client.js written (${out.length} bytes)`);
