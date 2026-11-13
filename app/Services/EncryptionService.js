import crypto from 'node:crypto';
import { subkey } from '../Support/Tokens.js';

/**
 * AES-256-GCM (authenticated: tampered ciphertext fails to decrypt) with an HKDF subkey per purpose,
 * plus a keyed HMAC "blind index" so a national-ID number can be looked up for de-duplication
 * without ever storing it - and without being brute-forceable like a plain hash of a structured number.
 */
export const EncryptionService = {
  encrypt(plain, purpose = 'pii') {
    if (plain === null || plain === undefined) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', subkey(`enc:${purpose}`), iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  },

  decrypt(blob, purpose = 'pii') {
    if (!blob) return null;
    const [v, iv, tag, ct] = String(blob).split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised ciphertext format.');
    const d = crypto.createDecipheriv('aes-256-gcm', subkey(`enc:${purpose}`), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  },

  blindIndex(value) {
    return crypto.createHmac('sha256', subkey('blind-index')).update(String(value).replace(/\s+/g, '').toUpperCase()).digest('hex');
  },
};
