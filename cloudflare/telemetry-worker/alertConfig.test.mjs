import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAesKey,
  encryptConfig,
  decryptConfig,
  validateToken,
  validateChatId,
  botIdFromToken,
  buildSafeAlertText,
  buildTelegramRequest,
  mapTelegramError,
  readAlertConfig,
  writeAlertConfig,
  removeAlertConfig,
  testThrottled,
} from './alertConfig.mjs';

/** In-memory store standing in for the D1-backed single-row config. */
function memStore(initial = null) {
  let row = initial;
  return {
    async get() { return row; },
    async put(r) { row = r; },
    async del() { row = null; },
    _row: () => row,
  };
}

const SECRET = 'test-alert-config-key-0123456789abcdef';
const AAD = { id: 'telegram', keyVersion: 1 };
const PLAIN = { token: '123456789:AAHabcdefghijklmnopqrstuvwxyz012345', chat_id: '-1001234567890' };

test('encrypt → decrypt round-trips token and chat_id', async () => {
  const key = await deriveAesKey(SECRET);
  const { cipher, iv } = await encryptConfig(key, PLAIN, AAD);
  assert.ok(cipher && iv, 'returns base64 cipher + iv');
  assert.doesNotMatch(cipher, /AAHabcdefg/, 'ciphertext does not contain the plaintext token');
  const out = await decryptConfig(key, cipher, iv, AAD);
  assert.deepEqual(out, PLAIN);
});

test('each encryption uses a fresh IV', async () => {
  const key = await deriveAesKey(SECRET);
  const a = await encryptConfig(key, PLAIN, AAD);
  const b = await encryptConfig(key, PLAIN, AAD);
  assert.notEqual(a.iv, b.iv, 'IV must not repeat across writes');
});

test('tampered ciphertext fails to decrypt', async () => {
  const key = await deriveAesKey(SECRET);
  const { cipher, iv } = await encryptConfig(key, PLAIN, AAD);
  const flipped = cipher.slice(0, -2) + (cipher.endsWith('A') ? 'B' : 'A') + cipher.slice(-1);
  await assert.rejects(() => decryptConfig(key, flipped, iv, AAD));
});

test('tampered IV fails to decrypt', async () => {
  const key = await deriveAesKey(SECRET);
  const { cipher, iv } = await encryptConfig(key, PLAIN, AAD);
  // Mutate a decoded byte rather than a trailing base64 character: the latter
  // can alter padding bits only and occasionally decode to the original IV.
  const badIvBytes = Buffer.from(iv, 'base64');
  badIvBytes[0] ^= 0x01;
  const badIv = badIvBytes.toString('base64');
  await assert.rejects(() => decryptConfig(key, cipher, badIv, AAD));
});

test('wrong AAD (swapped id/keyVersion) fails to decrypt', async () => {
  const key = await deriveAesKey(SECRET);
  const { cipher, iv } = await encryptConfig(key, PLAIN, AAD);
  await assert.rejects(() => decryptConfig(key, cipher, iv, { id: 'telegram', keyVersion: 2 }));
  await assert.rejects(() => decryptConfig(key, cipher, iv, { id: 'evil', keyVersion: 1 }));
});

test('wrong key fails to decrypt', async () => {
  const key = await deriveAesKey(SECRET);
  const other = await deriveAesKey('a-different-secret-value-abcdef0123456789');
  const { cipher, iv } = await encryptConfig(key, PLAIN, AAD);
  await assert.rejects(() => decryptConfig(other, cipher, iv, AAD));
});

test('validateToken accepts valid bot tokens, rejects junk and overlong', () => {
  assert.equal(validateToken('123456789:AAHabcdefghijklmnopqrstuvwxyz012345'), true);
  assert.equal(validateToken('not-a-token'), false);
  assert.equal(validateToken('123:short'), false);
  assert.equal(validateToken(''), false);
  assert.equal(validateToken('1'.repeat(300)), false, 'over length cap rejected');
});

test('validateChatId accepts numeric and @username, rejects junk', () => {
  assert.equal(validateChatId('-1001234567890'), true);
  assert.equal(validateChatId('123456'), true);
  assert.equal(validateChatId('@my_channel'), true);
  assert.equal(validateChatId('@a'), false, 'too short username');
  assert.equal(validateChatId('drop table'), false);
  assert.equal(validateChatId('@' + 'a'.repeat(100)), false, 'over length cap rejected');
});

test('botIdFromToken returns the non-secret numeric prefix', () => {
  assert.equal(botIdFromToken('123456789:AAHsecretpart'), '123456789');
  assert.equal(botIdFromToken('garbage'), '');
});

test('buildSafeAlertText excludes raw error-message samples', () => {
  const alerts = [
    { severity: 'warning', title: '多实例错误: timeout', alert_key: 'widespread:abc123',
      detail: '近 24h 5 实例 / 12 次 · LEAKED_SECRET sk-shouldnotappear key-xyz' },
    { severity: 'critical', title: '功能瘫痪: teaching_summary', alert_key: 'feature_outage:teaching_summary',
      detail: '近 7 天 8 次尝试、0 次成功' },
  ];
  const text = buildSafeAlertText(alerts);
  assert.match(text, /多实例错误: timeout/, 'includes title');
  assert.match(text, /功能瘫痪: teaching_summary/, 'includes title');
  assert.doesNotMatch(text, /LEAKED_SECRET/, 'must not include raw detail sample');
  assert.doesNotMatch(text, /sk-shouldnotappear/, 'must not include secret-looking sample');
});

test('buildTelegramRequest hardcodes host, plain text, no link preview', () => {
  const { url, body } = buildTelegramRequest(PLAIN.token, PLAIN.chat_id, 'hello');
  assert.ok(url.startsWith('https://api.telegram.org/bot'), 'host hardcoded to api.telegram.org');
  assert.ok(url.endsWith('/sendMessage'));
  assert.equal(body.chat_id, PLAIN.chat_id);
  assert.equal(body.text, 'hello');
  assert.equal(body.disable_web_page_preview, true);
  assert.equal('parse_mode' in body, false, 'no parse_mode → plain text');
});

test('mapTelegramError maps Telegram HTTP statuses to safe codes', () => {
  assert.equal(mapTelegramError(401), 'invalid_token');
  assert.equal(mapTelegramError(404), 'invalid_token');
  assert.equal(mapTelegramError(400), 'chat_not_found');
  assert.equal(mapTelegramError(403), 'forbidden');
  assert.equal(mapTelegramError(500), 'upstream_failure');
  assert.equal(mapTelegramError(200), null);
});

test('writeAlertConfig stores encrypted; readAlertConfig never returns the token', async () => {
  const key = await deriveAesKey(SECRET);
  const store = memStore();
  const res = await writeAlertConfig(store, key, { enabled: true, chat_id: '-1001', token: PLAIN.token });
  assert.equal(res.ok, true);

  const view = await readAlertConfig(store, key);
  assert.equal(view.configured, true);
  assert.equal(view.decryptable, true);
  assert.equal(view.enabled, true);
  assert.equal(view.bot_id, '123456789');
  assert.equal(view.chat_id, '-1001');
  assert.equal('token' in view, false, 'read view must never include token');
  assert.doesNotMatch(JSON.stringify(store._row()), /AAHabcdefg/, 'stored row has no plaintext token');
});

test('writeAlertConfig reuses the existing token when token is omitted', async () => {
  const key = await deriveAesKey(SECRET);
  const store = memStore();
  await writeAlertConfig(store, key, { enabled: true, chat_id: '-1001111111111', token: PLAIN.token });
  const res = await writeAlertConfig(store, key, { enabled: true, chat_id: '-1002222222222' }); // token omitted
  assert.equal(res.ok, true);

  const row = store._row();
  const dec = await decryptConfig(key, row.config_cipher, row.config_iv, { id: 'telegram', keyVersion: row.key_version });
  assert.equal(dec.token, PLAIN.token, 'existing token preserved');
  assert.equal(dec.chat_id, '-1002222222222', 'chat_id updated');
});

test('enabling without any token is rejected', async () => {
  const key = await deriveAesKey(SECRET);
  const store = memStore();
  const res = await writeAlertConfig(store, key, { enabled: true, chat_id: '-100' });
  assert.equal(res.ok, false);
});

test('invalid token / chat_id are rejected', async () => {
  const key = await deriveAesKey(SECRET);
  const store = memStore();
  assert.equal((await writeAlertConfig(store, key, { enabled: true, chat_id: '-100', token: 'bad' })).ok, false);
  assert.equal((await writeAlertConfig(store, key, { enabled: true, chat_id: 'drop table', token: PLAIN.token })).ok, false);
});

test('removeAlertConfig clears the row', async () => {
  const key = await deriveAesKey(SECRET);
  const store = memStore();
  await writeAlertConfig(store, key, { enabled: true, chat_id: '-100', token: PLAIN.token });
  await removeAlertConfig(store);
  assert.equal((await readAlertConfig(store, key)).configured, false);
});

test('readAlertConfig reports decryptable:false when the key cannot decrypt', async () => {
  const key = await deriveAesKey(SECRET);
  const store = memStore();
  await writeAlertConfig(store, key, { enabled: true, chat_id: '-100', token: PLAIN.token });
  const otherKey = await deriveAesKey('rotated-secret-different-0123456789abcd');
  const view = await readAlertConfig(store, otherKey);
  assert.equal(view.configured, true);
  assert.equal(view.decryptable, false);
  assert.equal(view.chat_id, null);
  assert.equal('token' in view, false);
});

test('testThrottled enforces a minimum gap between test sends', () => {
  assert.equal(testThrottled(1000, 5000, 12000), true, 'within gap → throttled');
  assert.equal(testThrottled(1000, 20000, 12000), false, 'past gap → allowed');
  assert.equal(testThrottled(null, 99999, 12000), false, 'never tested → allowed');
});
