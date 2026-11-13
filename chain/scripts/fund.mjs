// Send test ETH on the LOCAL demo chain to any address (e.g. your MetaMask "Account 1").
// Usage (while `npm run demo` is running):  node chain/scripts/fund.mjs 0xYourAddress [amountEth]
// Uses the demo's built-in funded `operator` account. Local chain only - these keys are public test keys.
import { ethers } from 'ethers';

const to = process.argv[2], amount = process.argv[3] || '10';
if (!to || !ethers.isAddress(to)) { console.error('Usage: node chain/scripts/fund.mjs 0xYourFullAddress [amountEth]'); process.exit(1); }
const rpc = process.env.CHAIN_RPC_URL || `http://127.0.0.1:${process.env.RPC_PORT || 8545}`;
const provider = new ethers.JsonRpcProvider(rpc, 31337, { staticNetwork: true });
const funder = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('tessera-demo-operator')), provider);
try {
  const tx = await funder.sendTransaction({ to, value: ethers.parseEther(amount) });
  await tx.wait();
  console.log(`Sent ${amount} test ETH to ${ethers.getAddress(to)}. New balance: ${ethers.formatEther(await provider.getBalance(to))} ETH`);
} catch (e) { console.error('Failed. Is `npm run demo` still running? ', e.shortMessage || e.message); process.exit(1); }
