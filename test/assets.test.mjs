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
  for (const query of ['', '?room=' + 'a'.repeat(24) + '&tgWebAppStartParam=room_test']) {
    const response = await mf.dispatchFetch(origin + '/' + query, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('Location'), origin).href, origin + '/miniapp/' + query);
    const page = await mf.dispatchFetch(new URL(response.headers.get('Location'), origin));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('Content-Type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /id="view"/);
    for (const asset of ['app.js', 'app.css']) {
      const file = await mf.dispatchFetch(new URL(asset, origin + '/miniapp/'));
      assert.equal(file.status, 200);
      assert.match(file.headers.get('Content-Type'), asset.endsWith('.js') ? /javascript/ : /text\/css/);
    }
  }
  assert.equal((await mf.dispatchFetch(origin + '/api/miniapp/state')).status, 401);
  assert.equal((await mf.dispatchFetch(origin + '/webhook', { method: 'POST' })).status, 401);
  assert.deepEqual(await (await mf.dispatchFetch(origin + '/health')).json(), { ok: true });
  assert.equal((await mf.dispatchFetch(origin + '/unrelated-page')).status, 404);
});
