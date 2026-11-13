import { getDb } from '../../config/database.js';

const parse = (r) => (r ? { ...r, factors: JSON.parse(r.factors), gates: JSON.parse(r.gates) } : null);

export const KycDecision = {
  create(d) {
    const { lastInsertRowid } = getDb().prepare(
      `INSERT INTO kyc_decisions (decision_id, user_id, wallet, decision, tier, score, engine, factors, gates, required_action, provider, claim_expiry)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(d.decision_id, d.user_id, d.wallet, d.decision, d.tier, d.score, d.engine, JSON.stringify(d.factors), JSON.stringify(d.gates), d.required_action ?? null, d.provider, d.claim_expiry ?? null);
    return Number(lastInsertRowid);
  },
  find(id) { return parse(getDb().prepare('SELECT * FROM kyc_decisions WHERE id = ?').get(id)); },
  findByDecisionId(did) { return parse(getDb().prepare('SELECT * FROM kyc_decisions WHERE decision_id = ?').get(did)); },
  latestForWallet(wallet) { return parse(getDb().prepare('SELECT * FROM kyc_decisions WHERE wallet = ? ORDER BY id DESC LIMIT 1').get(wallet)); },
  latestApprovedForWallet(wallet) {
    return parse(getDb().prepare("SELECT * FROM kyc_decisions WHERE wallet = ? AND decision = 'approved' ORDER BY id DESC LIMIT 1").get(wallet));
  },
  forUser(userId) { return getDb().prepare('SELECT * FROM kyc_decisions WHERE user_id = ? ORDER BY id DESC').all(userId).map(parse); },
  update(id, fields) {
    const keys = Object.keys(fields);
    const vals = keys.map((k) => (typeof fields[k] === 'object' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]));
    getDb().prepare(`UPDATE kyc_decisions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  },
  markRegistered(id, txHash) {
    getDb().prepare("UPDATE kyc_decisions SET registered_tx = ?, registered_at = datetime('now') WHERE id = ?").run(txHash, id);
  },
  /** Admin list - joins nothing personal beyond the investor category. */
  list({ decision = null, limit = 100 } = {}) {
    const rows = decision
      ? getDb().prepare('SELECT * FROM kyc_decisions WHERE decision = ? ORDER BY id DESC LIMIT ?').all(decision, limit)
      : getDb().prepare('SELECT * FROM kyc_decisions ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(parse);
  },
  counts() {
    const rows = getDb().prepare('SELECT decision, COUNT(*) n FROM kyc_decisions GROUP BY decision').all();
    return Object.fromEntries(rows.map((r) => [r.decision, r.n]));
  },
};

export const Consent = {
  grant(wallet, purpose, version) {
    getDb().prepare('INSERT INTO consents (wallet, purpose, version) VALUES (?,?,?)').run(wallet, purpose, version);
  },
  active(wallet, purpose) {
    return getDb().prepare('SELECT * FROM consents WHERE wallet = ? AND purpose = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1').get(wallet, purpose) ?? null;
  },
  revoke(wallet, purpose) {
    getDb().prepare("UPDATE consents SET revoked_at = datetime('now') WHERE wallet = ? AND purpose = ? AND revoked_at IS NULL").run(wallet, purpose);
  },
  forWallets(wallets) {
    if (!wallets.length) return [];
    return getDb().prepare(`SELECT purpose, version, granted_at, revoked_at FROM consents WHERE wallet IN (${wallets.map(() => '?').join(',')})`).all(...wallets);
  },
};
