// Keeper bot: pushes pending yield to every holder (claimFor), so investors don't have to claim by hand.
//   CHAIN_RPC_URL=... KEEPER_PRIVATE_KEY=0x... FACTORY_ADDRESS=0x... node scripts/keeper.js
// The keeper only pays gas. claimFor can only ever send money to the holder - never to the keeper.
import { ethers } from 'ethers';
import { fileURLToPath } from 'node:url';
import { art } from './deploy.js';

export async function runKeeper(signer, factoryAddress, { minPending = 1n } = {}) {
  const factory = new ethers.Contract(factoryAddress, art('AssetFactory').abi, signer);
  const paid = [];
  for (let i = 0n, n = await factory.assetCount(); i < n; i++) {
    const asset = new ethers.Contract(await factory.assets(i), art('AssetToken').abi, signer);
    const holders = new Set();
    for (const l of await asset.queryFilter(asset.filters.Transfer())) holders.add(l.args.to);
    holders.delete(ethers.ZeroAddress);
    for (const h of holders) {
      const pending = await asset.pendingYield(h);
      if (pending < minPending) continue;
      try { await (await asset.claimFor(h)).wait(); paid.push({ asset: await asset.getAddress(), holder: h, amount: pending }); }
      catch (e) { console.warn(`skip ${h}: ${e.shortMessage || e.message}`); } // e.g. frozen wallet
    }
  }
  return paid;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { CHAIN_RPC_URL, KEEPER_PRIVATE_KEY, FACTORY_ADDRESS } = process.env;
  if (!CHAIN_RPC_URL || !KEEPER_PRIVATE_KEY || !FACTORY_ADDRESS) { console.error('Set CHAIN_RPC_URL, KEEPER_PRIVATE_KEY, FACTORY_ADDRESS.'); process.exit(1); }
  const signer = new ethers.Wallet(KEEPER_PRIVATE_KEY, new ethers.JsonRpcProvider(CHAIN_RPC_URL));
  const paid = await runKeeper(signer, FACTORY_ADDRESS);
  console.log(`Paid ${paid.length} holder(s).`);
}
