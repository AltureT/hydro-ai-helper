// Telegram alert-channel config: encryption, validation, and safe rendering.
//
// Security model (see docs/superpowers/specs/2026-06-24-telegram-alert-config-design.md):
// - Bot token + chat_id are encrypted together in one AES-GCM envelope, with a
//   key derived via HKDF-SHA-256 from the dedicated `ALERT_CONFIG_KEY` secret.
// - AAD binds `id|keyVersion` so the row's identity/version can't be swapped.
// - External alert text is redacted (never carries raw error-message samples).
// - Telegram requests pin api.telegram.org, plain text, no link preview.

const TEXT = new TextEncoder();
const HKDF_INFO = TEXT.encode('hydro/telegram-config/v1');

function bytesToB64(input) {
  const arr = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}

function aadBytes({ id, keyVersion }) {
  return TEXT.encode(`${id}|${keyVersion}`);
}

/** Derive an AES-GCM-256 key from the raw secret via HKDF-SHA-256 (domain-separated). */
export async function deriveAesKey(secret) {
  const ikm = await crypto.subtle.importKey('raw', TEXT.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt {token, chat_id} into a base64 envelope with a fresh IV and id|version AAD. */
export async function encryptConfig(key, plain, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = TEXT.encode(JSON.stringify({ token: plain.token, chat_id: plain.chat_id }));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadBytes(aad) }, key, data);
  return { cipher: bytesToB64(ct), iv: bytesToB64(iv) };
}

/** Decrypt the envelope. Rejects on tamper / wrong key / wrong AAD (GCM auth failure). */
export async function decryptConfig(key, cipher, iv, aad) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(iv), additionalData: aadBytes(aad) },
    key,
    b64ToBytes(cipher),
  );
  const obj = JSON.parse(new TextDecoder().decode(pt));
  return { token: obj.token, chat_id: obj.chat_id };
}

export function validateToken(token) {
  return typeof token === 'string' && token.length <= 256 && /^\d+:[A-Za-z0-9_-]{30,}$/.test(token);
}

export function validateChatId(chatId) {
  if (typeof chatId !== 'string' || chatId.length > 64) return false;
  return /^-?\d+$/.test(chatId) || /^@[A-Za-z0-9_]{3,}$/.test(chatId);
}

/** The non-secret numeric prefix of a bot token, for masked display. */
export function botIdFromToken(token) {
  if (typeof token !== 'string') return '';
  const m = token.match(/^(\d+):/);
  return m ? m[1] : '';
}

/**
 * Render alerts for an EXTERNAL channel. Deliberately omits each alert's
 * `detail` (which can embed raw error-message samples) — title + severity only.
 */
export function buildSafeAlertText(alerts) {
  const lines = alerts.map((a) => `[${a.severity}] ${a.title}`);
  return `🚨 hydro-ai-helper 告警 (${alerts.length})\n${lines.join('\n')}\n详情见面板`;
}

/** Build the Telegram sendMessage request (host pinned, plain text, no preview). */
export function buildTelegramRequest(token, chatId, text) {
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    body: { chat_id: chatId, text, disable_web_page_preview: true },
  };
}

/** Map a Telegram HTTP status to a non-leaking error code (null = ok). */
export function mapTelegramError(httpStatus) {
  if (httpStatus === 200) return null;
  if (httpStatus === 401 || httpStatus === 404) return 'invalid_token';
  if (httpStatus === 400) return 'chat_not_found';
  return 'upstream_failure';
}

const KEY_VERSION = 1;
const ROW_ID = 'telegram';

// `store` is a tiny abstraction over the single-row D1 config:
//   get(): row|null,  put(row): void,  del(): void
// Keeping handlers store-based (not raw SQL) isolates the security logic for
// testing; worker.js supplies a D1-backed store.

/** GET view — non-secret status only; never returns the bot token. */
export async function readAlertConfig(store, key) {
  const row = await store.get();
  if (!row || !row.config_cipher) {
    return { enabled: false, configured: false, decryptable: false, bot_id: null, chat_id: null };
  }
  let decryptable = false;
  let chat_id = null;
  try {
    const dec = await decryptConfig(key, row.config_cipher, row.config_iv, { id: ROW_ID, keyVersion: row.key_version });
    decryptable = true;
    chat_id = dec.chat_id;
  } catch { /* rotated key / tampered row → decryptable stays false */ }
  return { enabled: !!row.enabled, configured: true, decryptable, bot_id: row.bot_id || null, chat_id };
}

/** Validate + encrypt + persist. token omitted ⇒ reuse the existing one. */
export async function writeAlertConfig(store, key, input) {
  const enabled = !!input.enabled;
  const chatId = typeof input.chat_id === 'string' ? input.chat_id : '';
  if (!validateChatId(chatId)) return { ok: false, error: 'invalid_chat_id' };

  let token = input.token;
  if (token !== undefined && token !== '') {
    if (!validateToken(token)) return { ok: false, error: 'invalid_token' };
  } else {
    const row = await store.get();
    if (row && row.config_cipher) {
      try {
        const dec = await decryptConfig(key, row.config_cipher, row.config_iv, { id: ROW_ID, keyVersion: row.key_version });
        token = dec.token;
      } catch {
        return { ok: false, error: 'not_decryptable' };
      }
    } else {
      token = undefined;
    }
  }

  if (!token) return { ok: false, error: 'token_required' };

  const { cipher, iv } = await encryptConfig(key, { token, chat_id: chatId }, { id: ROW_ID, keyVersion: KEY_VERSION });
  await store.put({
    id: ROW_ID,
    enabled: enabled ? 1 : 0,
    bot_id: botIdFromToken(token),
    config_cipher: cipher,
    config_iv: iv,
    key_version: KEY_VERSION,
  });
  return { ok: true };
}

export async function removeAlertConfig(store) {
  await store.del();
  return { ok: true };
}

// True if a test send is too soon after the last one (anti-spam). 5s is enough
// to stop accidental rapid re-clicks on an already-authed endpoint while still
// allowing retry-after-fix during interactive configuration.
export function testThrottled(lastTestMs, nowMs, minGapMs = 5000) {
  if (lastTestMs == null) return false;
  return nowMs - lastTestMs < minGapMs;
}
