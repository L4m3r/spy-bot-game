import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';
const source = new URL('../web/', import.meta.url);
const output = new URL('../dist/miniapp/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('app.js', source))], outfile: fileURLToPath(new URL('app.js', output)),
  bundle: true, format: 'esm', target: 'es2022', define: { __SPY_PREVIEW__: 'false' }, minify: true, charset: 'utf8' });
// Both entry URLs use the same bundle; absolute paths also work at the origin root.
const html = (await readFile(new URL('index.html', source), 'utf8'))
  .replace('href="app.css"', 'href="/miniapp/app.css"')
  .replace('src="app.js"', 'src="/miniapp/app.js"');
await writeFile(new URL('index.html', output), html);
await writeFile(new URL('../index.html', output), html);
await copyFile(new URL('app.css', source), new URL('app.css', output));
// Remove the redirect from earlier builds: the origin root now serves HTML directly.
await rm(new URL('../_redirects', output), { force: true });
const securityHeaders = `
  Cache-Control: no-cache
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Content-Security-Policy: default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
`;
await writeFile(new URL('../_headers', output), ['/', '/miniapp/*'].map(path => path + securityHeaders).join(''));
// Demo controls and fixtures are never published with the Worker assets.
const bundle = await readFile(new URL('app.js', output), 'utf8');
if (bundle.includes('spy:add-player') || bundle.includes('Саша') || bundle.includes('spy:scenario')) throw new Error('Preview fixtures leaked into production bundle');
console.log('Mini App assets built in dist/miniapp');
