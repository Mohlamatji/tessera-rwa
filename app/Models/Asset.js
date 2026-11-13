import { getDb } from '../../config/database.js';

export const ASSET_CLASSES = ['Real estate', 'Private credit', 'Green energy', 'Luxury & collectibles', 'Other'];

export const AssetMetadata = {
  create(m) {
    getDb().prepare(
      `INSERT OR IGNORE INTO asset_metadata (metadata_hash, name, symbol, asset_class, description, location, valuation_cents, target_yield_bps, payout_frequency, issuer_name, legal_structure, image_hue, canonical_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(m.metadata_hash, m.name, m.symbol, m.asset_class, m.description, m.location, m.valuation_cents, m.target_yield_bps, m.payout_frequency, m.issuer_name, m.legal_structure, m.image_hue, m.canonical_json);
  },
  byHash(hash) { return getDb().prepare('SELECT * FROM asset_metadata WHERE metadata_hash = ?').get(hash.toLowerCase()) ?? null; },
};

/** Fast read model of on-chain assets, joined with their off-chain dossier through the committed document hash. */
export const Asset = {
  upsert(a) {
    getDb().prepare(
      `INSERT INTO assets (address, issuer, name, symbol, asset_class, total_shares, min_tier, document_hash, created_block, created_tx)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address) DO NOTHING`,
    ).run(a.address, a.issuer, a.name, a.symbol, a.asset_class, String(a.total_shares), a.min_tier, a.document_hash, a.created_block, a.created_tx);
  },
  find(address) {
    return getDb().prepare(
      `SELECT a.*, m.description, m.location, m.valuation_cents, m.target_yield_bps, m.payout_frequency, m.issuer_name, m.legal_structure, m.image_hue
       FROM assets a LEFT JOIN asset_metadata m ON m.metadata_hash = a.document_hash WHERE a.address = ?`,
    ).get(address.toLowerCase()) ?? null;
  },
  all() {
    return getDb().prepare(
      `SELECT a.*, m.description, m.location, m.valuation_cents, m.target_yield_bps, m.payout_frequency, m.issuer_name, m.legal_structure, m.image_hue
       FROM assets a LEFT JOIN asset_metadata m ON m.metadata_hash = a.document_hash ORDER BY a.created_block ASC, a.address ASC`,
    ).all();
  },
  count() { return getDb().prepare('SELECT COUNT(*) n FROM assets').get().n; },
  updateDocumentHash(address, hash) { getDb().prepare('UPDATE assets SET document_hash = ? WHERE address = ?').run(hash, address.toLowerCase()); },
};

export const Holding = {
  adjust(asset, holder, delta) {
    const db = getDb();
    const row = db.prepare('SELECT shares FROM holdings WHERE asset = ? AND holder = ?').get(asset, holder);
    const next = (row ? BigInt(row.shares) : 0n) + BigInt(delta);
    db.prepare('INSERT INTO holdings (asset, holder, shares) VALUES (?,?,?) ON CONFLICT(asset, holder) DO UPDATE SET shares = excluded.shares').run(asset, holder, next.toString());
  },
  forWallet(holder) { return getDb().prepare("SELECT asset, shares FROM holdings WHERE holder = ? AND shares != '0'").all(holder); },
  holders(asset) { return getDb().prepare("SELECT holder, shares FROM holdings WHERE asset = ? AND shares != '0' ORDER BY CAST(shares AS INTEGER) DESC").all(asset); },
  holderCount(asset) { return getDb().prepare("SELECT COUNT(*) n FROM holdings WHERE asset = ? AND shares != '0'").get(asset).n; },
};

export const Listing = {
  upsert(l) {
    getDb().prepare(
      `INSERT INTO listings (id, asset, seller, remaining, price_per_share, active, created_tx, created_at) VALUES (?,?,?,?,?,1,?,?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(l.id, l.asset, l.seller, String(l.remaining), String(l.price_per_share), l.created_tx, l.created_at);
  },
  find(id) { return getDb().prepare('SELECT * FROM listings WHERE id = ?').get(id) ?? null; },
  reduce(id, amount) {
    const l = Listing.find(id); if (!l) return;
    const rem = BigInt(l.remaining) - BigInt(amount);
    getDb().prepare('UPDATE listings SET remaining = ?, active = ? WHERE id = ?').run(rem.toString(), rem > 0n ? 1 : 0, id);
  },
  deactivate(id) { getDb().prepare('UPDATE listings SET active = 0 WHERE id = ?').run(id); },
  active(asset = null) {
    const base = "SELECT * FROM listings WHERE active = 1 AND remaining != '0'";
    return (asset ? getDb().prepare(base + ' AND asset = ? ORDER BY CAST(price_per_share AS INTEGER) ASC, id ASC').all(asset) : getDb().prepare(base + ' ORDER BY id DESC').all());
  },
};

export const Trade = {
  insert(t) {
    const r = getDb().prepare(
      `INSERT OR IGNORE INTO trades (tx_hash, log_index, listing_id, asset, buyer, seller, amount, price_per_share, fee, block_time) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(t.tx_hash, t.log_index, t.listing_id, t.asset, t.buyer, t.seller, String(t.amount), String(t.price_per_share), String(t.fee), t.block_time);
    return r.changes ? Number(r.lastInsertRowid) : null;
  },
  forAsset(asset, limit = 50) { return getDb().prepare('SELECT * FROM trades WHERE asset = ? ORDER BY id DESC LIMIT ?').all(asset, limit); },
  recent(limit = 50) { return getDb().prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit); },
  last(asset) { return getDb().prepare('SELECT * FROM trades WHERE asset = ? ORDER BY id DESC LIMIT 1').get(asset) ?? null; },
  byWalletSince(wallet, sinceUnix) {
    return getDb().prepare('SELECT * FROM trades WHERE (buyer = ? OR seller = ?) AND block_time >= ? ORDER BY id ASC').all(wallet, wallet, sinceUnix);
  },
  all() { return getDb().prepare('SELECT * FROM trades ORDER BY id ASC').all(); },
};

export const YieldEvent = {
  insert(y) {
    getDb().prepare(
      'INSERT OR IGNORE INTO yield_events (tx_hash, log_index, asset, kind, holder, amount, ref, block_time) VALUES (?,?,?,?,?,?,?,?)',
    ).run(y.tx_hash, y.log_index, y.asset, y.kind, y.holder ?? null, String(y.amount), y.ref ?? null, y.block_time);
  },
  forAsset(asset, kind = null, limit = 50) {
    return kind
      ? getDb().prepare('SELECT * FROM yield_events WHERE asset = ? AND kind = ? ORDER BY id DESC LIMIT ?').all(asset, kind, limit)
      : getDb().prepare('SELECT * FROM yield_events WHERE asset = ? ORDER BY id DESC LIMIT ?').all(asset, limit);
  },
  totals(asset) {
    const rows = getDb().prepare('SELECT kind, amount FROM yield_events WHERE asset = ?').all(asset);
    let dep = 0n, clm = 0n;
    for (const r of rows) (r.kind === 'deposit' ? (dep += BigInt(r.amount)) : (clm += BigInt(r.amount)));
    return { deposited: dep, claimed: clm };
  },
};

export const ChainState = {
  get(key, def = null) { return getDb().prepare('SELECT value FROM chain_state WHERE key = ?').get(key)?.value ?? def; },
  set(key, value) {
    getDb().prepare('INSERT INTO chain_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  },
};

export const AmlAlert = {
  create(a) {
    const { lastInsertRowid } = getDb().prepare('INSERT INTO aml_alerts (rule, severity, wallet, detail, trade_id) VALUES (?,?,?,?,?)')
      .run(a.rule, a.severity, a.wallet, JSON.stringify(a.detail), a.trade_id ?? null);
    return Number(lastInsertRowid);
  },
  find(id) { const r = getDb().prepare('SELECT * FROM aml_alerts WHERE id = ?').get(id); return r ? { ...r, detail: JSON.parse(r.detail) } : null; },
  list(status = null) {
    const rows = status ? getDb().prepare('SELECT * FROM aml_alerts WHERE status = ? ORDER BY id DESC').all(status) : getDb().prepare('SELECT * FROM aml_alerts ORDER BY id DESC LIMIT 200').all();
    return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  },
  exists(rule, wallet, tradeId) {
    return !!getDb().prepare('SELECT 1 FROM aml_alerts WHERE rule = ? AND wallet = ? AND trade_id IS ?').get(rule, wallet, tradeId ?? null);
  },
  resolve(id, status, frozenTx = null) { getDb().prepare('UPDATE aml_alerts SET status = ?, frozen_tx = ? WHERE id = ?').run(status, frozenTx, id); },
  openFor(wallet) { return getDb().prepare("SELECT COUNT(*) n FROM aml_alerts WHERE wallet = ? AND status = 'open'").get(wallet).n; },
};
