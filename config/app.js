/**
 * Central runtime configuration. Everything is overridable via environment variables (or
 * process.env assignments in config/local.js), so the same code runs in "development"
 * (zero-setup demo) and "production" (fail-closed) modes.
 *
 * APP_ENV=production flips the whole app to strict mode:
 *   - admin auth, encryption key and signing keys are REQUIRED
 *   - demo-only endpoints and the open admin area are off
 *   - on-chain mode refuses to start without an attestor key and deployed addresses
 */
export default function buildConfig(env = process.env) {
  const appEnv = env.APP_ENV || 'development';
  const isProd = appEnv === 'production';
  const flag = (name, def) => {
    const v = env[name];
    if (v === undefined || v === '') return def;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  };
  const num = (name, def) => (env[name] !== undefined && env[name] !== '' ? Number(env[name]) : def);

  return {
    env: appEnv,
    is_production: isProd,
    demo_mode: flag('DEMO_MODE', !isProd),
    port: num('PORT', 8000),
    trust_proxy_headers: flag('TRUST_PROXY_HEADERS', false),
    timezone: env.APP_TIMEZONE || 'Africa/Johannesburg',
    db_path: env.DB_SQLITE_PATH || null, // null -> storage/database.sqlite

    tokens: {
      nonce_ttl: 300,          // seconds a wallet sign-in challenge stays valid
      session_ttl: 3600,       // seconds a wallet session stays valid
      receipt_ttl: 60 * 60 * 24 * 365, // signed KYC receipts stay verifiable for a year
    },

    // KYC / AML decision policy. ILLUSTRATIVE demo policy - calibrate with your compliance officer.
    kyc: {
      engine_version: 'tsr-kyc-1.0',
      valid_days: num('KYC_VALID_DAYS', 365), // on-chain eligibility lapses after this; re-verify to renew
      approve_threshold: 70,
      review_threshold: 40,
      min_age: 18,
      // Declared-wealth tests for the accredited (tier 2) category. Evidence is checked by the provider adapter.
      accredited_net_worth_cents: 500_000_000,      // R5,000,000 excluding primary residence
      accredited_income_cents: 150_000_000,         // R1,500,000 / year
      // Source-of-funds evidence is demanded above this intended investment.
      sof_required_cents: 25_000_000,               // R250,000
      retail_annual_cap_cents: 100_000_000,         // R1,000,000 / retail investor / 12 months (info + monitoring)
    },

    // Ongoing AML transaction monitoring on indexed on-chain trades.
    aml: {
      large_trade_cents: 25_000_000,   // single trade >= R250,000 raises an alert
      velocity_count: 5,               // >= N trades by one wallet inside the window
      velocity_window_seconds: 3600,
      fast_flip_seconds: 600,          // bought then sold inside this window, repeatedly
      wash_trade: true,                // buyer and seller are wallets of the same verified person
    },

    chain: {
      enabled: flag('CHAIN_ENABLED', false),
      name: env.CHAIN_NAME || 'Local demo chain',
      id: num('CHAIN_ID', 31337),
      rpc_url: env.CHAIN_RPC_URL || '',
      explorer_url: env.CHAIN_EXPLORER_URL || '',
      registry_address: env.REGISTRY_ADDRESS || '',
      factory_address: env.FACTORY_ADDRESS || '',
      market_address: env.MARKET_ADDRESS || '',
      anchor_address: env.ANCHOR_ADDRESS || '',
      backing_address: env.BACKING_ADDRESS || '',        // BackingOracle: custodian-signed proof of backing (optional)
      // MOCK custodian signing key. In production the custodian signs on its own systems and only its address is configured.
      custodian_private_key: env.CUSTODIAN_PRIVATE_KEY || '',
      offramp_address: env.OFFRAMP_ADDRESS || '',        // where cash-out stablecoin is sent (a licensed off-ramp partner's treasury)
      token_address: env.TOKEN_ADDRESS || '',            // the settlement stablecoin
      token_symbol: env.TOKEN_SYMBOL || 'mZAR',
      token_decimals: num('TOKEN_DECIMALS', 6),
      attestor_private_key: env.ATTESTOR_PRIVATE_KEY || '', // signs KYC claims; holds no funds
      start_block: num('CHAIN_START_BLOCK', 0),
      confirmations: num('CHAIN_CONFIRMATIONS', 0), // index only blocks this deep (use 2+ on public testnets to ride out reorgs)
      index_interval_ms: num('INDEX_INTERVAL_MS', 4000),
      max_logs_range: num('MAX_LOGS_RANGE', 2000),
    },

    // Cash-out to mobile money. SIMULATED provider by default - see app/Services/PayoutAdapters/MockMobileMoney.js
    payouts: {
      provider: env.PAYOUT_PROVIDER || 'mock',
      fee_bps: num('PAYOUT_FEE_BPS', 150),             // illustrative off-ramp fee (1.5%)
      min_cents: num('PAYOUT_MIN_CENTS', 10_000),      // R100
      max_cents: num('PAYOUT_MAX_CENTS', 500_000_00),  // R500,000
      settle_seconds: num('PAYOUT_SETTLE_SECONDS', 8), // how long the mock provider takes to show "paid"
    },

    currency: { code: env.CURRENCY_CODE || 'ZAR', symbol: env.CURRENCY_SYMBOL || 'R', locale: env.CURRENCY_LOCALE || 'en-ZA' },
  };
}
