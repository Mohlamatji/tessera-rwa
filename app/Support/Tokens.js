import crypto from 'node:crypto';
import { Config } from './Config.js';

const b64u = (b) => Buffer.from(b).toString('base64url');

/** Derives a purpose-specific subkey from APP_ENCRYPTION_KEY (HKDF). Dev falls back to a fixed, clearly-insecure key. */
export function subkey(purpose) {
  const base = Config.security().session_secret || Config.security().encryption_key;
  if (!base) {
    if (Config.isProduction()) throw new Error('APP_ENCRYPTION_KEY (or SESSION_SECRET) is required in production.');
    return Buffer.from(crypto.hkdfSync('sha256', 'tessera-insecure-dev-key-do-not-use', 'tessera', purpose, 32));
  }
  if (Config.isProduction() && base.length < 32) throw new Error('APP_ENCRYPTION_KEY must be at least 32 characters in production.');
  return Buffer.from(crypto.hkdfSync('sha256', base, 'tessera', purpose, 32));
}

/** Compact HMAC-signed tokens: base64url(json).base64url(hmac). Used for wallet sessions and decision receipts. */
export const Tokens = {
  sign(payload, purpose, prefix = '') {
    const body = b64u(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', subkey(purpose)).update(body).digest('base64url');
    return `${prefix}${body}.${sig}`;
  },

  /** @returns {object|null} payload if the signature is valid and (when present) `exp` is in the future */
  verify(token, purpose, prefix = '') {
    if (typeof token !== 'string' || !token.startsWith(prefix)) return null;
    const [body, sig, extra] = token.slice(prefix.length).split('.');
    if (!body || !sig || extra !== undefined) return null;
    const want = crypto.createHmac('sha256', subkey(purpose)).update(body).digest();
    let got; try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    let payload; try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (payload && payload.exp !== undefined && Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  },

  randomHex(bytes = 16) { return crypto.randomBytes(bytes).toString('hex'); },
};
