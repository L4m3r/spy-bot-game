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
    const suffix = command.action[0].toUpperCase() + command.action.slice(1);
    const key = '__testFail' + suffix;
    const fault = await this.ctx.storage.get(key);
    if (fault && fault !== 'always') await this.ctx.storage.delete(key);
    await this.ctx.storage.put('__testLast' + suffix, command);
    if (fault === 'before' || fault === 'always') throw new Error('Test failure before ' + command.action);
    const result = await super.dispatch(command);
    if (fault === 'after') throw new Error('Test failure after ' + command.action);
    return result;
  }
  async membershipStatus(userId, membershipId) {
    const fault = await this.ctx.storage.get('__testFailStatus');
    if (fault && fault !== 'always') await this.ctx.storage.delete('__testFailStatus');
    if (fault) throw new Error('Test membership lookup failure');
    return super.membershipStatus(userId, membershipId);
  }
  async fetch(request) {
    const { op, key, value } = await request.json();
    let result;
    if (op === 'dispatch') result = await this.dispatch(value);
    if (op === 'get') result = await this.ctx.storage.get(key);
    if (op === 'put') await this.ctx.storage.put(key, value);
    if (op === 'getAlarm') result = await this.ctx.storage.getAlarm();
    if (op === 'setAlarm') await this.ctx.storage.setAlarm(value);
    return Response.json({ result });
  }
}
export class TestUserLimits extends UserLimits {
  async dispatch(command) {
    const result = await super.dispatch(command);
    if (await this.ctx.storage.get('__testFailAfterDispatch')) {
      await this.ctx.storage.delete('__testFailAfterDispatch');
      throw new Error('Test response lost after user commit');
    }
    return result;
  }
  async fetch(request) {
    const { op, key, value } = await request.json();
    let result;
    if (op === 'dispatch') result = await this.dispatch(value);
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
  const failLobbies = new Set();
  const deletedMessages = new Set();
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
      if (method === "sendMessage" && data.text.startsWith("🕵️ Комната") && failLobbies.has(data.chat_id)) {
        return respond({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, 403);
      }
      if (method === "editMessageText" && deletedMessages.has(data.message_id)) {
        return respond({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, 400);
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
      dispatch: command => storageOp("dispatch", undefined, command),
      get: key => storageOp("get", key),
      put: (key, value) => storageOp("put", key, value),
      getAlarm: () => storageOp("getAlarm"),
      setAlarm: value => storageOp("setAlarm", undefined, value),
    };
  }
  async function join(code, id) { await send(message(id, `/start room_${code}`)); }
  return { mf, requests, failCards, failLobbies, deletedMessages, post, send, message, callback, create, join, runtimeLogs, objectStorage };
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

test("close deletes room contents and retains only a temporary creation fence", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2);
  await f.send(f.callback(2, `close:${room.code}`));
  assert(await room.state());
  await f.send(f.callback(1, `close:${room.code}`));
  assert.equal(await room.state(), undefined);
  assert.equal(await room.storage.get("closedUntil"), (await room.storage.get("__testLastCreate")).validUntil);
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
  assert(links.length >= 1);
  assert(links.every(code => code === state.active.code));
  await f.send(f.message(2, "/game"));
  const other = await (await f.objectStorage("USER_LIMITS", 2)).get("limits");
  assert.equal(other.creations.length, 1);
  assert.notEqual(other.active.code, state.active.code);
  await f.join(other.active.code, 1);
  assert.equal((await storage.get("limits")).active.code, state.active.code);
  assert(!(await (await f.objectStorage("ROOMS", other.active.code)).get("room")).members.some(player => player.id === 1));
  await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: "1" });
  await f.send(f.message(1, "/game"));
  assert.equal((await storage.get("limits")).active.code, state.active.code);
  assert.equal((await storage.get("limits")).creations.length, 1);
});

test("show room sends a new lobby once; subsequent updates edit the new message", async t => {
  const f = await fixture(t, { lobbyDelayMs: 150 });
  const room = await f.create();
  await f.send(f.message(1, "/game"));
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
  legacy.callback_query.message.text = "У тебя уже есть активная комната:";
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
  state.active.pending.validUntil = Date.now() - 1;
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

test("/game restores a guest lobby after failed delivery or deletion without creating a room", async t => {
  const f = await fixture(t);
  const room = await f.create();
  f.failLobbies.add(2);
  await f.join(room.code, 2);
  await until(async () => (await room.state()).jobs.length === 0);
  const limits = await f.objectStorage("USER_LIMITS", 2);
  const before = await limits.get("limits");
  assert.equal(before.active.code, room.code);
  assert.equal(before.active.owner, false);
  assert.equal(before.creations.length, 0);
  assert.equal((await room.state()).lobbyMessages[2], undefined);
  f.failLobbies.delete(2);
  const start = f.requests.length;
  const recover = f.message(2, "/game");
  await Promise.all([f.send(recover), f.send(recover)]);
  await until(async () => (await room.state()).jobs.length === 0);
  const restored = f.requests.slice(start).filter(request => request.chat_id === 2 && request.method === "sendMessage" && request.text?.startsWith("🕵️ Комната"));
  assert.equal(restored.length, 1);
  f.deletedMessages.add((await room.state()).lobbyMessages[2]);
  await f.send(f.message(2, "/game"));
  await until(async () => (await room.state()).jobs.length === 0);
  assert(!f.deletedMessages.has((await room.state()).lobbyMessages[2]));
  assert.deepEqual((await limits.get("limits")).creations, []);
  assert.equal((await limits.get("limits")).active.membershipId, before.active.membershipId);
});

test("a guest cannot create or join another room until /leave; old retries cannot undo the new membership", async t => {
  const f = await fixture(t);
  const first = await f.create();
  await f.send(f.message(3, "/game"));
  const other = (await (await f.objectStorage("USER_LIMITS", 3)).get("limits")).active.code;
  const second = await f.objectStorage("ROOMS", other);
  const invite = f.message(2, `/start room_${first.code}`);
  await f.send(invite);
  await f.send(f.message(2, `/start room_${other}`));
  await f.send(f.message(2, "/game"));
  const limits = await f.objectStorage("USER_LIMITS", 2);
  assert.equal((await limits.get("limits")).active.code, first.code);
  assert.deepEqual((await second.get("room")).members.map(player => player.id), [3]);
  assert(f.requests.some(request => request.text?.includes("уже в другой комнате")));
  const leave = f.message(2, "/leave");
  await Promise.all([f.send(leave), f.send(leave)]);
  assert.equal((await limits.get("limits")).active, undefined);
  assert(!(await first.state()).members.some(player => player.id === 2));
  await f.join(other, 2);
  await f.send(invite);
  await f.send(leave);
  assert.equal((await limits.get("limits")).active.code, other);
  assert((await second.get("room")).members.some(player => player.id === 2));
  assert(!(await first.state()).members.some(player => player.id === 2));
  assert.equal((await limits.get("limits")).creations.length, 0);
});

test("a host /leave requires confirmation; an old confirmation cannot close a new room", async t => {
  const f = await fixture(t);
  const room = await f.create();
  const leave = f.message(1, "/leave");
  await f.send(leave);
  assert(await room.state());
  const prompt = f.requests.find(request => request.text?.includes("Чтобы выйти, нужно закрыть"));
  assert.equal(prompt.reply_markup.inline_keyboard[0][0].callback_data, `close:${room.code}`);
  await f.send(f.callback(1, `show:${room.code}`));
  assert(await room.state());
  await f.send(f.callback(1, `close:${room.code}`));
  assert.equal(await room.state(), undefined);
  await f.send(f.message(1, "/game"));
  const limits = await f.objectStorage("USER_LIMITS", 1);
  const current = (await limits.get("limits")).active.code;
  await f.send(f.callback(1, `close:${room.code}`));
  await f.send(leave);
  assert.equal((await limits.get("limits")).active.code, current);
  assert(await (await f.objectStorage("ROOMS", current)).get("room"));
});

test("simultaneous invitations and /game acquire only one room", async t => {
  const f = await fixture(t);
  const first = await f.create();
  await f.send(f.message(3, "/game"));
  const secondCode = (await (await f.objectStorage("USER_LIMITS", 3)).get("limits")).active.code;
  const second = await f.objectStorage("ROOMS", secondCode);
  await Promise.all([
    f.send(f.message(2, `/start room_${first.code}`)),
    f.send(f.message(2, `/start room_${secondCode}`)),
    f.send(f.message(2, "/game")),
  ]);
  const user = await (await f.objectStorage("USER_LIMITS", 2)).get("limits");
  const rooms = [await first.state(), await second.get("room")];
  if (![first.code, secondCode].includes(user.active.code)) {
    rooms.push(await (await f.objectStorage("ROOMS", user.active.code)).get("room"));
  }
  assert.equal(rooms.filter(room => room.members.some(player => player.id === 2)).length, 1);
  assert(rooms.find(room => room.code === user.active.code).members.some(player => player.id === 2));
});

for (const fault of ["before", "after"]) {
  test(`join interrupted ${fault} room commit survives eviction and blocks a second membership`, async t => {
    const f = await fixture(t);
    const room = await f.create();
    await room.storage.put("__testFailJoin", fault);
    const invite = f.message(2, `/start room_${room.code}`);
    assert.equal((await f.post(invite)).status, 500);
    const limits = await f.objectStorage("USER_LIMITS", 2);
    const pending = await limits.get("limits");
    assert.equal(pending.active.pending.action, "join");
    assert.equal(pending.creations.length, 0);
    await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: "2" });
    await f.send(f.message(2, "/game"));
    const recovered = await limits.get("limits");
    assert.equal(recovered.active.code, room.code);
    assert.equal(recovered.active.pending, undefined);
    assert.equal(recovered.active.membershipId, pending.active.membershipId);
    assert.equal(recovered.creations.length, 0);
    assert.equal((await room.state()).members.filter(player => player.id === 2).length, 1);
    await f.send(invite);
    assert.equal((await room.state()).members.filter(player => player.id === 2).length, 1);
  });

  test(`leave interrupted ${fault} room commit is recovered before a new room is created`, async t => {
    const f = await fixture(t);
    const room = await f.create();
    await f.join(room.code, 2);
    const originalJoin = await room.storage.get("__testLastJoin");
    await room.storage.put("__testFailLeave", fault);
    const leave = f.message(2, "/leave");
    assert.equal((await f.post(leave)).status, 500);
    const limits = await f.objectStorage("USER_LIMITS", 2);
    assert.equal((await limits.get("limits")).active.leaving.action, "leave");
    await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: "2" });
    await f.send(f.message(2, "/game"));
    assert.notEqual((await limits.get("limits")).active.code, room.code);
    assert(!(await room.state()).members.some(player => player.id === 2));
    assert((await room.storage.dispatch(originalJoin)).error);
    assert(!(await room.state()).members.some(player => player.id === 2));
    await f.send(leave);
    assert((await limits.get("limits")).active.owner);
  });
}

test("alarms finish interrupted entry and departure without another Telegram update", async t => {
  const f = await fixture(t);
  const room = await f.create();
  const limits = await f.objectStorage("USER_LIMITS", 2);
  await room.storage.put("__testFailJoin", "before");
  assert.equal((await f.post(f.message(2, `/start room_${room.code}`))).status, 500);
  await limits.setAlarm(Date.now() + 50);
  await until(async () => {
    const active = (await limits.get("limits")).active;
    return active && !active.pending;
  });
  assert((await room.state()).members.some(player => player.id === 2));
  await room.storage.put("__testFailLeave", "after");
  assert.equal((await f.post(f.message(2, "/leave"))).status, 500);
  await limits.setAlarm(Date.now() + 50);
  await until(async () => !(await limits.get("limits")).active);
  assert(!(await room.state()).members.some(player => player.id === 2));
});

test("a lookup outage retains membership and reservations; alarm retries are rescheduled", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2);
  const limits = await f.objectStorage("USER_LIMITS", 2);
  const before = await limits.get("limits");
  await room.storage.put("__testFailStatus", "always");
  assert.equal((await f.post(f.message(2, "/game"))).status, 500);
  assert.equal((await f.post(f.message(2, "/leave"))).status, 500);
  const retrying = await limits.get("limits");
  retrying.recoveryAttempts = 7;
  await limits.put("limits", retrying);
  await limits.setAlarm(Date.now() + 50);
  await until(async () => (await limits.get("limits")).recoveryAttempts > 7);
  assert((await limits.getAlarm()) > Date.now());
  assert.equal((await limits.get("limits")).active.membershipId, before.active.membershipId);
  assert.equal((await limits.get("limits")).creations.length, 0);
  await room.storage.put("__testFailStatus", false);
  await f.send(f.message(2, "/game"));
  assert.equal((await limits.get("limits")).active.code, room.code);
});

test("a full or expired room releases a rejected guest reservation", async t => {
  const f = await fixture(t);
  const room = await f.create();
  for (let id = 2; id <= 12; id++) await f.join(room.code, id);
  await f.join(room.code, 13);
  const limits = await f.objectStorage("USER_LIMITS", 13);
  assert.equal((await limits.get("limits")).active, undefined);
  assert(f.requests.some(request => request.text?.includes("Комната заполнена")));
  const rejected = await room.storage.get("__testLastJoin");
  await f.send(f.message(12, "/leave"));
  assert((await room.storage.dispatch(rejected)).error);
  assert(!(await room.state()).members.some(player => player.id === 13));
  await f.send(f.message(13, "/game"));
  assert((await limits.get("limits")).active.owner);
  await until(async () => (await room.state()).jobs.length === 0);
  const expired = await room.state();
  expired.expiresAt = Date.now() - 1;
  await room.storage.put("room", expired);
  await f.send(f.message(2, "/leave"));
  assert.equal((await (await f.objectStorage("USER_LIMITS", 2)).get("limits")).active, undefined);
  assert.equal(await room.state(), undefined);
});

test("guest /game recovers from room closure or TTL; old buttons cannot affect a new room", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2);
  await f.send(f.callback(1, `close:${room.code}`));
  const limits = await f.objectStorage("USER_LIMITS", 2);
  assert.equal((await limits.get("limits")).active.code, room.code);
  await f.send(f.message(2, "/game"));
  const current = (await limits.get("limits")).active.code;
  assert.notEqual(current, room.code);
  await f.send(f.callback(2, `leave:${room.code}`));
  assert.equal((await limits.get("limits")).active.code, current);
});

test("room departure fences outlive the bounded update cache and protect a later rejoin", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2);
  const join = await room.storage.get("__testLastJoin");
  await f.send(f.message(2, "/leave"));
  const leave = await room.storage.get("__testLastLeave");
  await until(async () => (await room.state()).jobs.length === 0);
  const state = await room.state();
  state.processed = [];
  await room.storage.put("room", state);
  await f.mf.unsafeEvictDurableObject("spy-test", "TestRoom", { name: room.code });
  assert((await room.storage.dispatch(join)).error);
  await f.join(room.code, 2);
  const currentId = (await room.state()).members.find(player => player.id === 2).membershipId;
  assert(currentId > join.membershipId);
  assert((await room.storage.dispatch(leave)).error);
  assert((await room.state()).members.some(player => player.id === 2 && player.membershipId === currentId));
});

test("a delayed creation cannot resurrect a closed room and its tombstone expires", async t => {
  const f = await fixture(t);
  const room = await f.create();
  const create = await room.storage.get("__testLastCreate");
  await f.send(f.callback(1, `close:${room.code}`));
  assert((await room.storage.dispatch(create)).error);
  assert.equal(await room.state(), undefined);
  await room.storage.put("closedUntil", Date.now() - 1);
  await room.storage.setAlarm(Date.now() + 50);
  await until(async () => !await room.storage.get("closedUntil"));
  assert.equal(await room.storage.getAlarm(), null);
  assert((await room.storage.dispatch({ ...create, validUntil: Date.now() - 1 })).error);
  assert.equal(await room.state(), undefined);
});

test("legacy rooms retire safely; old owner pointers preserve creation quota", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await until(async () => (await room.state()).jobs.length === 0);
  const legacy = await room.state();
  delete legacy.schemaVersion;
  delete legacy.membershipFences;
  legacy.members.push({ id: 2, name: "Legacy guest" });
  await room.storage.put("room", legacy);
  const limits = await f.objectStorage("USER_LIMITS", 1);
  const state = await limits.get("limits");
  delete state.active.membershipId;
  delete state.active.owner;
  await limits.put("limits", state);
  await f.send(f.message(1, "/game"));
  assert.equal(await room.state(), undefined);
  assert.notEqual((await limits.get("limits")).active.code, room.code);
  assert.equal((await limits.get("limits")).creations.length, 2);
  await f.join(room.code, 2);
  assert.equal((await (await f.objectStorage("USER_LIMITS", 2)).get("limits")).active, undefined);
});

for (const action of ["create", "join", "leave"]) {
  test(`${action} survives a lost response after UserLimits commit without repeating effects`, async t => {
    const f = await fixture(t);
    const room = action === "create" ? undefined : await f.create();
    if (action === "leave") await f.join(room.code, 2);
    const id = action === "create" ? 1 : 2;
    const limits = await f.objectStorage("USER_LIMITS", id);
    await limits.put("__testFailAfterDispatch", true);
    const update = f.message(id, action === "join" ? `/start room_${room.code}` : action === "leave" ? "/leave" : "/game");
    assert.equal((await f.post(update)).status, 500);
    const committed = await limits.get("limits");
    await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: String(id) });
    await f.send(update);
    assert.deepEqual(await limits.get("limits"), committed);
    if (action === "leave") {
      assert.equal(committed.active, undefined);
      assert(!(await room.state()).members.some(player => player.id === id));
    } else {
      const current = await (await f.objectStorage("ROOMS", committed.active.code)).get("room");
      assert.equal(current.members.filter(player => player.id === id).length, 1);
      assert.equal(committed.creations.length, action === "create" ? 1 : 0);
      await f.send(f.message(id, "/game"));
      assert.equal((await limits.get("limits")).active.code, committed.active.code);
    }
  });
}

test("an unresolved join blocks create and another invitation during an outage", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await room.storage.put("__testFailJoin", "always");
  const invite = f.message(2, `/start room_${room.code}`);
  assert.equal((await f.post(invite)).status, 500);
  const limits = await f.objectStorage("USER_LIMITS", 2);
  assert.equal((await f.post(f.message(2, "/game"))).status, 500);
  assert.equal((await f.post(f.message(2, `/start room_${"f".repeat(24)}`))).status, 500);
  const pending = await limits.get("limits");
  assert.equal(pending.active.pending.updateId, invite.update_id);
  assert.equal(pending.active.code, room.code);
  assert.equal(pending.creations.length, 0);
  await room.storage.put("__testFailJoin", false);
  await f.send(f.message(2, "/game"));
  assert.equal((await limits.get("limits")).active.pending, undefined);
  assert.equal((await room.state()).members.filter(player => player.id === 2).length, 1);
});

test("an expired pending deadline keeps a committed membership if the room is still alive", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await room.storage.put("__testFailJoin", "after");
  assert.equal((await f.post(f.message(2, `/start room_${room.code}`))).status, 500);
  const limits = await f.objectStorage("USER_LIMITS", 2);
  const state = await limits.get("limits");
  state.active.expiresAt = Date.now() - 1;
  state.active.pending.validUntil = Date.now() - 1;
  await limits.put("limits", state);
  await f.send(f.message(2, "/game"));
  assert.equal((await limits.get("limits")).active.code, room.code);
  assert.equal((await limits.get("limits")).active.pending, undefined);
  assert.equal((await limits.get("limits")).creations.length, 0);
});

test("an expired uncommitted join is released and its late RPC is rejected", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await room.storage.put("__testFailJoin", "before");
  assert.equal((await f.post(f.message(2, `/start room_${room.code}`))).status, 500);
  const limits = await f.objectStorage("USER_LIMITS", 2);
  const state = await limits.get("limits");
  state.active.pending.validUntil = Date.now() - 1;
  const expired = state.active.pending;
  await limits.put("limits", state);
  await f.send(f.message(2, "/game"));
  assert.notEqual((await limits.get("limits")).active.code, room.code);
  assert((await room.storage.dispatch(expired)).error);
  assert(!(await room.state()).members.some(player => player.id === 2));
});

test("leaving cancels pending cards; rejoining waits for the next round", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2); await f.join(room.code, 3);
  f.failCards.add(2);
  await f.send(f.callback(1, `deal:${room.code}:0`));
  await until(async () => (await room.state()).jobs.length === 0);
  const failed = f.requests.filter(request => request.chat_id === 2 && request.text?.startsWith("Раунд ")).length;
  await f.send(f.message(2, "/leave"));
  await f.join(room.code, 2);
  f.failCards.delete(2);
  await f.send(f.callback(1, `retry:${room.code}:1`));
  await until(async () => (await room.state()).jobs.length === 0);
  assert.equal(f.requests.filter(request => request.chat_id === 2 && request.text?.startsWith("Раунд ")).length, failed);
  assert(f.requests.some(request => request.chat_id === 2 && request.text?.includes("Игрок 2 — со следующего раунда")));
  await f.send(f.callback(1, `deal:${room.code}:1`));
  await until(async () => (await room.state()).jobs.length === 0);
  assert(f.requests.some(request => request.chat_id === 2 && request.text?.startsWith("Раунд 2")));
});

for (const fault of ["before", "after"]) {
  test(`/game interrupted ${fault} a restored lobby enqueue remains retryable`, async t => {
    const f = await fixture(t);
    const room = await f.create();
    await f.join(room.code, 2);
    await until(async () => (await room.state()).jobs.length === 0);
    await room.storage.put("__testFailShow", fault);
    const start = f.requests.length;
    const update = f.message(2, "/game");
    assert.equal((await f.post(update)).status, 500);
    await f.mf.unsafeEvictDurableObject("spy-test", "TestUserLimits", { name: "2" });
    await f.send(update);
    await until(async () => (await room.state()).jobs.length === 0);
    assert.equal(f.requests.slice(start).filter(request => request.chat_id === 2 && request.method === "sendMessage" && request.text?.startsWith("🕵️ Комната")).length, 1);
    const user = await (await f.objectStorage("USER_LIMITS", 2)).get("limits");
    assert.equal(user.active.code, room.code);
    assert.equal(user.creations.length, 0);
  });
}

test("a guest's cleanup alarm follows room activity and eventually releases the expired membership", async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.join(room.code, 2);
  const limits = await f.objectStorage("USER_LIMITS", 2);
  await until(async () => (await room.state()).jobs.length === 0);
  const before = await room.state();
  await limits.setAlarm(Date.now() + 50);
  await until(async () => (await limits.getAlarm()) > Date.now() + TTL - 10_000);
  assert.equal((await room.state()).expiresAt, before.expiresAt);
  assert.equal((await limits.get("limits")).active.code, room.code);
  before.expiresAt = Date.now() - 1;
  await room.storage.put("room", before);
  await limits.setAlarm(Date.now() + 50);
  await until(async () => !(await limits.get("limits")).active);
  assert.equal(await room.state(), undefined);
  await f.send(f.message(2, "/leave"));
  assert(f.requests.some(request => request.chat_id === 2 && request.text?.includes("нет активной комнаты")));
});

function signedMiniAppData(id, { authDate = Math.floor(Date.now() / 1000), firstName = `Игрок ${id}` } = {}) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id, first_name: firstName }) });
  const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('999:test-only-token').digest();
  params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return params.toString();
}
let appClock = 0;
function appAction(action, code, expectedRound) {
  appClock = Math.max(Date.now(), appClock + 1);
  return { action, code, expectedRound, requestId: `${appClock}:${crypto.randomUUID()}` };
}
async function miniApp(f, id, path, body, { initData = signedMiniAppData(id), origin = 'https://bot.test', method, raw } = {}) {
  const response = await f.mf.dispatchFetch('https://bot.test/api/miniapp/' + path, {
    method: method ?? (body || raw ? 'POST' : 'GET'), headers: { Authorization: 'tma ' + initData, Origin: origin, 'Content-Type': 'application/json' },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
function assertPublicRoom(room) {
  const text = JSON.stringify(room);
  for (const key of ['spyId', 'location', 'membershipId', 'membershipIds', 'jobs', 'delivery', 'text', 'role']) assert(!text.includes(`"${key}"`), key + ' leaked into public room');
}

test('Mini App authentication rejects tampering, stale dates, duplicate fields and cross-origin writes', async t => {
  const f = await fixture(t);
  assert.equal((await miniApp(f, 1, 'state', undefined, { initData: '' })).status, 401);
  const valid = signedMiniAppData(1);
  const tampered = new URLSearchParams(valid); tampered.set('user', JSON.stringify({ id: 2, first_name: 'Fake' }));
  assert.equal((await miniApp(f, 1, 'state', undefined, { initData: tampered.toString() })).status, 401);
  for (const authDate of [Math.floor(Date.now() / 1000) - 3601, Math.floor(Date.now() / 1000) + 60]) {
    assert.equal((await miniApp(f, 1, 'state', undefined, { initData: signedMiniAppData(1, { authDate }) })).status, 401);
  }
  assert.equal((await miniApp(f, 1, 'state', undefined, { initData: valid + '&auth_date=1' })).status, 401);
  assert.equal((await miniApp(f, 1, 'action', appAction('create'), { origin: 'https://evil.test' })).status, 403);
  assert.equal((await miniApp(f, 1, 'state', {}, { method: 'POST' })).status, 405);
  assert.equal((await miniApp(f, 1, 'action', undefined, { raw: 'x'.repeat(4097) })).status, 413);
  assert.equal(f.requests.length, 0);
  const empty = await miniApp(f, 1, 'state');
  assert.equal(empty.status, 200); assert.equal(empty.data.room, null); assert.equal(empty.data.user.id, 1);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
});

test('Mini App shares bot rooms, exposes only the callers card and preserves round idempotency', async t => {
  const f = await fixture(t);
  const create = appAction('create');
  const opened = await miniApp(f, 1, 'action', { ...create, actor: { id: 9999 }, userId: 9999 });
  assert.equal(opened.status, 200); const code = opened.data.room.code;
  assert.equal(opened.data.room.ownerId, 1); assertPublicRoom(opened.data.room);
  assert.equal((await miniApp(f, 2, 'invitation?code=' + code)).data.invitation.players.length, 1);
  assert.equal((await miniApp(f, 2, 'action', appAction('join', code))).status, 200);
  await f.join(code, 3);
  const deal = appAction('deal', code, 0);
  const dealt = await miniApp(f, 1, 'action', deal);
  assert.equal(dealt.status, 200); assert.equal(dealt.data.room.round, 1); assertPublicRoom(dealt.data.room);
  assert.equal((await miniApp(f, 1, 'action', deal)).data.room.round, 1);
  assert.equal((await miniApp(f, 2, 'action', appAction('deal', code, 1))).status, 409);
  const cards = [];
  for (const id of [1, 2, 3]) {
    const card = await miniApp(f, id, `card?code=${code}&round=1&userId=9999`);
    assert.equal(card.status, 200); cards.push(card.data.card);
  }
  assert.equal(cards.filter(card => card.role === 'spy').length, 1);
  assert.equal(cards.find(card => card.role === 'spy').location, undefined);
  assert.equal(new Set(cards.filter(card => card.role === 'civilian').map(card => card.location)).size, 1);
  assert.equal((await miniApp(f, 4, `card?code=${code}&round=1`)).status, 409);
  const storage = await f.objectStorage('ROOMS', code); const before = await storage.get('room');
  await miniApp(f, 1, 'state'); await miniApp(f, 1, `card?code=${code}&round=1`);
  assert.equal((await storage.get('room')).expiresAt, before.expiresAt);
  assert.equal((await miniApp(f, 2, 'action', appAction('leave', code))).status, 200);
  assert.equal((await miniApp(f, 2, `card?code=${code}&round=1`)).status, 409);
  await f.join(code, 2);
  assert.equal((await miniApp(f, 2, `card?code=${code}&round=1`)).status, 409);
  assert.equal((await miniApp(f, 1, 'action', appAction('deal', code, 1))).data.room.round, 2);
  assert.equal((await miniApp(f, 1, `card?code=${code}&round=1`)).status, 409);
  assert.equal((await miniApp(f, 2, `card?code=${code}&round=2`)).status, 200);
  assertPublicRoom((await miniApp(f, 1, 'state')).data.room);
});

test('Mini App card reads and new rounds do not wait for Telegram notifications', async t => {
  const f = await fixture(t);
  const room = await f.create(); await f.join(room.code, 2); await f.join(room.code, 3);
  f.failCards.add(2);
  assert.equal((await miniApp(f, 1, 'action', appAction('deal', room.code, 0))).status, 200);
  await until(async () => (await room.state()).round.delivery[2] === 'failed');
  assert.equal((await miniApp(f, 2, `card?code=${room.code}&round=1`)).status, 200);
  const state = await room.state();
  state.jobs.push({ id: 'card:1:2', kind: 'card', chatId: 2, roundNumber: 1, membershipId: state.round.membershipIds[2], text: 'Round 1', attempts: 1, version: ++state.jobSequence, nextAt: Date.now() + 60_000 });
  await room.storage.put('room', state);
  const next = await miniApp(f, 1, 'action', appAction('deal', room.code, 1));
  assert.equal(next.status, 200); assert.equal(next.data.room.round, 2);
  assert(!(await room.state()).jobs.some(job => job.kind === 'card' && job.roundNumber === 1));
});

test('Mini App cannot replace another membership and bot commands retain their own watermark', async t => {
  const f = await fixture(t);
  const host = await miniApp(f, 1, 'action', appAction('create')); const code = host.data.room.code;
  await miniApp(f, 2, 'action', appAction('join', code));
  const other = await miniApp(f, 3, 'action', appAction('create'));
  assert.equal((await miniApp(f, 2, 'action', appAction('join', other.data.room.code))).status, 409);
  assert.equal((await miniApp(f, 2, 'state')).data.room.code, code);
  assert.equal((await miniApp(f, 2, 'action', appAction('close', code))).status, 409);
  const old = await (await f.objectStorage('USER_LIMITS', 1)).get('limits');
  assert.equal((await miniApp(f, 1, 'action', appAction('close', code))).status, 200);
  await f.send(f.message(1, '/game'));
  const current = await (await f.objectStorage('USER_LIMITS', 1)).get('limits');
  assert(current.active); assert.notEqual(current.active.code, code); assert(current.active.membershipId > old.active.membershipId);
  assert.equal((await miniApp(f, 1, 'action', appAction('close', code))).status, 409);
  const expired = { ...appAction('close', current.active.code), requestId: `${Date.now() - 301_000}:${crypto.randomUUID()}` };
  assert.equal((await miniApp(f, 1, 'action', expired)).status, 409);
  assert.equal((await miniApp(f, 2, 'state')).data.room, null);
});

test('Mini App replays errors as errors and cannot manufacture a completed deal', async t => {
  const f = await fixture(t);
  const { data } = await miniApp(f, 1, 'action', appAction('create'));
  const code = data.room.code;
  const deal = appAction('deal', code, 0);
  const failed = await miniApp(f, 1, 'action', deal);
  const replayed = await miniApp(f, 1, 'action', deal);
  assert.equal(failed.status, 409); assert.equal(replayed.status, 409); assert.deepEqual(replayed.data, failed.data);
  const limits = await f.objectStorage('USER_LIMITS', 1);
  const state = await limits.get('limits'); delete state.lastMiniAppResult;
  await limits.put('limits', state);
  assert.equal((await miniApp(f, 1, 'action', deal)).status, 409);
  assert.equal((await miniApp(f, 1, 'state')).data.room.round, 0);
  assert.equal((await miniApp(f, 1, 'action', appAction('leave', code))).status, 409);
  assert.equal((await miniApp(f, 1, 'state')).data.room.code, code);
});
