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
const stateResponse = (currentRoom, contextVersion = currentRoom?.membershipVersion ?? 0) => ({ contextVersion, user: player(1), botUsername: 'ExampleBot',
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

function client({ search = '', ready = true, initData = 'test-auth' } = {}) {
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
  const window = { ...eventTarget(), Telegram: { WebApp: { initData, themeParams: {}, onEvent() {} } } };
  const calls = [];
  const queued = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    __SPY_PREVIEW__: false, window, document, parent: window,
    location: { search, origin: 'https://example.test', href: 'https://example.test/miniapp/' },
    matchMedia: () => ({ matches: false, addEventListener() {} }), URL, URLSearchParams,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, scrollTo() {},
    prototypeInviteUrl, validInvite, roomFromInvite, setServerTime() {},
    actionRequest: (action, code, expectedRound, membershipVersion, contextVersion) => ({ action, code, expectedRound, membershipVersion, contextVersion }),
    api(path, body) {
      return new Promise((resolve, reject) => {
        const request = { path, body, resolve, reject };
        calls.push(request); queued.push(request);
      });
    },
  });
  vm.runInContext(executable + '\n' + `
    me = { id: 1, name: 'Player 1', tone: 0 };
    state.ready = ${JSON.stringify(ready)}; state.botUsername = 'ExampleBot';
    globalThis.ui = { state, go, goBack, applyRoom, render, refreshLive, liveDispatch, dispatch, startLive };
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
  (await c.request('action')).resolve({ room: room({ round: 0 }) });
  (await c.request('state')).resolve(stateResponse(room({ round: 0 }))); await creating;
  stale.reject(apiError(401)); await polling;
  assert.equal(c.state.ready, true); assert.equal(c.state.error, '');
  assert.equal(c.state.screen, 'lobby'); assert.equal(c.state.roomCode, codeA);
});

test('own room changes update an invitation CTA before its separate refresh fails', async () => {
  const c = client(); c.applyRoom(room({ code: codeB }));
  c.state.invitation = invitation(); c.go('invitation');
  assert.equal(c.node('main-action').textContent, 'Вернуться в свою комнату');
  const first = c.refreshLive();
  (await c.request('state')).resolve(stateResponse(null));
  const request = await c.request('invitation?code=' + codeA);
  // The own membership has already changed, even while invitation GET is pending.
  assert.equal(c.node('main-action').textContent, 'Присоединиться к игре');
  assert.equal(c.node('main-action').disabled, false);
  request.reject(apiError(503)); await first;
  const recovered = c.refreshLive();
  (await c.request('state')).resolve(stateResponse(null));
  (await c.request('invitation?code=' + codeA)).resolve({ invitation: invitation() });
  await recovered;
  assert.equal(c.state.screen, 'invitation');
  assert.equal(c.state.room, false);
  assert.equal(c.node('main-action').textContent, 'Присоединиться к игре');
  assert.equal(c.node('main-action').disabled, false);
});

for (const launch of ['query', 'Telegram start_param']) {
  test(`startup invitation 503 supports retry with the original ${launch}`, async () => {
    const c = client({ ready: false, search: launch === 'query' ? '?room=' + codeA : '',
      initData: launch === 'query' ? 'test-auth' : new URLSearchParams({ start_param: 'room_' + codeA }).toString() });
    const initial = c.startLive();
    (await c.request('state')).resolve(stateResponse(null));
    (await c.request('invitation?code=' + codeA)).reject(apiError(503, 'Temporary outage'));
    await initial;
    assert.equal(c.state.screen, 'unavailable'); assert.equal(c.state.ready, false);
    assert.equal(c.node('main-action').textContent, 'Попробовать снова');
    assert.equal(c.state.error, 'Temporary outage');
    const retry = c.dispatch('reload');
    (await c.request('state')).resolve(stateResponse(null));
    (await c.request('invitation?code=' + codeA)).resolve({ invitation: invitation() });
    await retry;
    assert.equal(c.state.screen, 'invitation'); assert.equal(c.state.ready, true);
    assert.equal(c.state.invitation.code, codeA); assert.equal(c.state.error, '');
  });
}

test('startup treats an invitation 404 as closed rather than a retryable outage', async () => {
  const c = client({ search: '?room=' + codeA, ready: false });
  const starting = c.startLive();
  (await c.request('state')).resolve(stateResponse(null));
  (await c.request('invitation?code=' + codeA)).reject(apiError(404, 'Room closed'));
  await starting;
  assert.equal(c.state.screen, 'closed'); assert.equal(c.state.ready, true);
  assert.equal(c.state.invitation, null);
  assert.equal(c.node('main-action').textContent, 'Создать новую игру');
});

test('Back preserves the mutation lock through both POST and authoritative state GET', async () => {
  const c = client(); c.go('join');
  const creating = c.dispatch('create');
  const post = await c.request('action');
  await c.dispatch('back'); assert.equal(c.state.screen, 'home');
  assert.equal(c.node('main-action').disabled, true);
  await c.dispatch('create'); await c.refreshLive({ force: true });
  assert.equal(c.calls.length, 1, 'Neither a second mutation nor polling may overtake the POST');
  post.resolve({ room: room({ round: 0 }) });
  const read = await c.request('state');
  assert.equal(c.state.room, false, 'A POST snapshot is not authoritative');
  await c.dispatch('create'); await c.refreshLive({ force: true });
  assert.equal(c.calls.length, 2, 'The lock must last through reconciliation');
  read.resolve(stateResponse(room({ round: 0 }))); await creating;
  assert.equal(c.state.roomCode, codeA); assert.equal(c.state.screen, 'home');
  await c.poll(room({ round: 0 }));
  assert.equal(c.calls.length, 3, 'Polling resumes once mutation reconciliation finishes');
});

test('a delayed POST after Back cannot restore a room replaced by another client', async () => {
  const c = client(); c.applyRoom(room({ round: 0 })); c.go('lobby');
  const dealing = c.dispatch('deal'); const post = await c.request('action');
  await c.dispatch('back');
  post.resolve({ room: room({ round: 1 }) });
  (await c.request('state')).resolve(stateResponse(room({ code: codeB, membershipVersion: 1002, round: 2 })));
  await dealing;
  assert.equal(c.state.roomCode, codeB); assert.equal(c.state.round, 2);
  assert.equal(c.state.membershipVersion, 1002); assert.equal(c.state.screen, 'home');
  assert.equal(c.state.error, '');
});

for (const replacement of [
  { name: 'room', overrides: { code: codeB, round: 2 } },
  { name: 'membership', overrides: { membershipVersion: 1002 } },
  { name: 'round', overrides: { round: 2 } },
]) {
  test(`a POST result cannot auto-navigate when reconciliation changed its ${replacement.name}`, async () => {
    const c = client(); c.applyRoom(room({ round: 0 })); c.go('lobby');
    const dealing = c.dispatch('deal');
    (await c.request('action')).resolve({ room: room({ round: 1 }) });
    const actual = room(replacement.overrides);
    (await c.request('state')).resolve(stateResponse(actual)); await dealing;
    assert.equal(c.state.roomCode, actual.code);
    assert.equal(c.state.membershipVersion, actual.membershipVersion);
    assert.equal(c.state.round, actual.round);
    assert.equal(c.state.screen, 'lobby');
  });
}

test('a matching successful deal navigates only after authoritative state arrives', async () => {
  const c = client(); c.applyRoom(room({ round: 0 })); c.go('lobby');
  const dealing = c.dispatch('deal');
  (await c.request('action')).resolve({ room: room() });
  const read = await c.request('state');
  assert.equal(c.state.screen, 'lobby'); assert.equal(c.state.round, 0);
  read.resolve(stateResponse(room())); await dealing;
  assert.equal(c.state.screen, 'round'); assert.equal(c.state.round, 1);
});

for (const navigated of [false, true]) {
  test(`POST timeout reconciles committed state${navigated ? ' and preserves newer navigation' : ''}`, async () => {
    const c = client(); c.go('join');
    const creating = c.dispatch('create'); const post = await c.request('action');
    if (navigated) await c.dispatch('back');
    post.reject(new Error('Request timed out'));
    const read = await c.request('state');
    assert.equal(c.state.room, false);
    read.resolve(stateResponse(room({ round: 0 }))); await creating;
    assert.equal(c.state.roomCode, codeA);
    assert.equal(c.state.screen, navigated ? 'home' : 'join');
    assert.equal(c.state.error, navigated ? '' : 'Request timed out');
    assert.equal(c.node('main-action').disabled, false, 'A timeout must release the lock after reconciliation');
  });
}

test('failed reconciliation preserves navigation and releases the mutation lock', async () => {
  const c = client(); c.go('join');
  const first = c.dispatch('create'); const post = await c.request('action');
  await c.dispatch('back'); post.resolve({ room: room({ round: 0 }) });
  (await c.request('state')).reject(apiError(503, 'Read failed')); await first;
  assert.equal(c.state.screen, 'home'); assert.equal(c.state.error, '');
  const retry = c.dispatch('create');
  (await c.request('action')).resolve({ room: room({ round: 0 }) });
  (await c.request('state')).resolve(stateResponse(room({ round: 0 }))); await retry;
  assert.equal(c.state.screen, 'lobby'); assert.equal(c.state.roomCode, codeA);
});

for (const action of ['create', 'join']) {
  test(`${action} captures the loaded entry context and reconciliation updates it`, async () => {
    const c = client({ ready: false, search: action === 'join' ? '?room=' + codeA : '' });
    const starting = c.startLive();
    (await c.request('state')).resolve(stateResponse(null, 900));
    if (action === 'join') (await c.request('invitation?code=' + codeA)).resolve({ invitation: invitation() });
    await starting;
    assert.equal(c.state.contextVersion, 900);
    const entering = c.dispatch(action === 'join' ? 'accept-invite' : 'create');
    const post = await c.request('action');
    assert.equal(post.body.action, action); assert.equal(post.body.contextVersion, 900);
    post.resolve({ room: room({ round: 0 }) });
    (await c.request('state')).resolve(stateResponse(room({ round: 0 })));
    await entering;
    assert.equal(post.body.contextVersion, 900, 'The already sent action keeps its original context');
    assert.equal(c.state.contextVersion, 1001);
    await c.poll(room({ code: codeB, membershipVersion: 1002, round: 0 }));
    assert.equal(c.state.contextVersion, 1002, 'Later polling also updates the entry context');
  });
}

test('a stale rejected join reconciles fresh context for the next create', async () => {
  const c = client({ ready: false, search: '?room=' + codeA });
  const starting = c.startLive();
  (await c.request('state')).resolve(stateResponse(null, 900));
  (await c.request('invitation?code=' + codeA)).resolve({ invitation: invitation() }); await starting;
  const joining = c.dispatch('accept-invite');
  const joinPost = await c.request('action');
  assert.equal(joinPost.body.contextVersion, 900);
  // A different client has joined and left since this entry snapshot was read.
  await c.dispatch('back');
  joinPost.reject(apiError(409, 'Previous entry context'));
  (await c.request('state')).resolve(stateResponse(null, 1002)); await joining;
  assert.equal(c.state.contextVersion, 1002); assert.equal(c.state.room, false);
  const creating = c.dispatch('create');
  const createPost = await c.request('action');
  assert.equal(createPost.body.action, 'create'); assert.equal(createPost.body.contextVersion, 1002);
  const actual = room({ code: codeB, membershipVersion: 1003, round: 0 });
  createPost.resolve({ room: actual });
  (await c.request('state')).resolve(stateResponse(actual)); await creating;
  assert.equal(c.state.contextVersion, 1003);
  assert.equal(c.state.roomCode, codeB); assert.equal(c.state.screen, 'lobby');
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
