# Tessera - security model, honest limitations, next steps

Read this before treating Tessera as anything but a hackathon-grade reference implementation.

## What is enforced where

| Rule | Enforced by | Can a bug in our server break it? |
|---|---|---|
| Only KYC'd, un-frozen wallets can **hold or receive** shares | `AssetToken._update` (on every transfer, on any venue) | No - it's in the token |
| Asset-level tier (retail / accredited) and per-wallet concentration cap | `AssetToken` | No |
| Trades are atomic (money and shares move together or not at all) | `RWAMarketplace.buy` | No |
| Only factory-made tokens can be listed | `RWAMarketplace` + `AssetFactory.isAsset` | No |
| Yield is exact pro-rata, survives transfers, can't be claimed twice | `AssetToken` (ERC-2222 accounting) | No |
| Who gets a KYC claim | Node server (identity check -> decision engine) | **Yes** - the attestor key is the trust anchor |
| AML alerts | Node server (monitoring rules over indexed trades) | Detection only; freezing is an on-chain owner action |

The trust model, stated plainly: the blockchain enforces *who may hold what*; the operator (attestor + owner keys) decides *who is verified* and can freeze. That is how regulated security tokens work - Tessera does not pretend to be trustless about compliance.

## Hardening already in place
- Attestor key signs EIP-712 claims only and holds no funds; claims are wallet-bound, tier-bound, expiring and single-use.
- Wallet-session auth by signature challenge (single-use nonce); HMAC-signed, expiring tokens; per-purpose HKDF subkeys.
- PII AES-256-GCM encrypted at rest; national-ID dedupe via keyed HMAC blind index; wallet<->person link is off-chain and erasable.
- Applicants are never told *why* a sanctions/PEP/jurisdiction screen failed (no tipping-off); analysts see every gate and factor.
- Hash-chained audit log + Merkle roots anchored on-chain: rewriting history *and* re-hashing is still detectable.
- Production fails closed on missing/weak secrets (`tests/prod.test.js`).
- Indexer applies each log once (`processed_logs`), so retries are safe; the chain stays the source of truth; admin writes are CSRF-protected; login is throttled.
- All custom errors, pausability, fee cap (5%), owner-only unfreeze, attestor rotation.

## Known limitations (deliberate, for a hackathon)
1. **Mock KYC provider.** Sanctions/PEP lists and "evidence refs" are illustrative test data. Plug a real vendor into `app/Services/VerificationAdapters/` (interface documented). No liveness / document OCR is implemented.
2. **Smart contracts are unaudited.** Standard OpenZeppelin 5 building blocks and 29 contract tests, but no formal audit. Do not deploy to mainnet with real funds before one.
3. **Recovery is operator-controlled.** `forcedTransfer` / `recoverWallet` now exist (owner-only; the receiver must be KYC-eligible; a case-reference hash is emitted), but the owner key is a single point of trust and there is no multi-sig, timelock or on-chain dispute process. It is also not the full ERC-3643 identity model (no ONCHAINID).
4. **Settlement token.** The demo uses a mock stablecoin with a public faucet and an unrestricted `mint` - TESTNET ONLY. Production must point `TOKEN_ADDRESS` at a real stablecoin (and `deploy.js` accepts `STABLECOIN_ADDRESS`).
5. **Legal wrapper is off-chain.** The token commits to a dossier hash; the SPV / trust structure, investor rights, tax treatment and licensing (securities / CIS / FAIS-style regimes) are real-world work this repo does not do.
6. **Order book is simple.** Fixed-price listings, partial fills, no bids/auctions/price-time matching engine. Price discovery = the lowest ask.
7. **Reorgs.** The indexer supports `CHAIN_CONFIRMATIONS`; set 2+ on public networks. It does not roll back on deep reorgs.
8. **Yield deposit is issuer-pushed.** The contract distributes whatever the issuer deposits; it can't force the real-world asset to pay. Off-chain reporting and covenants matter. Dust (< 1 micro-unit per deposit) stays in the contract.
9. **AML rules are examples.** Thresholds in `config/app.js` are illustrative; calibrate with a compliance officer. Retail annual caps are configured but only used for monitoring, not enforced on-chain.
10. **Single-node SQLite** read model; PostgreSQL + a job queue is the production shape. Erasure is refused while an AML alert is open, and regulated record-keeping duties may require retaining records - get legal advice.

11. **Proof of backing is only as good as the custodian.** `BackingOracle` verifies a custodian's signature; it cannot check the custodian is honest, independent or solvent. In the demo the custodian is a mock key held by the server. Staleness is flagged in the UI but does not halt trading; a shortfall halts *buying* (not selling, so holders can still exit). Supply is fixed at issuance, so this is a trading halt rather than a capped mint.
12. **Cash-out is simulated.** `/api/payouts` verifies a real on-chain transfer to the off-ramp address and records a payout, but **no money reaches a phone**: `PayoutAdapters/MockMobileMoney.js` is a stub. A real version needs a licensed off-ramp / mobile-money partner, FX and fee disclosure, sanctions screening of the payout destination, and reconciliation. Only a masked phone number is stored.
13. **Not implemented from the track brief:** lock-ups, country restrictions, device/IoT data feeds, Chainlink reserve feeds.

## Next steps
ERC-3643-style identity + forced transfer; real KYC vendor + liveness; bids and RFQ for large blocks; yield streaming (continuous vs periodic); NAV/valuation oracle updates signed by an appraiser; multi-sig owner; gasless meta-transactions for onboarding; subgraph-based indexing; i18n and mobile PWA.
