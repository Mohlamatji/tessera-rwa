import ganache from 'ganache';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const projectRoot = path.resolve(root, '..');
export const artifact = (name) => JSON.parse(fs.readFileSync(path.join(root, 'artifacts', `${name}.json`), 'utf8'));

// Accounts are local ethers Wallets (they sign typed data locally - ganache's own signer doesn't
// implement eth_signTypedData_v4 the way ethers calls it) funded on an in-process ganache chain.
export function makeChain(n = 9) {
  const wallets = Array.from({ length: n }, () => ethers.Wallet.createRandom());
  const provider = new ethers.BrowserProvider(ganache.provider({
    logging: { quiet: true }, chain: { chainId: 31337 },
    wallet: { accounts: wallets.map((w) => ({ secretKey: w.privateKey, balance: '0x' + (10n ** 21n).toString(16) })) },
  }));
  return { provider, signers: wallets.map((w) => new ethers.NonceManager(new ethers.Wallet(w.privateKey, provider))), wallets };
}
export async function deploy(name, signer, ...args) {
  const a = artifact(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

export const CLAIM_TYPES = { KycClaim: [
  { name: 'decisionId', type: 'bytes32' }, { name: 'wallet', type: 'address' },
  { name: 'tier', type: 'uint8' }, { name: 'expiry', type: 'uint64' } ] };
export const claimDomain = (chainId, verifyingContract) => ({ name: 'TesseraCompliance', version: '1', chainId, verifyingContract });
export const ZAR = (n) => BigInt(Math.round(n * 1e6)); // mZAR has 6 decimals

let shared = null; // one chain + one deployment per test file; each test starts from an evm snapshot

/** owner, attestor, issuer, alice(retail), bob(accredited), carol(retail), mallory(never KYC'd), treasury */
export async function setup() {
  if (!shared) {
    const { provider, wallets } = makeChain();
    const signers = wallets.map((w) => new ethers.NonceManager(new ethers.Wallet(w.privateKey, provider)));
    const [owner, attestor] = signers;
    const stable = await deploy('MockStablecoin', owner);
    const registry = await deploy('ComplianceRegistry', owner, await attestor.getAddress(), await owner.getAddress());
    const factory = await deploy('AssetFactory', owner, await registry.getAddress(), await stable.getAddress(), await owner.getAddress());
    const market = await deploy('RWAMarketplace', owner, await factory.getAddress(), await stable.getAddress(), await registry.getAddress(), await owner.getAddress(), 100, await signers[7].getAddress());
    const anchor = await deploy('AuditAnchor', owner, await owner.getAddress());
    shared = { provider, wallets, addrs: { stable: await stable.getAddress(), registry: await registry.getAddress(), factory: await factory.getAddress(), market: await market.getAddress(), anchor: await anchor.getAddress() }, snap: null, kycIssuer: false };
    const ctx0 = build();
    await kyc(ctx0, ctx0.issuer, 2); // the issuer is a verified entity too (it must be able to list)
    shared.snap = await provider.send('evm_snapshot', []);
  } else {
    await shared.provider.send('evm_revert', [shared.snap]);
    shared.snap = await shared.provider.send('evm_snapshot', []);
  }
  const ctx = build();
  ctx.now = (await ctx.provider.getBlock('latest')).timestamp;
  return ctx;
}

// Fresh NonceManagers + contract handles every time: a revert rolls nonces back, a stale cache would not.
function build() {
  const { provider, wallets, addrs } = shared;
  const signers = wallets.map((w) => new ethers.NonceManager(new ethers.Wallet(w.privateKey, provider)));
  const [owner, attestor, issuer, alice, bob, carol, mallory, treasury] = signers;
  const at = (n, a) => new ethers.Contract(a, artifact(n).abi, owner);
  return { provider, owner, attestor, issuer, alice, bob, carol, mallory, treasury, wallets, addrs,
    stable: at('MockStablecoin', addrs.stable), registry: at('ComplianceRegistry', addrs.registry), factory: at('AssetFactory', addrs.factory),
    market: at('RWAMarketplace', addrs.market), anchor: at('AuditAnchor', addrs.anchor), now: Math.floor(Date.now() / 1000) };
}

export async function claimFor(ctx, who, tier = 1, over = {}) {
  const c = {
    decisionId: ethers.keccak256(ethers.toUtf8Bytes('dec_' + Math.random())), wallet: await who.getAddress(),
    tier, expiry: (await ctx.provider.getBlock('latest')).timestamp + 365 * 86400, ...over,
  };
  const sig = await ctx.wallets[1].signTypedData(claimDomain(31337, await ctx.registry.getAddress()), CLAIM_TYPES, c);
  return { c, sig };
}
export async function kyc(ctx, who, tier = 1, over = {}) {
  const { c, sig } = await claimFor(ctx, who, tier, over);
  await (await ctx.registry.connect(who).register(c, sig)).wait();
  return c;
}

/** Creates an asset with 1,000,000 shares at issuer. Returns the AssetToken contract. */
export async function createAsset(ctx, over = {}) {
  const p = { name: 'Sandton Tower A', symbol: 'SNDA', issuer: await ctx.issuer.getAddress(), totalShares: 1_000_000n, assetClass: 0,
    minTier: 1, maxHolderBps: 0, documentHash: ethers.keccak256(ethers.toUtf8Bytes('deed+valuation')), documentURI: 'ipfs://deed', ...over };
  const rc = await (await ctx.factory.createAsset(p)).wait();
  const ev = rc.logs.map((l) => { try { return ctx.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'AssetCreated');
  const a = artifact('AssetToken');
  return new ethers.Contract(ev.args.asset, a.abi, ctx.provider);
}

// staticCall (eth_call) makes ganache return the revert data; a real tx would revert identically.
// Errors bubbling up from a nested call (marketplace -> share token) aren't in the outer ABI, so decode against every contract ABI.
const ifaces = () => ['AssetToken', 'ComplianceRegistry', 'RWAMarketplace', 'AssetFactory', 'AuditAnchor', 'BackingOracle'].map((n) => new ethers.Interface(artifact(n).abi));
function revertName(e) {
  if (e.revert?.name) return e.revert.name;
  if (typeof e.data === 'string' && e.data.length >= 10) {
    for (const i of ifaces()) { try { const d = i.parseError(e.data); if (d) return d.name; } catch { /* next */ } }
  }
  return null;
}
export const reverts = async (p, name) => {
  await assert.rejects(p, (e) => { assert.equal(revertName(e), name, `expected revert ${name}, got ${revertName(e) ?? e.shortMessage ?? e.message}`); return true; });
};
export const mine = async (provider, seconds) => { await provider.send('evm_increaseTime', [seconds]); await provider.send('evm_mine', []); };
export const fund = async (ctx, who, amountZar, spender) => {
  await (await ctx.stable.connect(ctx.owner).mint(await who.getAddress(), ZAR(amountZar))).wait();
  if (spender) await (await ctx.stable.connect(who).approve(spender, ethers.MaxUint256)).wait();
};
