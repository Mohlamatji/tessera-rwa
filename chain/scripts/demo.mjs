// One command demo: local chain + contracts + server + seeded marketplace.   npm run demo   (from the project root)
import ganache from 'ganache';
import { ethers } from 'ethers';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deployAll, art } from './deploy.js';
import { api, onboard, createAsset, SAMPLE_ASSETS } from './seed.js';
import { SaId } from '../../app/Support/SaId.js';
import { Eth } from '../../app/Support/Eth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 8000), RPC_PORT = Number(process.env.RPC_PORT || 8545);
const key = (n) => ethers.keccak256(ethers.toUtf8Bytes('tessera-demo-' + n));
const names = ['operator', 'attestor', 'issuer', 'alice', 'bob', 'carol', 'custodian'];
const wallets = Object.fromEntries(names.map((n) => [n, new ethers.Wallet(key(n))]));

const chain = ganache.server({ logging: { quiet: true }, chain: { chainId: 31337 },
  wallet: { accounts: names.map((n) => ({ secretKey: wallets[n].privateKey, balance: '0x' + (10n ** 21n).toString(16) })) } });
await chain.listen(RPC_PORT);
const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
const provider = new ethers.JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true });
const S = Object.fromEntries(names.map((n) => [n, new ethers.NonceManager(wallets[n].connect(provider))]));

console.log('Deploying contracts…');
const d = await deployAll(S.operator, { attestor: wallets.attestor.address, custodian: wallets.custodian.address, feeBps: 100, feeRecipient: wallets.operator.address });
const dbFile = path.join(root, 'storage', 'demo.sqlite');
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
Object.assign(process.env, { CHAIN_ENABLED: '1', CHAIN_NAME: 'Local demo chain', CHAIN_ID: '31337', CHAIN_RPC_URL: rpcUrl, ATTESTOR_PRIVATE_KEY: wallets.attestor.privateKey,
  CUSTODIAN_PRIVATE_KEY: wallets.custodian.privateKey,   // MOCK custodian: in production the real custodian signs on its own systems
  OFFRAMP_ADDRESS: wallets.operator.address,             // stands in for a licensed off-ramp partner's treasury (cash-out is simulated)
  ...d.addresses, DB_SQLITE_PATH: dbFile, PORT: String(PORT), APP_ENV: 'development' });

const { startServer } = await import('../../public/index.js');
await startServer({ port: PORT });
const base = `http://localhost:${PORT}`;

console.log('Seeding: investors, assets, listings, yield…');
const registry = d.registry, market = d.market, stable = d.stable;
for (const n of ['alice', 'bob', 'carol']) await (await stable.connect(S.operator).mint(wallets[n].address, 2_000_000n * 10n ** 6n)).wait();
await (await stable.connect(S.operator).mint(wallets.issuer.address, 5_000_000n * 10n ** 6n)).wait();
const alice = await onboard(base, S.alice, registry, { full_name: 'Alice Investor' });
const bob = await onboard(base, S.bob, registry, { full_name: 'Bob Accredited', dob: '1982-03-02', id_number: SaId.make('1982-03-02', 5010), investor_type: 'accredited',
  accreditation: { net_worth_cents: 900_000_000, annual_income_cents: 0, evidence_ref: 'evd_demo_bob' }, intended_investment_cents: 20_000_000 });
console.log(`  alice: ${alice.decision.status}, bob: ${bob.decision.status} (tier ${bob.decision.tier})`);

const assets = [];
for (const s of SAMPLE_ASSETS) {
  const { price, ...spec } = s;
  const a = await createAsset(base, d.factory.connect(S.operator), { ...spec, issuer: wallets.issuer.address });
  const token = new ethers.Contract(a.address, art('AssetToken').abi, S.issuer);
  await (await token.approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
  await (await market.connect(S.issuer).list(a.address, BigInt(s.total_shares), BigInt(price) * 10n ** 6n)).wait();
  assets.push({ ...a, token, price, symbol: s.symbol });
}
// Proof of backing: the (mock) custodian attests that every share is backed; relayed on-chain by the operator.
for (const [i, a] of assets.entries()) {
  const total = BigInt(await a.token.totalSupply()), now = (await provider.getBlock('latest')).timestamp;
  const att = { asset: a.address, backedShares: total, asOf: now, validUntil: now + 30 * 86400, evidenceHash: Eth.id(`MOCK custodian statement for ${a.symbol}: ${total} shares fully backed`), nonce: 1 };
  await (await d.backing.connect(S.operator).submit(att, await Eth.signAttestation(wallets.custodian.privateKey, 31337, d.addresses.BACKING_ADDRESS, att))).wait();
}
const buy = async (who, asset, n) => {
  await (await stable.connect(who).approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
  await (await market.connect(who).buy(BigInt(assets.indexOf(asset)) + 1n, BigInt(n))).wait();
};
await buy(S.alice, assets[0], 4000); await buy(S.alice, assets[1], 1500); await buy(S.bob, assets[0], 6000); await buy(S.bob, assets[1], 3000); await buy(S.bob, assets[2], 1000);
// rental income for the tower, then Alice lists some shares for resale
await (await stable.connect(S.issuer).approve(assets[0].address, ethers.MaxUint256)).wait();
await (await assets[0].token.connect(S.issuer).depositYield(95_000n * 10n ** 6n, ethers.id('2026-10'))).wait();
await (await assets[0].token.connect(S.alice).approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
await (await market.connect(S.alice).list(assets[0].address, 500n, 10_400_000n)).wait();
await api(base, '/api/market/sync', { method: 'POST' });

console.log(`
╔══════════════════════════════════════════════════════════════════════╗
  Tessera demo is running
    App:        ${base}
    Operator:   ${base}/dashboard   (open in demo mode)
    Chain RPC:  ${rpcUrl}   chain id 31337
╚══════════════════════════════════════════════════════════════════════╝
Import these TEST-ONLY private keys into MetaMask (network: add the RPC above):
  operator  ${wallets.operator.privateKey}   factory owner / fee wallet / anchors audit roots
  issuer    ${wallets.issuer.privateKey}   issues assets, deposits yield
  alice     ${wallets.alice.privateKey}   verified retail investor (holds shares, has yield to claim)
  bob       ${wallets.bob.privateKey}   verified accredited investor
  carol     ${wallets.carol.privateKey}   NOT verified - go through /onboarding as a new investor
(Carol's KYC: use any ID from  node -e "import('./app/Support/SaId.js').then(m=>console.log(m.SaId.make('1995-01-20',5123)))" )
Try the failure cases:
  - a non-KYC wallet can't receive shares (carol, before she completes /onboarding)
  - freeze Alice from the Operator console and watch her transfers revert, then recover her shares to a new wallet
  - Operator console -> "Proof of backing": simulate a custodian SHORTFALL and watch buying halt on that asset, then restore it
  - Portfolio -> "Cash out to mobile money": send mZAR to the (simulated) off-ramp and see the payout reach a phone wallet
  (custodian demo key, MOCK: ${wallets.custodian.privateKey})
Ctrl+C to stop.`);
process.on('SIGINT', () => process.exit(0));
