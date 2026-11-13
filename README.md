# Tessera - Fractional Real-World-Asset Marketplace

> Tokenise buildings, loans and solar farms into **KYC/AML-gated ERC-20 shares**. Investors buy a slice, trade it instantly on a non-custodial order book, and receive rent / interest **automatically from a smart contract**.

Built with **Solidity (OpenZeppelin 5) · ethers v6 · Node.js (no framework) · SQLite · vanilla-JS wallet UI**. Same repository layout and conventions as *Identity Vault v2.1* - a `chain/` workspace for contracts, an `app/` tree for controllers/models/services, `public/` front controller, `tests/` for unit tests and `chain/test/` for on-chain tests.

## The idea in one picture

```
 Investor wallet ── signs ──►  Node server (KYC · AML · indexer)         Blockchain (EVM)
      │                         identity check → explainable decision     ┌───────────────────────┐
      │                         EIP-712 claim, signed by attestor ──────► │ ComplianceRegistry    │ KYC tier, expiry, freeze
      │  register(claim) ─────────────────────────────────────────────► │   ▲                   │
      │                                                                   │   │ isEligible()      │
      │  buy / list / claim ────────────────────────────────────────────► │ AssetToken (1/asset)  │ shares + yield, gated on EVERY transfer
      │                                                                   │ RWAMarketplace        │ atomic, non-custodial order book
      └───────────── reads ◄── indexer (events → SQLite read model) ◄──── │ AssetFactory          │ curated issuance
                              AML monitoring on trades · hash-chained audit │ AuditAnchor           │ Merkle roots of the audit log
                              log ── Merkle root ───────────────────────► └───────────────────────┘
```

| Requirement | How Tessera does it |
|---|---|
| **Fractional ownership** | One `AssetToken` (ERC-20, 0 decimals) per asset; 1 token = 1 indivisible share; dossier (valuation, legal SPV) hashed on-chain |
| **Automated yield** | Issuer deposits income → O(1) gas pro-rata accounting (ERC-2222 style): exact to the share, correct across transfers; holders `claim()`, or a keeper bot pushes with `claimFor()` |
| **Integrated KYC/AML** | Off-chain verification + sanctions/PEP/jurisdiction screening → explainable decision → wallet-bound, expiring, single-use EIP-712 claim → `ComplianceRegistry`. The **token itself** rejects transfers to unverified/frozen wallets, on any venue. AML transaction monitoring (large trade, velocity, fast flip, wash trade) with on-chain freeze |
| **Instant secondary liquidity** | `RWAMarketplace`: atomic, non-custodial, partial fills; shares stay in the seller's wallet (and keep earning yield) until sold |
| **Privacy** | Only `{tier, expiry, opaque decisionId}` on-chain. PII AES-256-GCM encrypted off-chain; export & erase endpoints |
| **Proof of backing** | A custodian signs an EIP-712 statement of how many shares are backed (`BackingOracle`). The marketplace reverts every purchase of an asset while the reserve is short - the "is the asset really there?" answer, on-chain. *(Custodian is a mock key in the demo.)* |
| **Freeze & recover** | Compliance `freeze`, plus owner-only `forcedTransfer` / `recoverWallet` (court order, lost keys): the receiver must still be KYC-eligible, and a hashed case reference is emitted on-chain |
| **Path back to cash** | Yield pays out in stablecoin; the Portfolio page cashes out to a mobile-money wallet (send mZAR to the off-ramp address → payout). *(Payout provider is simulated.)* |
| **Auditability** | Hash-chained audit log + Merkle roots anchored on-chain; public receipt verifier that checks proofs **in your browser** |

## Quick start (zero config)

Requires **Node ≥ 22.13** (uses built-in `node:sqlite`).

##Command to generate money on the wallet
fund.mjs 0xB769E7fd1a7251a4bE60792975D6Fa97c057C6cE 10

```bash
npm install                  # root: ethers
cd chain && npm install      # solc, OpenZeppelin, ganache
cd .. && npm run demo
```

`npm run demo` compiles the contracts, starts a local chain (`:8545`), deploys everything, starts the app on **http://localhost:8000**, onboards two investors, issues three assets (office tower, solar farm, private-credit note), runs primary sales, deposits rental income and lists a resale. It prints test private keys - import **alice** (verified retail, holds shares, has yield to claim) and **issuer** / **operator** into MetaMask, add the local network printed in the terminal, and try:

1. **Marketplace** → open *Sandton Office Tower* → buy shares as Alice (wallet approves stablecoin, then buys atomically).
2. **Portfolio** → claim the rent Alice has accrued; press *Get 100,000 test mZAR* for more play money.
3. **Get verified** as a brand-new wallet (carol): consent → KYC → *Register on-chain* → now carol can buy. Before that, her buy reverts.
4. **Operator console** (`/dashboard`): approve a manual KYC review, see AML alerts, **freeze** a wallet (watch its transfers revert), **recover** its shares to a new wallet, issue a new asset, **anchor the audit log** on-chain.
5. **Proof of backing** (Operator console): attest an asset fully backed, then *Simulate 10% reserve shortfall* - the asset page turns red, **Buy** is disabled and the contract itself reverts. Attest again to resume.
6. **Cash out** (Portfolio): send mZAR to the off-ramp and watch a simulated mobile-money payout go *processing → paid*.
7. **Verify receipt** (`/verify`): paste a receipt - authenticity, on-chain registration and Merkle proofs are checked, without logging in.

Run only the app (chain off, UI will show "chain not configured"): `npm start`.

## Tests

```bash
npm run test:unit              # decision engine, Merkle, tokens, crypto, audit chain, prod fail-closed, wallet-error handling
cd chain && npm test           # contract tests + end-to-end (real server + real EVM + wallet signatures); slow on pure-JS ganache - give it a few minutes
```

The contract suites cover: claim binding/replay/expiry/forgery, AML freeze, tier gating, concentration caps, pause, exact yield accounting across transfers (conservation), keeper pushes, atomic trades, fee split, stale listings, non-KYC buyers. The e2e suite drives the HTTP API exactly as a browser would, including tamper-and-rehash detection against an on-chain anchor.

## Deploy to a real testnet (Base Sepolia, Polygon Amoy, or any EVM testnet)

```bash
node chain/scripts/generate-attestor-key.js            # signs KYC claims only, holds no funds
cd chain
CHAIN_RPC_URL=https://sepolia.base.org DEPLOYER_PRIVATE_KEY=0x… ATTESTOR_PRIVATE_KEY=0x… node scripts/deploy.js
cd .. && cp config/local.js.example config/local.js    # paste the printed addresses + attestor key
npm start
```
`deploy.js` also deploys `BackingOracle` (custodian = `CUSTODIAN_ADDRESS`, default: the attestor) and wires it into the marketplace; paste `BACKING_ADDRESS` too. For cash-out set `OFFRAMP_ADDRESS`.
Optionally run the keeper: `CHAIN_RPC_URL=… KEEPER_PRIVATE_KEY=0x… FACTORY_ADDRESS=0x… node chain/scripts/keeper.js` (cron it).

## Folder structure (mirrors Identity Vault v2.1)

```
tessera-rwa/
├── index.js                     launcher (≈ index.php)             ├── chain/
├── package.json  .env.example   .gitignore                        │   ├── contracts/   ComplianceRegistry, AssetToken, AssetFactory,
├── README.md  IMPROVEMENTS.md  SUBMISSION.md                      │   │                RWAMarketplace, BackingOracle, AuditAnchor, MockStablecoin
├── config/                                                        │   ├── scripts/     compile · deploy · demo · seed · keeper · xrpl-mpt · generate-attestor-key
│   app.js providers.js retention.js security.js database.js       │   ├── test/        registry · token · market · e2e (+ helpers)
│   local.js.example                                               │   └── artifacts/   compiled ABI + bytecode
├── database/schema.sqlite.sql                                     ├── tests/           unit.test.js · prod.test.js
├── app/                                                           ├── build/           Tailwind (dev-only) → public/css/app.css
│   ├── Controllers/  Api · Market · Chain · Admin                 ├── public/
│   ├── Models/       AuditLog · User(+Wallet) · KycDecision(+Consent) · Asset(+Listing,Trade,YieldEvent,AmlAlert…)
│   ├── Services/     Kyc · DecisionEngine · Aml · Chain · Indexer · Market · Asset · Receipt · Encryption · Challenge · Auth · Consent ·
│   │                 DataSubject · Retention · RateLimit · VerificationAdapters/(Mock, Factory, Interface)
│   ├── Support/      Config · Http · Tokens · Eth · Merkle · AdminAuth · AuthContext · SaId · View · Migrator
│   └── Views/        marketplace · asset · portfolio · onboarding · dashboard · verify · login · api-docs
└── storage/                     SQLite file (gitignored)               index.js · css/ · js/ · openapi.yaml
```

## Asset pictures

Each asset card shows `public/img/assets/<symbol>.jpg` (or `.webp` / `.png`) if it exists, otherwise the bundled illustration `<symbol>.svg`, which is labelled *Illustrative image* on screen. Drop a real photo with the asset's lower-case ticker (e.g. `sndt.jpg`) to replace it.

## Troubleshooting wallets

| You see | Cause | Fix |
|---|---|---|
| *"Your wallet already has a request waiting"* (used to show as **`could not coalesce error`**) | A second wallet request was fired while one was still open in MetaMask - ethers v6 reports MetaMask's `-32002` as that generic message | Open the MetaMask window, approve or reject the pending request, try again. The app now sends one signature request at a time and no longer prompts on page load |
| *"…transaction counter is out of sync with the local demo chain"* | You restarted `npm run demo`; MetaMask still remembers the old chain's nonces | MetaMask → Settings → Advanced → **Clear activity tab data** |
| *"Cannot reach the blockchain node"* | The demo/RPC is not running, or the wallet's network RPC URL is wrong | Start `npm run demo`; check the network is `http://127.0.0.1:8545`, chain id 31337 |
| *"…does not know this network yet"* | The local network is not added to the wallet | Click **Connect wallet** (the app offers to add it) |

| *\"…has not authorised this site for the selected account\"* (MetaMask error **4100**, console: `wallet refused personal_sign`) | MetaMask no longer treats this site as connected for the selected account (stale permission, locked wallet, another wallet extension answering `window.ethereum`) | The app already retries with the checksummed address and re-requests the permission once. If it persists: reload the tab, unlock MetaMask, disconnect the site in MetaMask → Connected sites, click **Connect wallet** again, and disable other wallet extensions. In the browser console run `Tessera.diagnose()` to print the wallet's account list, chain and provider flags |

## XRPL MPT rail (optional)

`node chain/scripts/xrpl-mpt.js` (dry run) / `--submit` issues an asset as an XRP Ledger Multi-Purpose Token. See the XRPL section of [HACKATHON.md](HACKATHON.md) for the flag mapping and caveats.

## Hackathon mapping

See **[HACKATHON.md](HACKATHON.md)** for how Tessera maps to the Real-World Assets track brief, the MVP checklist and the rubric - including exactly which parts are mocked.

## Configuration

Everything is an environment variable (see `.env.example`) or set in `config/local.js` (gitignored). `APP_ENV=production` is **fail-closed**: it refuses to start without a 32+ char `APP_ENCRYPTION_KEY`, an `ADMIN_PASSWORD_HASH`, demo mode off, and a fully configured chain.

## Honest scope

This is a hackathon-grade reference implementation. Contracts are unaudited, the KYC provider is a mock, and the legal wrapper that makes a tokenised asset a real investment is off-chain work. See **[IMPROVEMENTS.md](IMPROVEMENTS.md)** for the exact trust model and a numbered limitations list.
