-- SQLite schema. Applied automatically on first start by app/Support/Migrator.js (idempotent).
-- Personal data (users.*_enc) is AES-256-GCM encrypted; the national-ID lookup key is a keyed HMAC blind index.
-- NOTHING in this database is mirrored on-chain except opaque decision ids and wallet addresses.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_number_hash TEXT UNIQUE,
    full_name_enc TEXT,
    dob_enc TEXT,
    country TEXT,
    investor_type TEXT NOT NULL DEFAULT 'retail' CHECK (investor_type IN ('retail','accredited')),
    deleted_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Wallet <-> person link. Off-chain on purpose, so it can be erased (user_id set NULL) on request.
CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    user_id INTEGER,
    bound_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS consents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    purpose TEXT NOT NULL,
    version TEXT NOT NULL,
    granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_consents_wallet ON consents(wallet, purpose);

CREATE TABLE IF NOT EXISTS auth_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    message TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One row per KYC/AML decision. `decision_id` (bytes32 hex) is what the chain sees.
CREATE TABLE IF NOT EXISTS kyc_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    wallet TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved','review','rejected')),
    tier INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL,
    engine TEXT NOT NULL,
    factors TEXT NOT NULL,          -- JSON [{code,points,detail}]
    gates TEXT NOT NULL,            -- JSON [{code,passed,detail}]
    required_action TEXT,
    provider TEXT NOT NULL,
    claim_expiry INTEGER,           -- unix seconds: when on-chain eligibility lapses
    registered_tx TEXT,             -- tx hash of ComplianceRegistry.register, once confirmed on-chain
    registered_at TEXT,
    resolved_by TEXT,               -- admin who resolved a manual review
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_kyc_wallet ON kyc_decisions(wallet, id);

-- Off-chain asset dossier. `metadata_hash` is committed on-chain as AssetToken.documentHash.
CREATE TABLE IF NOT EXISTS asset_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metadata_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    asset_class INTEGER NOT NULL,
    description TEXT,
    location TEXT,
    valuation_cents INTEGER,
    target_yield_bps INTEGER,       -- advertised annual yield, basis points
    payout_frequency TEXT,
    issuer_name TEXT,
    legal_structure TEXT,
    image_hue INTEGER,
    canonical_json TEXT NOT NULL,   -- exactly what was hashed
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexed from chain events (IndexerService). The chain is the source of truth; these are a fast read model.
CREATE TABLE IF NOT EXISTS assets (
    address TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    asset_class INTEGER NOT NULL,
    total_shares TEXT NOT NULL,
    min_tier INTEGER NOT NULL,
    document_hash TEXT NOT NULL,
    created_block INTEGER,
    created_tx TEXT
);

CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY,         -- the on-chain listing id
    asset TEXT NOT NULL,
    seller TEXT NOT NULL,
    remaining TEXT NOT NULL,
    price_per_share TEXT NOT NULL,  -- stablecoin base units
    active INTEGER NOT NULL DEFAULT 1,
    created_tx TEXT,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    listing_id INTEGER NOT NULL,
    asset TEXT NOT NULL,
    buyer TEXT NOT NULL,
    seller TEXT NOT NULL,
    amount TEXT NOT NULL,
    price_per_share TEXT NOT NULL,
    fee TEXT NOT NULL,
    block_time INTEGER,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades(asset, id);

CREATE TABLE IF NOT EXISTS yield_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    asset TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('deposit','claim')),
    holder TEXT,
    amount TEXT NOT NULL,
    ref TEXT,
    block_time INTEGER,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_yield_asset ON yield_events(asset, id);

-- Running share balances reconstructed from Transfer events (holder counts, portfolio fallbacks).
CREATE TABLE IF NOT EXISTS holdings (
    asset TEXT NOT NULL,
    holder TEXT NOT NULL,
    shares TEXT NOT NULL,
    PRIMARY KEY (asset, holder)
);

-- Idempotency for the indexer: a log is applied at most once, even if a sync is retried after a crash.
CREATE TABLE IF NOT EXISTS processed_logs (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS chain_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aml_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
    wallet TEXT NOT NULL,
    detail TEXT NOT NULL,           -- JSON, no personal data
    trade_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','frozen','dismissed')),
    frozen_tx TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root TEXT NOT NULL UNIQUE,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    count INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_limit_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_key TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket ON rate_limit_hits(bucket_key, created_at);

-- Tamper-evident: every row commits to the previous row's hash (SHA-256 chain).
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    subject_table TEXT,
    subject_id TEXT,
    ip_address TEXT,
    prev_hash TEXT,
    entry_hash TEXT,
    created_at TEXT NOT NULL
);

-- Cash-out requests (stablecoin -> mobile money). The on-chain transfer to the off-ramp address is the proof of funds;
-- only a MASKED phone number is stored. Provider is a simulation unless a real off-ramp adapter is plugged in.
CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    amount TEXT NOT NULL,            -- stablecoin base units, read from the chain
    fee TEXT NOT NULL,
    net TEXT NOT NULL,
    msisdn_masked TEXT NOT NULL,
    network TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payouts_wallet ON payouts(wallet, id);
