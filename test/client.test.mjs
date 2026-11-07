import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { prototypeInviteUrl, validInvite, roomFromInvite } from '../web/invites.js';

// Execute the production UI, replacing only imports, automatic startup and API
// transport. Each case owns its DOM, listeners, pending requests and timers.
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
assert.ok(source.endsWith('else void startLive();\n'), 'Update the harness if UI startup changes');
const executable = source.replace(/^import .*$/gm, '').replace(/else void startLive\(\);\n$/, '');
const codeA = 'a'.repeat(24);
const codeB = 'b'.repeat(24);
const link = code => `https://t.me/ExampleBot?start=room_${code}`;
const player = id => ({ id, name: `Player ${id}`, inRound: true });
const room = (overrides = {}) => ({ code: codeA, membershipVersion: 1001, ownerId: 1,
  round: 1, players: [player(1), player(2), player(3)], botDeliveryFailed: false, ...overrides });
const invitation = (code = codeA, overrides = {}) => ({ code, ownerName: 'Host', round: 0,
  players: [player(2)], full: false, ...overrides });
const stateResponse = currentRoom => ({ user: player(1), botUsername: 'ExampleBot',
  locations: ['School', 'Bank'], serverTime: Date.now(), room: currentRoom });
const apiError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    emit(name, event = {}) { for (const listener of listeners.get(name) ?? []) listener(event); },
  };
}

function client() {
  const permanent = new Map();
  const rendered = new Map();
  let document;
  function element(id = '') {
    const node = {
      ...eventTarget(), id, dataset: {}, value: '', hidden: false, disabled: false, textContent: '', className: '',
      classList: { add() {}, remove() {}, toggle() {} },
      style: { setProperty() {}, removeProperty() {} },
      toggleAttribute() {}, setAttribute() {},
      focus() { document.activeElement = node; },
      contains(other) { return node === other; },
      querySelector(selector) {
        if (selector === 'h1') return element();
        if (selector === '#role-title') return rendered.get('role-title') ?? null;
        if (selector === '[data-action="reveal"]' && node.innerHTML.includes('data-action="reveal"')) return element();
        return null;
      },
      querySelectorAll() { return []; },
    };
    let html = '';
    Object.defineProperty(node, 'innerHTML', {
      get: () => html,
      set(value) {
        html = value;
        if (id === 'view') rendered.clear();
        if (id === 'role-card') rendered.delete('role-title');
        for (const match of value.matchAll(/\bid="([^"]+)"/g)) rendered.set(match[1], element(match[1]));
      },
    });
    return node;
  }
  document = {
    ...eventTarget(), documentElement: element(), hidden: false, activeElement: null,
    hasFocus: () => !document.hidden,
    querySelector(selector) {
      if (selector.startsWith('#role-card ')) return rendered.get('role-card')?.querySelector(selector.slice(11)) ?? null;
      if (!/^#[\w-]+$/.test(selector)) return null;
      return permanent.get(selector.slice(1)) ?? rendered.get(selector.slice(1)) ?? null;
    },
    querySelectorAll() { return []; },
  };
  for (const id of ['view', 'back', 'action-bar', 'main-action', 'announcement',
    'confirmation', 'dialog-cancel', 'dialog-confirm']) permanent.set(id, element(id));
  const window = { ...eventTarget(), Telegram: { WebApp: { initData: 'test-auth', themeParams: {}, onEvent() {} } } };
  const calls = [];
  const queued = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    __SPY_PREVIEW__: false, window, document, parent: window,
    location: { search: '', origin: 'https://example.test', href: 'https://example.test/miniapp/' },
    matchMedia: () => ({ matches: false, addEventListener() {} }), URL, URLSearchParams,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, scrollTo() {},
    prototypeInviteUrl, validInvite, roomFromInvite, setServerTime() {},
    actionRequest: (action, code, expectedRound, membershipVersion) => ({ action, code, expectedRound, membershipVersion }),
    api(path, body) {
      return new Promise((resolve, reject) => {
        const request = { path, body, resolve, reject };
        calls.push(request); queued.push(request);
      });
    },
  });
  vm.runInContext(executable + '\n' + `
    me = { id: 1, name: 'Player 1', tone: 0 };
    state.ready = true; state.botUsername = 'ExampleBot';
    globalThis.ui = { state, go, goBack, applyRoom, render, refreshLive, liveDispatch };
  `, context, { filename: 'web/app.js' });
  const ui = context.ui;
  return {
    ...ui, document, window, calls,
    node: id => document.querySelector('#' + id),
    edit(value) {
      const input = document.querySelector('#invite-input');
      assert.ok(input, 'Join input must exist');
      input.value = value; input.emit('input');
    },
    async request(path) {
      await nextTurn();
      const request = queued.shift();
      assert.ok(request, `Expected API request ${path}`);
      assert.equal(request.path, path);
      return request;
    },
    async poll(currentRoom, options) {
      const operation = ui.refreshLive(options);
      (await this.request('state')).resolve(stateResponse(currentRoom));
      await operation;
    },
  };
}

test('latest invitation wins when A/B lookup responses arrive in reverse order', async () => {
  const c = client(); c.go('join');
  c.edit(link(codeA)); const first = c.liveDispatch('resolve-invite');
  const a = await c.request('invitation?code=' + codeA);
  c.edit(link(codeB)); const second = c.liveDispatch('resolve-invite');
  const b = await c.request('invitation?code=' + codeB);
  b.resolve({ invitation: invitation(codeB) }); await second;
  a.resolve({ invitation: invitation(codeA) }); await first;
  assert.equal(c.state.invitation.code, codeB);
  assert.equal(c.state.joinValue, link(codeB));
  assert.equal(c.state.screen, 'invitation');
});

for (const interruption of ['navigation', 'input edit']) {
  for (const outcome of ['response', 'error']) {
    test(`invitation ${outcome} is ignored after ${interruption}`, async () => {
      const c = client(); c.go('join'); c.edit(link(codeA));
      const operation = c.liveDispatch('resolve-invite');
      const request = await c.request('invitation?code=' + codeA);
      if (interruption === 'navigation') c.go('home');
      else c.edit(link(codeB));
      if (outcome === 'response') request.resolve({ invitation: invitation(codeA) });
      else request.reject(apiError(404, 'Old invitation is closed'));
      await operation;
      assert.equal(c.state.screen, interruption === 'navigation' ? 'home' : 'join');
      assert.equal(c.state.invitation, null);
      assert.equal(c.state.joinError, '');
      assert.equal(c.state.error, '');
      if (interruption === 'input edit') assert.equal(c.node('invite-input').value, link(codeB));
    });
  }
}

for (const outcome of ['response', 'error']) {
  test(`invitation ${outcome} is ignored after leaving and returning to the form`, async () => {
    const c = client(); c.go('join'); c.edit(link(codeA));
    const operation = c.liveDispatch('resolve-invite');
    const request = await c.request('invitation?code=' + codeA);
    c.go('rules'); c.goBack();
    assert.equal(c.state.screen, 'join');
    if (outcome === 'response') request.resolve({ invitation: invitation(codeA) });
    else request.reject(apiError(404, 'Old invitation is closed'));
    await operation;
    assert.equal(c.state.screen, 'join');
    assert.equal(c.state.invitation, null);
    assert.equal(c.state.joinError, '');
    assert.equal(c.state.error, '');
  });
}

for (const screen of ['locations', 'rules', 'join']) {
  test(`Back cannot restore a closed room from ${screen}`, async () => {
    const c = client(); c.applyRoom(room()); c.go('round'); c.go(screen);
    await c.poll(null);
    c.goBack();
    assert.equal(c.state.room, false);
    assert.equal(c.state.screen, 'home');
    assert.ok(!c.node('view').innerHTML.includes('Раунд 0'));
    assert.ok(!c.state.trail.some(value => ['round', 'lobby', 'invite'].includes(value)));
    c.go('round'); assert.equal(c.state.screen, 'home');
  });
}

for (const screen of ['round', 'locations']) {
  test(`switching rooms while on ${screen} cannot restore the old round`, async () => {
    const c = client(); c.applyRoom(room()); c.go('round');
    if (screen === 'locations') c.go('locations');
    await c.poll(room({ code: codeB, membershipVersion: 1002, round: 0,
      players: [player(1), player(2)].map(p => ({ ...p, inRound: false })) }));
    assert.equal(c.state.roomCode, codeB);
    assert.equal(c.state.round, 0);
    assert.ok(!c.state.trail.includes('round'));
    c.go('round'); assert.equal(c.state.screen, 'lobby');
    assert.ok(!c.node('view').innerHTML.includes('Раунд 0'));
    c.goBack(); assert.equal(c.state.screen, 'home');
  });
}

test('polling a full invitation enables joining when a seat becomes available', async () => {
  const c = client();
  c.state.invitation = invitation(codeA, { full: true, players: Array.from({ length: 12 }, (_, i) => player(i + 2)) });
  c.go('invitation'); assert.equal(c.node('main-action').disabled, true);
  const operation = c.refreshLive();
  (await c.request('state')).resolve(stateResponse(null));
  (await c.request('invitation?code=' + codeA)).resolve({ invitation: invitation(codeA, {
    players: Array.from({ length: 11 }, (_, i) => player(i + 2)),
  }) });
  await operation;
  assert.equal(c.state.invitation.players.length, 11);
  assert.equal(c.node('main-action').disabled, false);
  assert.equal(c.node('main-action').textContent, 'Присоединиться к игре');
});

test('a closed invitation becomes a closed screen and is removed from Back history', async () => {
  const c = client(); c.state.invitation = invitation(); c.go('invitation');
  const operation = c.refreshLive();
  (await c.request('state')).resolve(stateResponse(null));
  (await c.request('invitation?code=' + codeA)).reject(apiError(404, 'Room closed'));
  await operation;
  assert.equal(c.state.screen, 'closed');
  assert.equal(c.state.invitation, null);
  assert.ok(!c.state.trail.includes('invitation'));
  c.goBack(); assert.equal(c.state.screen, 'home');
});

test('an invitation refresh response cannot navigate back after leaving its screen', async () => {
  const c = client(); c.state.invitation = invitation(); c.go('invitation');
  const operation = c.refreshLive();
  (await c.request('state')).resolve(stateResponse(null));
  const request = await c.request('invitation?code=' + codeA);
  c.go('home'); request.reject(apiError(404, 'Room closed')); await operation;
  assert.equal(c.state.screen, 'home'); assert.equal(c.state.error, '');
});

for (const status of [401, 503]) {
  test(`superseded polling HTTP ${status} cannot overwrite newer successful state`, async () => {
    const c = client(); c.go('home');
    const oldOperation = c.refreshLive({ force: true });
    const oldRequest = await c.request('state');
    await c.poll(room());
    oldRequest.reject(apiError(status)); await oldOperation;
    assert.equal(c.state.ready, true);
    assert.equal(c.state.error, '');
    assert.equal(c.state.roomCode, codeA);
    assert.equal(c.state.screen, 'home');
  });
}

test('polling failure invalidated by a mutation cannot hide the successful result', async () => {
  const c = client(); c.go('home');
  const polling = c.refreshLive({ force: true });
  const stale = await c.request('state');
  const creating = c.liveDispatch('create');
  (await c.request('action')).resolve({ room: room({ round: 0 }) }); await creating;
  stale.reject(apiError(401)); await polling;
  assert.equal(c.state.ready, true); assert.equal(c.state.error, '');
  assert.equal(c.state.screen, 'lobby'); assert.equal(c.state.roomCode, codeA);
});

async function interruptCard(c, interruption) {
  if (interruption === 'navigation') c.go('locations');
  else if (interruption === 'blur') c.window.emit('blur');
  else if (interruption === 'visibility') { c.document.hidden = true; c.document.emit('visibilitychange'); }
  else await c.poll(room({ round: 2 }));
}
const privateCard = { round: 1, role: 'civilian', location: 'PRIVATE LOCATION' };
for (const interruption of ['navigation', 'blur', 'visibility', 'round change']) {
  for (const phase of ['in flight', 'revealed']) {
    test(`private card ${phase} is destroyed by ${interruption}`, async () => {
      const c = client(); c.applyRoom(room()); c.go('round');
      const revealing = c.liveDispatch('reveal');
      const request = await c.request(`card?code=${codeA}&round=1`);
      if (phase === 'revealed') {
        request.resolve({ card: privateCard }); await revealing;
        assert.equal(c.state.revealed, true);
        assert.ok(c.node('role-card').innerHTML.includes(privateCard.location));
      }
      await interruptCard(c, interruption);
      if (phase === 'in flight') { request.resolve({ card: privateCard }); await revealing; }
      assert.equal(c.state.privateCard, null);
      assert.equal(c.state.revealed, false);
      assert.ok(!c.node('role-card')?.innerHTML.includes(privateCard.location));
      assert.ok(!c.node('view').innerHTML.includes(privateCard.location));
    });
  }
}

for (const phase of ['in flight', 'revealed']) {
  test(`membership replacement in the same room and round destroys a card ${phase}`, async () => {
    const c = client(); c.applyRoom(room()); c.go('round');
    const revealing = c.liveDispatch('reveal');
    const request = await c.request(`card?code=${codeA}&round=1`);
    if (phase === 'revealed') { request.resolve({ card: privateCard }); await revealing; }
    await c.poll(room({ membershipVersion: 1002,
      players: [player(1), player(2), player(3)].map(p => ({ ...p, inRound: false })) }));
    if (phase === 'in flight') { request.resolve({ card: privateCard }); await revealing; }
    assert.equal(c.state.privateCard, null); assert.equal(c.state.revealed, false);
    assert.ok(!c.node('view').innerHTML.includes(privateCard.location));
  });
}
