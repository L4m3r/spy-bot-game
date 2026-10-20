import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

const bundle = await build({
  entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
  bundle: true, format: "esm", target: "es2022", platform: "browser",
  external: ["cloudflare:workers", "node:*"], write: false,
});
const SECRET = "test_secret_never_use_in_production";
const TTL = 24 * 60 * 60 * 1000;
// Test-only storage access. This subclass is appended to the in-memory test
// bundle and is never part of the deployed Worker or its HTTP routes.
const testHarness = `
export class TestRoom extends GameRoom {
  async dispatch(command) {
    const fault = command.action === 'create' && await this.ctx.storage.get('__testFailCreate');
    const closeFault = command.action === 'close' && await this.ctx.storage.get('__testFailClose');
    if (fault) await this.ctx.storage.delete('__testFailCreate');
    if (closeFault) await this.ctx.storage.delete('__testFailClose');
    if (fault === 'before') throw new Error('Test failure before create');
    if (closeFault === 'before') throw new Error('Test failure before close');
    const result = await super.dispatch(command);
    if (fault === 'after') throw new Error('Test failure after create');
    if (closeFault === 'after') throw new Error('Test failure after close');
    return result;
  }
  async fetch(request) {
    const { op, key, value } = await request.json();
    let result;
    if (op === 'get') result = await this.ctx.storage.get(key);
    if (op === 'put') await this.ctx.storage.put(key, value);
    if (op === 'getAlarm') result = await this.ctx.storage.getAlarm();
    if (op === 'setAlarm') await this.ctx.storage.setAlarm(value);
    return Response.json({ result });
  }
}
export class TestUserLimits extends UserLimits {
  async fetch(request) {
    const { op, key, value } = await request.json();
    let result;
    if (op === 'get') result = await this.ctx.storage.get(key);
    if (op === 'put') await this.ctx.storage.put(key, value);
    if (op === 'getAlarm') result = await this.ctx.storage.getAlarm();
    if (op === 'setAlarm') await this.ctx.storage.setAlarm(value);
    return Response.json({ result });
  }
}
`;

async function until(condition) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for background work");
}

async function fixture(t, { failGetMe = false, lobbyDelayMs = 0 } = {}) {
  const requests = [];
  const runtimeLogs = [];
  const failCards = new Set();
  let nextMessageId = 100;
  let updateId = 1000;
  const mf = new Miniflare({
    name: "spy-test",
    modules: true, script: bundle.outputFiles[0].text + testHarness,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    durableObjects: {
      ROOMS: { className: "TestRoom", useSQLite: true },
      USER_LIMITS: { className: "TestUserLimits", useSQLite: true },
    },
    bindings: { BOT_TOKEN: "999:test-only-token", WEBHOOK_SECRET: SECRET },
    handleStructuredLogs: log => { runtimeLogs.push(log); },
    outboundService: async request => {
      const method = new URL(request.url).pathname.split("/").at(-1);
      const data = JSON.parse(await request.text());
      requests.push({ method, ...data });
      const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (method === "getMe") {
        if (failGetMe) return respond({ ok: false, error_code: 401, description: `Unauthorized: 999:test-only-token ${SECRET}` }, 401);
        return respond({ ok: true, result: { id: 999, is_bot: true, first_name: "Шпион", username: "test_spy_bot" } });
      }
      if (method === "answerCallbackQuery") return respond({ ok: true, result: true });
      if (lobbyDelayMs && method === "sendMessage" && data.text.startsWith("🕵️ Комната")) {
        await new Promise(resolve => setTimeout(resolve, lobbyDelayMs));
      }
      if (method === "sendMessage" && data.text.startsWith("Раунд ") && failCards.has(data.chat_id)) {
        return respond({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, 403);
      }
      return respond({ ok: true, result: { message_id: data.message_id ?? ++nextMessageId, date: 1, chat: { id: data.chat_id, type: "private" }, text: data.text } });
    },
  });
  t.after(() => mf.dispose());
  const person = id => ({ id, is_bot: false, first_name: `Игрок ${id}` });
  async function post(update, secret = SECRET) {
    const response = await mf.dispatchFetch("https://bot.test/webhook", {
      method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify(update),
    });
    // Drain the local HTTP exchange, including error bodies, before eviction.
    return new Response(await response.text(), { status: response.status, headers: response.headers });
  }
  function message(id, text, customId) {
    return { update_id: customId ?? ++updateId, message: { message_id: ++nextMessageId, date: Math.floor(Date.now() / 1000), chat: { id, type: "private" }, from: person(id), text,
      entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : [] } };
  }
  function callback(id, data) {
    return { update_id: ++updateId, callback_query: { id: `callback-${updateId}`, from: person(id), chat_instance: "test", data,
      message: { message_id: 1, date: 1, chat: { id, type: "private" }, text: "Комната" } } };
  }
  async function send(update) { const response = await post(update); assert.equal(response.status, 200, await response.text()); }
  async function create() {
    const update = message(1, "/game");
    await send(update);
    const lobby = await until(() => requests.find(request => request.text?.includes("?start=room_")));
    const code = /room_([a-f0-9]{24})/.exec(lobby.text)[1];
    const storage = await objectStorage("ROOMS", code);
    return { code, storage, update, state: () => storage.get("room") };
  }
  async function objectStorage(binding, name) {
    const namespace = await mf.getDurableObjectNamespace(binding);
    const stub = namespace.get(namespace.idFromName(String(name)));
    async function storageOp(op, key, value) {
      const response = await stub.fetch("https://test-only-storage/", { method: "POST", body: JSON.stringify({ op, key, value }) });
      return (await response.json()).result;
    }
    return {
      get: key => storageOp("get", key),
      put: (key, value) => storageOp("put", key, value),
      getAlarm: () => storageOp("getAlarm"),
      setAlarm: value => storageOp("setAlarm", undefined, value),
    };
  }
  async function join(code, id) { await send(message(id, `/start room_${code}`)); }
  return { mf, requests, failCards, post, send, message, callback, create, join, runtimeLogs, objectStorage };
}

test("webhook rejects unauthorized and malformed updates; health requires no Telegram calls", async t => {
  const f = await fixture(t);
  assert.equal((await f.mf.dispatchFetch("https://bot.test/health")).status, 200);
  assert.equal((await f.post({ update_id: 1 }, "wrong")).status, 401);
  assert.equal((await f.post({ bad: true })).status, 400);
  assert.equal((await f.mf.dispatchFetch("https://bot.test/webhook")).status, 405);
  assert.equal((await f.mf.dispatchFetch("https://bot.test/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: "x".repeat(65_537),
  })).status, 413);
  assert.equal(f.requests.length, 0);
});

test("room creation and joins survive duplicate updates; only owner deals", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.send(room.update);
  await f.join(room.code, 2);
  await f.join(room.code, 2);
  await f.join(room.code, 3);
  assert.deepEqual((await room.state()).members.map(player => player.id), [1, 2, 3]);
  await f.send(f.callback(2, `deal:${room.code}:0`));
  assert.equal((await room.state()).round, undefined);
  assert(f.requests.some(request => request.text?.includes("только организатору")));
  const deal = f.callback(1, `deal:${room.code}:0`);
  await Promise.all([f.send(deal), f.send(deal)]);
  const state = await until(async () => {
    const state = await room.state();
    return state.round && Object.values(state.round.delivery).every(status => status === "sent") && state;
  });
  assert.equal(state.round.number, 1);
  const cards = f.requests.filter(request => request.method === "sendMessage" && request.text.startsWith("Раунд "));
  assert.equal(cards.length, 3);
  assert.equal(cards.filter(card => card.text.includes("Ты — шпион")).length, 1);
  assert.equal(cards.filter(card => card.text.includes(`Локация: ${state.round.location}`)).length, 2);
  assert(cards.every(card => card.protect_content === true));
  assert(state.expiresAt > Date.now() + TTL - 10_000);
});

test("late join waits for the next round; stale buttons cannot deal again", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2); await f.join(room.code, 3);
  await f.send(f.callback(1, `deal:${room.code}:0`));
  await until(async () => Object.values((await room.state()).round.delivery).every(value => value === "sent"));
  await f.join(room.code, 4);
  assert.deepEqual((await room.state()).round.playerIds, [1, 2, 3]);
  await f.send(f.callback(1, `deal:${room.code}:0`));
  assert.equal((await room.state()).round.number, 1);
  await f.send(f.callback(1, `confirm:${room.code}:1`));
  assert.equal((await room.state()).round.number, 1);
  assert(f.requests.some(request => request.text?.includes("Закончить текущий раунд")));
  await f.send(f.callback(1, `deal:${room.code}:1`));
  assert.equal((await room.state()).round.number, 2);
  assert.deepEqual((await room.state()).round.playerIds, [1, 2, 3, 4]);
});

test("failed cards are retried with the saved role, without a new deal", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2); await f.join(room.code, 3);
  f.failCards.add(2);
  await f.send(f.callback(1, `deal:${room.code}:0`));
  const before = await until(async () => {
    const state = await room.state();
    return state.round?.delivery[2] === "failed" && state;
  });
  const failedText = f.requests.find(request => request.chat_id === 2 && request.text?.startsWith("Раунд ")).text;
  await until(async () => !(await room.state()).jobs.some(job => job.kind === "card"));
  f.failCards.delete(2);
  await f.send(f.callback(1, `retry:${room.code}:1`));
  const after = await until(async () => {
    const state = await room.state();
    return state.round?.delivery[2] === "sent" && state;
  });
  assert.equal(after.round.number, 1);
  assert.equal(after.round.spyId, before.round.spyId);
  assert.equal(after.round.location, before.round.location);
  const attempts = f.requests.filter(request => request.chat_id === 2 && request.text?.startsWith("Раунд "));
  assert.equal(attempts.length, 2);
  assert(attempts.every(attempt => attempt.text === failedText));
});

test("close deletes storage and alarm; an old invitation cannot recreate the room", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2);
  await f.send(f.callback(2, `close:${room.code}`));
  assert(await room.state());
  await f.send(f.callback(1, `close:${room.code}`));
  assert.equal(await room.state(), undefined);
  assert.equal(await room.storage.getAlarm(), null);
  await f.join(room.code, 3);
  assert.equal(await room.state(), undefined);
  assert(f.requests.some(request => request.text?.includes("закрыта или устарела")));
});

test("a scheduled TTL alarm removes room data without an incoming user request", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await until(async () => (await room.state()).jobs.length === 0);
  const state = await room.state();
  state.expiresAt = Date.now() + 200;
  await room.storage.put("room", state);
  await room.storage.setAlarm(state.expiresAt);
  await until(async () => (await room.state()) === undefined);
  assert.equal(await room.storage.getAlarm(), null);
});

test("deadline is checked even if the cleanup alarm has not run yet", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await until(async () => (await room.state()).jobs.length === 0);
  const state = await room.state();
  state.expiresAt = Date.now() - 1;
  await room.storage.put("room", state);
  await room.storage.setAlarm(Date.now() + 60_000);
  await f.join(room.code, 2);
  assert.equal(await room.state(), undefined);
});

test("eviction preserves the saved deal and does not extend the room deadline", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2); await f.join(room.code, 3);
  await f.send(f.callback(1, `deal:${room.code}:0`));
  await until(async () => (await room.state()).jobs.length === 0);
  const before = await room.state();
  await f.mf.unsafeEvictDurableObject("spy-test", "TestRoom", { name: room.code });
  const after = await room.state();
  assert.deepEqual(after.round, before.round);
  assert.deepEqual(after.members, before.members);
  assert.equal(after.expiresAt, before.expiresAt);
  await f.send(f.callback(1, `refresh:${room.code}`));
  assert((await room.state()).expiresAt >= before.expiresAt);
});

test("too few players cannot start; departed members cannot control the room", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.send(f.callback(1, `deal:${room.code}:0`));
  assert.equal((await room.state()).round, undefined);
  await f.join(room.code, 2);
  await f.send(f.callback(2, `leave:${room.code}`));
  assert.deepEqual((await room.state()).members.map(player => player.id), [1]);
  await f.send(f.callback(2, `refresh:${room.code}`));
  assert(f.requests.some(request => request.text?.includes("Ты не в этой комнате")));
});

test("Telegram initialization failure is retryable and does not expose raw errors", async t => {
  const f = await fixture(t, { failGetMe: true });
  const response = await f.post(f.message(1, "/game"));
  assert.equal(response.status, 500);
  await until(() => f.runtimeLogs.length);
  const text = (await response.text()) + JSON.stringify(f.runtimeLogs);
  assert(!text.includes(SECRET));
  assert(!text.includes("999:test-only-token"));
  assert(!text.includes("Unauthorized:"));
});

test("a slow send and concurrent join do not arm a redundant short alarm", async t => {
  const f = await fixture(t, { lobbyDelayMs: 300 });
  const room = await f.create();
  // create() returns as soon as the mock observes the outgoing request, before
  // it responds. The old implementation scheduled another wake-up at +50ms.
  assert.equal(await room.storage.getAlarm(), null);
  await f.join(room.code, 2);
  assert.equal(await room.storage.getAlarm(), null);
  assert.equal((await room.state()).members.length, 2);
  await until(async () => {
    const state = await room.state();
    const alarm = await room.storage.getAlarm();
    return state.jobs.length === 0 && alarm !== null && alarm > Date.now() + TTL - 10_000;
  });
  assert(f.requests.some(request => request.method === "sendMessage" && request.chat_id === 2));
});

test("parallel /game and create buttons reuse one room; users have independent limits", async t => {
  const f = await fixture(t);
  const commands = [f.message(1, "/game"), f.message(1, "/game"), f.callback(1, "create")];
  await Promise.all(commands.map(update => f.send(update)));
  const storage = await f.objectStorage("USER_LIMITS", 1);
  const state = await storage.get("limits");
  assert.equal(state.creations.length, 1);
  assert.equal(state.active.pending, undefined);
  const links = f.requests.flatMap(request => [...(request.text ?? "").matchAll(/room_([a-f0-9]{24})/g)].map(match => match[1]));
  assert(links.length >= 2);
  assert(links.every(code => code === state.active.code));
  await f.send(f.message(2, "/game"));
  const other = await (await f.objectStorage("USER_LIMITS", 2)).get("limits");
  assert.equal(other.creations.length, 1);
  assert.notEqual(other.active.code, state.active.code);
  await f.join(other.active.code, 1);
  assert.equal((await storage.get("limits")).active.code, state.active.code);
  await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: "1" });
  await f.send(f.message(1, "/game"));
  assert.equal((await storage.get("limits")).active.code, state.active.code);
  assert.equal((await storage.get("limits")).creations.length, 1);
});

test("show room sends a new lobby once; subsequent updates edit the new message", async t => {
  const f = await fixture(t, { lobbyDelayMs: 150 });
  const room = await f.create();
  await f.send(f.message(1, "/game"));
  const prompt = f.requests.find(request => request.text?.startsWith("У тебя уже есть активная комната:"));
  assert.deepEqual(prompt.reply_markup.inline_keyboard[0][0], { text: "Показать комнату", callback_data: `show:${room.code}` });
  await until(async () => (await room.state()).jobs.length === 0);
  const oldMessageId = (await room.state()).lobbyMessages[1];
  const start = f.requests.length;
  const show = f.callback(1, `show:${room.code}`);
  await Promise.all([f.send(show), f.send(show)]);
  await until(async () => (await room.state()).jobs.length === 0);
  const deliveries = f.requests.slice(start).filter(request => request.chat_id === 1 && request.text?.startsWith("🕵️ Комната"));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].method, "sendMessage");
  const newMessageId = (await room.state()).lobbyMessages[1];
  assert.notEqual(newMessageId, oldMessageId);
  const afterShow = f.requests.length;
  await f.join(room.code, 2);
  await until(async () => (await room.state()).jobs.length === 0);
  const edits = f.requests.slice(afterShow).filter(request => request.chat_id === 1 && request.method === "editMessageText");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].message_id, newMessageId);
  assert(edits[0].text.includes("Игроки: 2/12"));
  // The button from a pre-deployment prompt also opens a new message.
  const legacy = f.callback(1, `refresh:${room.code}`);
  legacy.callback_query.message.text = prompt.text;
  await f.send(legacy);
  await until(async () => (await room.state()).jobs.length === 0);
  assert.notEqual((await room.state()).lobbyMessages[1], newMessageId);
  const limits = await (await f.objectStorage("USER_LIMITS", 1)).get("limits");
  assert.equal(limits.creations.length, 1);
  assert.equal(limits.active.code, room.code);
});

test("closed room cannot be resurrected by a retry; an old close cannot clear a new room", async t => {
  const f = await fixture(t);
  const room = await f.create();
  const limits = await f.objectStorage("USER_LIMITS", 1);
  const close = f.callback(1, `close:${room.code}`);
  await f.send(close);
  assert.equal((await limits.get("limits")).active, undefined);
  assert.equal((await limits.get("limits")).creations.length, 1);
  await f.send(room.update);
  assert.equal(await room.state(), undefined);
  assert.equal((await limits.get("limits")).active, undefined);
  await f.send(f.message(1, "/game"));
  const current = (await limits.get("limits")).active.code;
  assert.notEqual(current, room.code);
  await f.send(close);
  assert.equal((await limits.get("limits")).active.code, current);
  assert.equal((await limits.get("limits")).creations.length, 2);
});

test("10 creations per rolling hour; reopening is free and closing does not refund quota", async t => {
  const f = await fixture(t);
  const limits = await f.objectStorage("USER_LIMITS", 1);
  for (let index = 0; index < 10; index++) {
    await f.send(f.message(1, "/game"));
    const state = await limits.get("limits");
    assert.equal(state.creations.length, index + 1);
    if (index === 9) {
      await f.send(f.message(1, "/game"));
      assert.equal((await limits.get("limits")).active.code, state.active.code);
      assert.equal((await limits.get("limits")).creations.length, 10);
    }
    await f.send(f.callback(1, `close:${state.active.code}`));
  }
  await f.send(f.message(1, "/game"));
  assert.equal((await limits.get("limits")).active, undefined);
  assert(f.requests.some(request => request.text?.includes("максимум 10 новых комнат")));
  // Simulate a rolling boundary, independent of the wall-clock hour.
  const state = await limits.get("limits");
  state.creations[0] = Date.now() - 3_600_001;
  await limits.put("limits", state);
  await Promise.all([f.send(f.message(1, "/game")), f.send(f.message(1, "/game"))]);
  const after = await limits.get("limits");
  assert(after.active);
  assert.equal(after.creations.length, 10);
});

test("/game reconciles a room removed by its TTL alarm and preserves the hourly history", async t => {
  const f = await fixture(t);
  const room = await f.create();
  const limits = await f.objectStorage("USER_LIMITS", 1);
  await until(async () => (await room.state()).jobs.length === 0);
  const expired = await room.state();
  expired.expiresAt = Date.now() + 100;
  await room.storage.put("room", expired);
  await room.storage.setAlarm(expired.expiresAt);
  await until(async () => !await room.state());
  assert.equal((await limits.get("limits")).active.code, room.code);
  await f.send(f.message(1, "/game"));
  const after = await limits.get("limits");
  assert.notEqual(after.active.code, room.code);
  assert.equal(after.creations.length, 2);
  assert.equal(await room.state(), undefined);
});

test("UserLimits alarm follows the room's extended TTL without extending it itself", async t => {
  const f = await fixture(t);
  const room = await f.create();
  const limits = await f.objectStorage("USER_LIMITS", 1);
  await until(async () => (await room.state()).jobs.length === 0);
  const cachedExpiry = (await limits.get("limits")).active.expiresAt;
  await new Promise(resolve => setTimeout(resolve, 10));
  await f.join(room.code, 2);
  await until(async () => (await room.state()).jobs.length === 0);
  const before = await room.state();
  assert(before.expiresAt > cachedExpiry);
  await limits.setAlarm(Date.now() + 100);
  await until(async () => (await limits.getAlarm()) > Date.now() + TTL - 10_000);
  assert.equal((await room.state()).expiresAt, before.expiresAt);
  assert.equal((await limits.get("limits")).active.expiresAt, before.expiresAt);
  // At the eventual expiry, both the stale reference and user data are GC'd.
  before.expiresAt = Date.now() - 1;
  await room.storage.put("room", before);
  const state = await limits.get("limits");
  state.lastRequestAt = Date.now() - TTL - 1;
  state.creations = [Date.now() - TTL - 1];
  await limits.put("limits", state);
  await limits.setAlarm(Date.now() + 100);
  await until(async () => !await limits.get("limits"));
  assert.equal(await limits.getAlarm(), null);
  assert.equal(await room.state(), undefined);
});

for (const fault of ["before", "after"]) {
  test(`creation interrupted ${fault} GameRoom commit resumes after eviction without another quota slot`, async t => {
    const f = await fixture(t);
    const update = f.message(1, "/game");
    const code = createHmac("sha256", SECRET).update(`1:${update.update_id}`).digest("hex").slice(0, 24);
    const room = await f.objectStorage("ROOMS", code);
    const limits = await f.objectStorage("USER_LIMITS", 1);
    await room.put("__testFailCreate", fault);
    assert.equal((await f.post(update)).status, 500);
    const pending = await limits.get("limits");
    assert.equal(pending.active.code, code);
    assert.equal(pending.active.pending.updateId, update.update_id);
    assert.equal(pending.creations.length, 1);
    await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: "1" });
    await f.send(f.message(1, "/game"));
    const resumed = await limits.get("limits");
    assert.equal(resumed.active.code, code);
    assert.equal(resumed.active.pending, undefined);
    assert.equal(resumed.creations.length, 1);
    assert.equal((await room.get("room")).ownerId, 1);
  });
}

test("UserLimits can be evicted after a successful close", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.send(f.callback(1, `close:${room.code}`));
  await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: "1" });
  assert.equal((await (await f.objectStorage("USER_LIMITS", 1)).get("limits")).active, undefined);
});

test("close after an interrupted creation clears the reservation and prevents resurrection", async t => {
  const f = await fixture(t);
  const update = f.message(1, "/game");
  const code = createHmac("sha256", SECRET).update(`1:${update.update_id}`).digest("hex").slice(0, 24);
  const room = await f.objectStorage("ROOMS", code);
  const limits = await f.objectStorage("USER_LIMITS", 1);
  await room.put("__testFailCreate", "after");
  assert.equal((await f.post(update)).status, 500);
  await f.send(f.callback(1, `close:${code}`));
  await f.send(update);
  assert.equal(await room.get("room"), undefined);
  assert.equal((await limits.get("limits")).active, undefined);
  assert.equal((await limits.get("limits")).creations.length, 1);
});

test("an expired unresolved reservation is discarded without recreating its room", async t => {
  const f = await fixture(t);
  const update = f.message(1, "/game");
  const code = createHmac("sha256", SECRET).update(`1:${update.update_id}`).digest("hex").slice(0, 24);
  const room = await f.objectStorage("ROOMS", code);
  const limits = await f.objectStorage("USER_LIMITS", 1);
  await room.put("__testFailCreate", "before");
  assert.equal((await f.post(update)).status, 500);
  const state = await limits.get("limits");
  state.active.expiresAt = Date.now() - 1;
  await limits.put("limits", state);
  await f.send(f.message(1, "/game"));
  assert.equal(await room.get("room"), undefined);
  const current = await limits.get("limits");
  assert.notEqual(current.active.code, code);
  assert.equal(current.creations.length, 2);
});

for (const fault of ["before", "after"]) {
  test(`close interrupted ${fault} room deletion is recovered before any pending creation`, async t => {
    const f = await fixture(t);
    const update = f.message(1, "/game");
    const code = createHmac("sha256", SECRET).update(`1:${update.update_id}`).digest("hex").slice(0, 24);
    const room = await f.objectStorage("ROOMS", code);
    const limits = await f.objectStorage("USER_LIMITS", 1);
    await room.put("__testFailCreate", "after");
    assert.equal((await f.post(update)).status, 500);
    await room.put("__testFailClose", fault);
    assert.equal((await f.post(f.callback(1, `close:${code}`))).status, 500);
    assert((await limits.get("limits")).active.closing);
    await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: "1" });
    await f.send(update);
    assert.equal(await room.get("room"), undefined);
    assert.equal((await limits.get("limits")).active, undefined);
    await f.send(f.message(1, "/game"));
    const state = await limits.get("limits");
    assert.notEqual(state.active.code, code);
    assert.equal(state.creations.length, 2);
  });
}
