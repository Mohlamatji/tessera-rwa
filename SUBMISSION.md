# Tessera - Hackathon Submission

**One-liner:** Fractional real-world assets with compliance built into the token: KYC/AML-gated shares, automatic on-chain yield, instant secondary liquidity.

## Problem
Commercial property, private credit and solar projects are illiquid and ticket sizes are huge. Retail investors are locked out; sellers can't exit. Existing tokenisation demos either ignore compliance (so can't be legal) or bolt it on in a centralised database (so can't be trusted).

## Solution
- **Compliance in the token.** A `ComplianceRegistry` holds only `{tier, expiry, opaque decisionId}` per wallet. Every `AssetToken` transfer checks it - on our marketplace, a DEX, or a direct send.
- **Explainable KYC/AML.** Hard gates (adult, identity, sanctions, jurisdiction) that no score can override; soft flags (PEP, high-risk country, missing source of funds, provider outage) route to a human; named, weighted factors. Applicants never learn *why* a sanctions screen failed.
- **Yield that just works.** Issuer deposits income once; O(1) gas, exact per share, correct across transfers; holders claim or a keeper pushes.
- **Instant liquidity.** Non-custodial atomic order book; shares keep earning yield while listed.
- **Proof of backing.** A custodian signs how many shares are backed; the marketplace halts buying if the reserve falls short. Demo the failure case live.
- **Freeze and recover.** Owner-only `forcedTransfer` / `recoverWallet` for court orders and lost keys - to KYC-eligible wallets only.
- **Path back to cash.** Stablecoin yield and a cash-out flow to mobile money *(payout provider simulated - see HACKATHON.md for what is mocked and who we would partner with)*.
- **Provable audit trail.** Hash-chained log, Merkle-rooted on-chain; a public page re-verifies proofs in the browser.
- **Privacy by design.** No personal data on-chain; encrypted off-chain; export/erase endpoints (POPIA/GDPR).

## Tech
Solidity 0.8.26 + OpenZeppelin 5.0 · ethers v6 (EIP-712 claims, event indexer, receipts) · Node 22 (zero-framework HTTP, `node:sqlite`) · vanilla JS + Tailwind wallet UI (MetaMask/EIP-1193) · ganache for tests.

## Verification
Automated tests across unit/prod-safety (incl. wallet-error handling), contract-level, and end-to-end (real HTTP server + real EVM + wallet-signed flows, including a tamper-and-rehash attack caught by the on-chain anchor).

## 3-minute demo script
1. `npm run demo`; open the marketplace - three assets with pictures, live prices, yield stats and a **✓ Backing attested** badge.
2. As **Alice** (verified): buy shares → wallet signs approve + atomic buy → portfolio shows her holding and **claim** her rent.
3. As a **new wallet**: try to buy → reverts (unverified). Do **Get verified** → *Register on-chain* → buy succeeds. *(Failure case 1.)*
4. **Operator → Proof of backing → "Simulate 10% reserve shortfall"** → refresh the asset page: red banner, **Buy** disabled, and the contract itself reverts `BackingShortfall`. Attest fully backed → trading resumes. *(Failure case 2: the strongest moment.)*
5. **Operator**: **freeze** Alice → her next transfer reverts → **Recover wallet** to a new verified wallet. *(Failure case 3: lost keys / court order.)* Then **anchor** the audit log.
6. **Portfolio → Cash out to mobile money**: send mZAR to the off-ramp and watch the payout go *processing → paid* (clearly labelled simulated).
7. **Asset page → Documents & evidence**, then the **Verify** page: paste Alice's receipt → ✓ genuine · ✓ registered on-chain · ✓ Merkle proof checked in your browser.
8. Flex: edit a row in the DB and re-hash the chain - verification still fails against the on-chain root.

## What's next
ERC-3643 identity + forced transfer, real KYC vendor + liveness, RFQ for large blocks, appraiser-signed NAV updates, subgraph indexing. See IMPROVEMENTS.md.
