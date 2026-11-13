// Explain WHY a transaction failed on the local demo chain.
// Usage:  node chain\scripts\why.mjs              -> finds and explains the most recent failed transactions (no hash needed)
//         node chain\scripts\why.mjs 0xTxHash      -> explains one specific transaction
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const hash = process.argv[2];
if (hash && !/^0x[0-9a-fA-F]{64}$/.test(hash)) { console.error('That is not a transaction hash (it should be 0x followed by 64 characters). Run without a hash to find recent failures automatically:  node chain\\scripts\\why.mjs'); process.exit(1); }
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
const frags = new Map();
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  for (const fr of ethers.Interface.from(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).abi).fragments) { if (['function', 'error', 'event'].includes(fr.type)) frags.set(fr.type + fr.format('sighash'), fr); }
}
const iface = new ethers.Interface([...frags.values()]);
const rpc = process.env.CHAIN_RPC_URL || `http://127.0.0.1:${process.env.RPC_PORT || 8545}`;
const provider = new ethers.JsonRpcProvider(rpc, 31337, { staticNetwork: true });

async function explain(hash) {
  const tx = await provider.getTransaction(hash), rc = await provider.getTransactionReceipt(hash);
  if (!tx) { console.log('Transaction not found on this chain. Did you restart `npm run demo`? A restart wipes the chain and old hashes disappear.'); return; }
  if (!rc) { console.log('Transaction is still pending (not mined yet).'); return; }
  let fn = tx.data.slice(0, 10); try { fn = iface.parseTransaction({ data: tx.data }).signature; } catch { /* unknown */ }
  console.log(`Hash: ${hash}\nStatus: ${rc.status === 1 ? 'SUCCESS' : 'FAILED'}   Function: ${fn}\nFrom: ${tx.from}\nTo:   ${tx.to}\nGas used ${rc.gasUsed} of limit ${tx.gasLimit}`);
  if (rc.status === 1) return;
  if (rc.gasUsed >= (tx.gasLimit * 98n) / 100n) console.log('\nLikely cause: OUT OF GAS (the wallet set a gas limit that was too low). Retry and in MetaMask raise the gas limit, or reject and click the button again.');
  try {
    await provider.call({ from: tx.from, to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit }, rc.blockNumber - 1);
    console.log('\nReplaying the call on the previous block does NOT revert, so this was not a normal contract rule. Check for out-of-gas above, or restart `npm run demo` and retry from a fresh page load.');
  } catch (e) {
    const data = e.data || (e.info && e.info.error && e.info.error.data) || '';
    let why = null;
    if (typeof data === 'string' && data.length >= 10) { try { const p = iface.parseError(data); why = `${p.name}(${p.args.map(String).join(', ')})`; } catch { /* not a known custom error */ } }
    console.log('\nRevert reason: ' + (why || e.reason || e.shortMessage || e.message));
  }
}

try {
  if (hash) { await explain(hash); process.exit(0); }
  // No hash given: walk back through recent blocks and explain the latest failed transactions.
  const head = await provider.getBlockNumber(), failed = [];
  for (let n = head; n >= Math.max(0, head - 300) && failed.length < 3; n--) {
    const b = await provider.getBlock(n);
    for (const h of [...(b?.transactions || [])].reverse()) { const rc = await provider.getTransactionReceipt(h); if (rc && rc.status === 0) failed.push(h); if (failed.length >= 3) break; }
  }
  if (!failed.length) console.log(`No failed transactions in the last ${Math.min(head, 300)} blocks (chain is at block ${head}). If MetaMask said "failed", the demo may have been restarted since, or MetaMask is pointed at a different network.`);
  for (const h of failed) { await explain(h); console.log('\n' + '-'.repeat(60) + '\n'); }
} catch (e) { console.error('Could not reach the local chain. Is `npm run demo` running? ', e.shortMessage || e.message); process.exit(1); }
