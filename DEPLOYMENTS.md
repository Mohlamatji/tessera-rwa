# Public testnet deployment record

The track requires a token deployed on a **public testnet**. Fill this in after you deploy; judges will look for it.
Use testnet-only keys and never commit a private key (`config/local.js` and `.env` are gitignored).

## 1. Get test funds
- Test ETH for gas on Base Sepolia (or your chosen network): Chainlink faucets (faucets.chain.link) or another Base Sepolia faucet.

## 2. Deploy
```bash
node chain/scripts/generate-attestor-key.js          # signs KYC claims only, holds no funds
cd chain
CHAIN_RPC_URL=https://sepolia.base.org DEPLOYER_PRIVATE_KEY=0x... ATTESTOR_PRIVATE_KEY=0x... node scripts/deploy.js
cd .. && cp config/local.js.example config/local.js  # paste the printed addresses + attestor key
npm start
```
Then run the seed/operator flow to issue the sample assets (or use the Operator console), attest backing, and run one purchase end to end.

## 3. Record the result

| Item | Value |
|---|---|
| Network / chain id | _TODO_ |
| ComplianceRegistry | _TODO_ |
| AssetFactory | _TODO_ |
| RWAMarketplace | _TODO_ |
| BackingOracle | _TODO_ |
| AuditAnchor | _TODO_ |
| Settlement token (mock stablecoin) | _TODO_ |
| First asset token (symbol / address) | _TODO_ |
| Explorer link to a purchase transaction | _TODO_ |
| Explorer link to the shortfall-halt demo (reverted buy) | _TODO_ |

## 4. Verify
- Asset page → *Documents & evidence* shows "dossier verified" and links to the contract on the explorer.
- Marketplace badge shows **✓ Backing attested**; simulate a shortfall and confirm Buy is disabled and the contract reverts.
