import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prototypeInviteUrl, validInvite } from '../web/invites.js';

test('a copied prototype invitation is accepted from both root and nested hosting', () => {
  for (const base of ['http://127.0.0.1:8793/app.html?host=preview', 'https://example.test/prototype/miniapp/app.html?theme=dark']) {
    const invitation = prototypeInviteUrl(base);
    assert.equal(validInvite(invitation, base), true);
    assert.equal(new URL(invitation).pathname, new URL(base).pathname);
    assert.equal(new URL(invitation).searchParams.get('host'), null);
  }
});

test('only an actual room start parameter or the exact local preview route is accepted', () => {
  const base = 'http://127.0.0.1:8793/app.html';
  assert.equal(validInvite('https://t.me/ExampleBot?start=room_0123456789abcdef01234567', base), true);
  for (const invalid of ['', 'not a link', 'https://t.me/ExampleBot?start=room_123',
    'https://example.test/app.html?scenario=invitation', 'http://127.0.0.1:8793/other.html?scenario=invitation',
    'http://127.0.0.1:8793/app.html?scenario=invitation-extra', 'https://t.me/ExampleBot?start=room_0123456789abcdef01234567#extra',
    'https://someone@t.me/ExampleBot?start=room_0123456789abcdef01234567']) assert.equal(validInvite(invalid, base), false, invalid);
});

test('live invitations accept only the configured bot and an exact room parameter', async () => {
  const { roomFromInvite } = await import('../web/invites.js');
  const code = '0123456789abcdef01234567';
  assert.equal(roomFromInvite(`https://t.me/ExampleBot?start=room_${code}`, 'ExampleBot'), code);
  assert.equal(roomFromInvite(`https://t.me/examplebot?startapp=room_${code}`, 'ExampleBot'), code);
  for (const link of [`https://t.me/OtherBot?start=room_${code}`, `https://t.me.evil.test/ExampleBot?start=room_${code}`,
    `https://name@t.me/ExampleBot?start=room_${code}`, `https://t.me/ExampleBot?start=room_${code}suffix`,
    'http://127.0.0.1:8793/app.html?scenario=invitation']) assert.equal(roomFromInvite(link, 'ExampleBot'), null);
});
