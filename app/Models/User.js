import { getDb } from '../../config/database.js';

export const User = {
  create({ id_number_hash, full_name_enc, dob_enc, country, investor_type }) {
    const { lastInsertRowid } = getDb().prepare(
      'INSERT INTO users (id_number_hash, full_name_enc, dob_enc, country, investor_type) VALUES (?,?,?,?,?)',
    ).run(id_number_hash, full_name_enc, dob_enc, country, investor_type);
    return Number(lastInsertRowid);
  },
  find(id) { return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null; },
  findByIdHash(hash) { return getDb().prepare('SELECT * FROM users WHERE id_number_hash = ?').get(hash) ?? null; },
  findByWallet(address) {
    return getDb().prepare('SELECT u.* FROM users u JOIN wallets w ON w.user_id = u.id WHERE w.address = ? AND u.deleted_at IS NULL').get(address) ?? null;
  },
  update(id, fields) {
    const keys = Object.keys(fields);
    getDb().prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  },
  count() { return getDb().prepare('SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL').get().n; },
};

export const Wallet = {
  /** Bind a wallet to a user. A wallet belongs to exactly one person; returns false if bound to someone else. */
  bind(address, userId) {
    const db = getDb();
    const w = db.prepare('SELECT * FROM wallets WHERE address = ?').get(address);
    if (!w) { db.prepare('INSERT INTO wallets (address, user_id) VALUES (?, ?)').run(address, userId); return true; }
    if (w.user_id === userId) return true;
    if (w.user_id === null) { db.prepare('UPDATE wallets SET user_id = ?, bound_at = CURRENT_TIMESTAMP WHERE address = ?').run(userId, address); return true; }
    return false;
  },
  find(address) { return getDb().prepare('SELECT * FROM wallets WHERE address = ?').get(address) ?? null; },
  forUser(userId) { return getDb().prepare('SELECT address FROM wallets WHERE user_id = ?').all(userId).map((r) => r.address); },
  unlinkUser(userId) { getDb().prepare('UPDATE wallets SET user_id = NULL WHERE user_id = ?').run(userId); },
  userIdOf(address) { return Wallet.find(address)?.user_id ?? null; },
};
