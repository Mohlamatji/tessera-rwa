import { getDb } from '../../config/database.js';
import { Config } from '../Support/Config.js';
import { Eth } from '../Support/Eth.js';
import { Tokens } from '../Support/Tokens.js';

/**
 * Wallet sign-in challenges (a minimal "Sign-In with Ethereum"). The server issues a single-use,
 * short-lived nonce; the browser wallet signs it (personal_sign - free, no gas, no approval); the
 * server recovers the signer. That proves control of the wallet, which is what binds a verified
 * person to an address.
 */
export const ChallengeService = {
  issue(address) {
    const nonce = Tokens.randomHex(16);
    const ttl = Config.get('tokens.nonce_ttl');
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const message = [
      'Tessera sign-in',
      `Wallet: ${Eth.checksum(address)}`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expires * 1000).toISOString()}`,
      '',
      'Signing proves you control this wallet. It costs no gas and grants no spending permission.',
    ].join('\n');
    getDb().prepare('INSERT INTO auth_challenges (address, nonce, message, expires_at) VALUES (?,?,?,?)').run(address, nonce, message, expires);
    return { nonce, message, expires_at: expires };
  },

  /** Consumes the latest unused challenge for `address` if `signature` over it recovers to `address`. */
  consume(address, signature) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM auth_challenges WHERE address = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1').get(address);
    if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return false;
    if (Eth.recoverMessage(row.message, signature) !== address) return false;
    // Single-use: the UPDATE only succeeds once, even under concurrent requests.
    return db.prepare("UPDATE auth_challenges SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(row.id).changes === 1;
  },
};
