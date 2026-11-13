// Deploys the full Tessera contract suite to the network in CHAIN_RPC_URL.
//   DEPLOYER_PRIVATE_KEY=0x... CHAIN_RPC_URL=https://... ATTESTOR_PRIVATE_KEY=0x... node scripts/deploy.js
// Prints the lines to paste into config/local.js. On a real network set STABLECOIN_ADDRESS to an existing
// stablecoin; otherwise a MockStablecoin (testnet only!) is deployed.
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const art = (n) => JSON.parse(fs.readFileSync(path.join(root, 'artifacts', `${n}.json`), 'utf8'));

export async function deployAll(signer, { attestor, custodian = null, stablecoin = null, feeBps = 100, feeRecipient = null } = {}) {
  const owner = await signer.getAddress();
  const dep = async (n, ...a) => { const f = art(n); const c = await new ethers.ContractFactory(f.abi, f.bytecode, signer).deploy(...a); await c.waitForDeployment(); return c; };
  const stable = stablecoin ? new ethers.Contract(stablecoin, art('MockStablecoin').abi, signer) : await dep('MockStablecoin');
  const registry = await dep('ComplianceRegistry', attestor, owner);
  const factory = await dep('AssetFactory', await registry.getAddress(), await stable.getAddress(), owner);
  const market = await dep('RWAMarketplace', await factory.getAddress(), await stable.getAddress(), await registry.getAddress(), owner, feeBps, feeRecipient ?? owner);
  const anchor = await dep('AuditAnchor', owner);
  // Proof of backing: the custodian signs attestations; the marketplace halts buying when one reports a shortfall.
  const backing = await dep('BackingOracle', custodian ?? attestor, owner);
  await (await market.setBackingOracle(await backing.getAddress())).wait();
  return { stable, registry, factory, market, anchor, backing, addresses: {
    BACKING_ADDRESS: await backing.getAddress(),
    TOKEN_ADDRESS: await stable.getAddress(), REGISTRY_ADDRESS: await registry.getAddress(), FACTORY_ADDRESS: await factory.getAddress(),
    MARKET_ADDRESS: await market.getAddress(), ANCHOR_ADDRESS: await anchor.getAddress() } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { CHAIN_RPC_URL, DEPLOYER_PRIVATE_KEY, ATTESTOR_PRIVATE_KEY, STABLECOIN_ADDRESS, CUSTODIAN_ADDRESS } = process.env;
  if (!CHAIN_RPC_URL || !DEPLOYER_PRIVATE_KEY || !ATTESTOR_PRIVATE_KEY) { console.error('Set CHAIN_RPC_URL, DEPLOYER_PRIVATE_KEY and ATTESTOR_PRIVATE_KEY.'); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(CHAIN_RPC_URL);
  const signer = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  const block = await provider.getBlockNumber();
  const { addresses } = await deployAll(signer, { attestor: new ethers.Wallet(ATTESTOR_PRIVATE_KEY).address, custodian: CUSTODIAN_ADDRESS || null, stablecoin: STABLECOIN_ADDRESS || null });
  console.log('\n# paste into config/local.js (as process.env.X = "...") or .env');
  for (const [k, v] of Object.entries(addresses)) console.log(`${k}=${v}`);
  console.log(`CHAIN_START_BLOCK=${block}`);
}
