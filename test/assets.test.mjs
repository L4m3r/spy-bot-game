import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Exercise the production assets router as well as the Worker. The bot-only
// fixture bypasses this layer and cannot catch a broken public entry URL.
await import('../scripts/build-miniapp.mjs');
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  bundle: true, format: 'esm', target: 'es2022', platform: 'browser',
  external: ['cloudflare:workers', 'node:*'], write: false });

test('public root opens the Mini App through the production assets router', async t => {
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    durableObjects: { ROOMS: { className: 'GameRoom', useSQLite: true }, USER_LIMITS: { className: 'UserLimits', useSQLite: true } },
    bindings: { BOT_TOKEN: '999:assets-test-not-a-real-token', WEBHOOK_SECRET: 'assets_test_secret' },
    assets: { directory: fileURLToPath(new URL('../' + config.assets.directory + '/', import.meta.url)),
      routerConfig: { has_user_worker: true, static_routing: { user_worker: config.assets.run_worker_first } } },
    outboundService() { throw new Error('Asset routing must not call Telegram'); },
  });
  t.after(() => mf.dispose());
  const origin = 'https://spy.example';
  let entryHtml;
  for (const path of ['/', '/miniapp/']) for (const query of ['', '?room=' + 'a'.repeat(24) + '&tgWebAppStartParam=room_test']) {
    const page = await mf.dispatchFetch(origin + path + query, { redirect: 'manual' });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('Location'), null, 'Entry URLs must not add a redirect request');
    assert.match(page.headers.get('Content-Type'), /text\/html/);
    assert.equal(page.headers.get('Cache-Control'), 'no-cache');
    assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(page.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self' https:\/\/telegram.org/);
    const html = await page.text();
    assert.match(html, /id="view"/);
    entryHtml ??= html;
    assert.equal(html, entryHtml, 'Both paths serve the same application');
    const resources = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
      .map(match => new URL(match[1], origin + path + query)).filter(url => url.origin === origin);
    assert.equal(resources.length, 2);
    for (const url of resources) {
      const file = await mf.dispatchFetch(url, { redirect: 'manual' });
      assert.equal(file.status, 200);
      assert.match(file.headers.get('Content-Type'), url.pathname.endsWith('.js') ? /javascript/ : /text\/css/);
    }
    const head = await mf.dispatchFetch(origin + path + query, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Location'), null);
    assert.equal(await head.text(), '');
  }
  assert.equal((await mf.dispatchFetch(origin + '/api/miniapp/state')).status, 401);
  assert.equal((await mf.dispatchFetch(origin + '/webhook', { method: 'POST' })).status, 401);
  assert.deepEqual(await (await mf.dispatchFetch(origin + '/health')).json(), { ok: true });
  assert.equal((await mf.dispatchFetch(origin + '/unrelated-page')).status, 404);
});
