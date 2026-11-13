// End-to-end for the hackathon RWA controls: proof of backing (halts buying on a shortfall) and cash-out to mobile money.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { deployAll, art } from '../scripts/deploy.js';
import { api, login, onboard, createAsset, SAMPLE_ASSETS } from '../scripts/seed.js';

const RPC_PORT = 20000 + Math.floor(Math.random() * 20000);
const names = ['operator', 'attestor', 'issuer', 'alice', 'bob', 'custodian', 'offramp'];
const W = Object.fromEntries(names.map((n) => [n, ethers.Wallet.createRandom()]));
const Z = (n) => BigInt(Math.round(n * 1e6));
let chain, server, base, S, d, tower, token, listingId;

before(async () => {
  chain = ganache.server({ logging: { quiet: true }, chain: { chainId: 31337 }, wallet: { accounts: names.map((n) => ({ secretKey: W[n].privateKey, balance: '0x' + (10n ** 21n).toString(16) })) } });
  await chain.listen(RPC_PORT);
  const rpc = `http://127.0.0.1:${RPC_PORT}`, provider = new ethers.JsonRpcProvider(rpc, 31337, { staticNetwork: true });
  S = Object.fromEntries(names.map((n) => [n, new ethers.NonceManager(W[n].connect(provider))]));
  d = await deployAll(S.operator, { attestor: W.attestor.address, custodian: W.custodian.address, feeBps: 100, feeRecipient: W.operator.address });
  Object.assign(process.env, { CHAIN_ENABLED: '1', CHAIN_ID: '31337', CHAIN_RPC_URL: rpc, ATTESTOR_PRIVATE_KEY: W.attestor.privateKey, CUSTODIAN_PRIVATE_KEY: W.custodian.privateKey,
    OFFRAMP_ADDRESS: W.offramp.address, PAYOUT_SETTLE_SECONDS: '1', ...d.addresses, DB_SQLITE_PATH: ':memory:', APP_ENV: 'development', INDEX_INTERVAL_MS: '3600000' });
  const { startServer } = await import('../../public/index.js');
  const s = await startServer({ port: 0 });
  server = s.server; base = `http://localhost:${s.port}`;
  for (const n of ['alice', 'bob']) await (await d.stable.connect(S.operator).mint(W[n].address, Z(5_000_000))).wait();
  await (await d.stable.connect(S.operator).mint(W.issuer.address, Z(1_000_000))).wait();
  const { price, ...spec } = SAMPLE_ASSETS[0];
  tower = await createAsset(base, d.factory.connect(S.operator), { ...spec, issuer: W.issuer.address });
  token = new ethers.Contract(tower.address, art('AssetToken').abi, S.issuer);
});
after(async () => { await new Promise((r) => server.close(r)); await chain.close(); });

const relay = async (p) => { const a = p.attestation; return (await d.backing.connect(S.operator).submit([a.asset, a.backedShares, a.asOf, a.validUntil, a.evidenceHash, a.nonce], p.signature)).wait(); };

test('config advertises backing + cash-out and still exposes no secrets', async () => {
  const c = (await api(base, '/api/chain/config')).data;
  assert.equal(c.backing.enabled, true); assert.equal(c.backing.mock_custodian, true);
  assert.equal(c.cashout.enabled, true); assert.equal(c.cashout.simulated, true);
  assert.ok(!JSON.stringify(c).includes(W.custodian.privateKey) && !JSON.stringify(c).includes(W.attestor.privateKey));
});

test('proof of backing: unattested -> backed -> shortfall (buying reverts, UI state flips) -> restored', async () => {
  assert.equal((await api(base, `/api/market/assets/${tower.address}`)).data.backing.state, 'unattested');
  await (await token.approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
  await (await d.market.connect(S.issuer).list(tower.address, 100_000n, Z(10))).wait();
  listingId = (await d.market.nextListingId()) - 1n;
  await (await d.stable.connect(S.alice).approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
  await onboard(base, S.alice, d.registry, {});

  let p = (await api(base, '/api/admin/backing/prepare', { method: 'POST', body: { asset: tower.address, mode: 'full' } })).data;
  assert.equal(p.mock_custodian, true);
  await relay(p);
  let b = (await api(base, `/api/market/assets/${tower.address}`)).data.backing;
  assert.equal(b.state, 'backed'); assert.equal(b.coverage_bps, 10_000);
  await (await d.market.connect(S.alice).buy(listingId, 5n)).wait();

  p = (await api(base, '/api/admin/backing/prepare', { method: 'POST', body: { asset: tower.address, mode: 'shortfall' } })).data;
  await relay(p);
  b = (await api(base, `/api/market/assets/${tower.address}`)).data.backing;
  assert.equal(b.state, 'shortfall'); assert.equal(b.coverage_bps, 9000);
  assert.equal((await api(base, '/api/market/assets')).data.assets.find((a) => a.address === tower.address.toLowerCase()).backing_state, 'shortfall');
  await assert.rejects(d.market.connect(S.alice).buy.staticCall(listingId, 5n), (e) => {
    const name = e.revert?.name ?? d.market.interface.parseError(e.data)?.name;
    assert.equal(name, 'BackingShortfall'); return true;
  });

  p = (await api(base, '/api/admin/backing/prepare', { method: 'POST', body: { asset: tower.address, mode: 'full' } })).data;
  await relay(p);
  await (await d.market.connect(S.alice).buy(listingId, 5n)).wait();
});

test('backing endpoint refuses bad input and a forged attestation is rejected by the contract', async () => {
  assert.equal((await api(base, '/api/admin/backing/prepare', { method: 'POST', body: { asset: tower.address, mode: 'nonsense' } })).status, 422);
  assert.equal((await api(base, '/api/admin/backing/prepare', { method: 'POST', body: { asset: '0x123', mode: 'full' } })).status, 422);
  const p = (await api(base, '/api/admin/backing/prepare', { method: 'POST', body: { asset: tower.address, mode: 'full' } })).data;
  const a = p.attestation;
  const forged = await W.alice.signTypedData({ name: 'TesseraBacking', version: '1', chainId: 31337, verifyingContract: d.addresses.BACKING_ADDRESS },
    { Attestation: [{ name: 'asset', type: 'address' }, { name: 'backedShares', type: 'uint256' }, { name: 'asOf', type: 'uint64' }, { name: 'validUntil', type: 'uint64' }, { name: 'evidenceHash', type: 'bytes32' }, { name: 'nonce', type: 'uint64' }] }, a);
  await assert.rejects(d.backing.connect(S.operator).submit.staticCall([a.asset, a.backedShares, a.asOf, a.validUntil, a.evidenceHash, a.nonce], forged));
});

test('cash-out: verified investor sends mZAR to the off-ramp, gets a (simulated) mobile-money payout; the amount comes from the chain', async () => {
  const token_ = await login(base, S.alice);
  const stable = d.stable.connect(S.alice), to = W.offramp.address;
  const sent = Z(1000);
  const tx = await (await stable.transfer(to, sent)).wait();

  // validation
  assert.equal((await api(base, '/api/payouts', { method: 'POST', token: token_, body: { tx_hash: tx.hash, msisdn: '0821234567', network: 'MTN MoMo' } })).status, 422, 'international format required');
  assert.equal((await api(base, '/api/payouts', { method: 'POST', token: token_, body: { tx_hash: tx.hash, msisdn: '+27821234567', network: 'Nope' } })).status, 422);
  assert.equal((await api(base, '/api/payouts', { method: 'POST', body: { tx_hash: tx.hash } })).status, 401);

  const r = await api(base, '/api/payouts', { method: 'POST', token: token_, body: { tx_hash: tx.hash, msisdn: '+27821234567', network: 'MTN MoMo', amount: '999999999' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.amount, sent.toString(), 'amount read from the chain, a client-supplied amount is ignored');
  assert.equal(r.data.fee, ((sent * 150n) / 10_000n).toString());
  assert.equal(BigInt(r.data.net) + BigInt(r.data.fee), sent);
  assert.ok(r.data.to.endsWith('4567') && !r.data.to.includes('821234'), 'phone number is masked');
  assert.equal(r.data.simulated, true); assert.match(r.data.reference, /^SIM-/);

  assert.equal((await api(base, '/api/payouts', { method: 'POST', token: token_, body: { tx_hash: tx.hash, msisdn: '+27821234567', network: 'MTN MoMo' } })).status, 409, 'a transfer pays out once');
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal((await api(base, '/api/payouts', { token: token_ })).data.payouts[0].status, 'paid');
});

test('cash-out refuses: someone else\'s transfer, a transfer to the wrong address, and unverified wallets', async () => {
  const alice = await login(base, S.alice);
  const bobTx = await (await d.stable.connect(S.bob).transfer(W.offramp.address, Z(500))).wait();
  const stolen = await api(base, '/api/payouts', { method: 'POST', token: alice, body: { tx_hash: bobTx.hash, msisdn: '+27821234567', network: 'MTN MoMo' } });
  assert.equal(stolen.status, 422, "Alice cannot claim Bob's transfer");
  const wrongTo = await (await d.stable.connect(S.alice).transfer(W.bob.address, Z(500))).wait();
  assert.equal((await api(base, '/api/payouts', { method: 'POST', token: alice, body: { tx_hash: wrongTo.hash, msisdn: '+27821234567', network: 'MTN MoMo' } })).status, 422);
  const bob = await login(base, S.bob); // bob never completed KYC
  assert.equal((await api(base, '/api/payouts', { method: 'POST', token: bob, body: { tx_hash: bobTx.hash, msisdn: '+27821234567', network: 'MTN MoMo' } })).status, 403);
  const tiny = await (await d.stable.connect(S.alice).transfer(W.offramp.address, Z(1))).wait();
  assert.equal((await api(base, '/api/payouts', { method: 'POST', token: alice, body: { tx_hash: tiny.hash, msisdn: '+27821234567', network: 'MTN MoMo' } })).status, 422, 'below the minimum');
});
