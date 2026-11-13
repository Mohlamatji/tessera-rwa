// End-to-end: a REAL Tessera server (HTTP) + a REAL EVM chain (ganache over HTTP JSON-RPC) + wallets signing like a browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { deployAll, art } from '../scripts/deploy.js';
import { api, login, onboard, createAsset, profile, SAMPLE_ASSETS } from '../scripts/seed.js';
import { runKeeper } from '../scripts/keeper.js';
import { SaId } from '../../app/Support/SaId.js';

const RPC_PORT = 20000 + Math.floor(Math.random() * 20000);
const names = ['operator', 'attestor', 'issuer', 'alice', 'bob', 'carol', 'alice2', 'keeper', 'dave', 'erin', 'frank', 'gina', 'hank'];
const W = Object.fromEntries(names.map((n) => [n, ethers.Wallet.createRandom()]));
const Z = (n) => BigInt(Math.round(n * 1e6));
let chain, server, base, S, d, tower, factoryOp, db, getDbFn;
const lc = (w) => w.address.toLowerCase();

before(async () => {
  chain = ganache.server({ logging: { quiet: true }, chain: { chainId: 31337 }, wallet: { accounts: names.map((n) => ({ secretKey: W[n].privateKey, balance: '0x' + (10n ** 21n).toString(16) })) } });
  await chain.listen(RPC_PORT);
  const rpc = `http://127.0.0.1:${RPC_PORT}`, provider = new ethers.JsonRpcProvider(rpc, 31337, { staticNetwork: true });
  S = Object.fromEntries(names.map((n) => [n, new ethers.NonceManager(W[n].connect(provider))]));
  d = await deployAll(S.operator, { attestor: W.attestor.address, feeBps: 100, feeRecipient: W.operator.address });
  Object.assign(process.env, { CHAIN_ENABLED: '1', CHAIN_ID: '31337', CHAIN_RPC_URL: rpc, ATTESTOR_PRIVATE_KEY: W.attestor.privateKey, ...d.addresses, DB_SQLITE_PATH: ':memory:', APP_ENV: 'development', INDEX_INTERVAL_MS: '3600000' });
  const { startServer } = await import('../../public/index.js');
  const s = await startServer({ port: 0 });
  server = s.server; base = `http://localhost:${s.port}`;
  ({ getDb: getDbFn } = await import('../../config/database.js')); db = getDbFn();
  factoryOp = d.factory.connect(S.operator);
  for (const n of ['alice', 'bob', 'carol', 'alice2']) await (await d.stable.connect(S.operator).mint(W[n].address, Z(5_000_000))).wait();
  await (await d.stable.connect(S.operator).mint(W.issuer.address, Z(1_000_000))).wait();
});
after(async () => { await new Promise((r) => server.close(r)); await chain.close(); });

test('health + chain config are public and expose no secrets', async () => {
  assert.equal((await api(base, '/health')).data.chain, true);
  const c = (await api(base, '/api/chain/config')).data;
  assert.equal(c.registry_address.toLowerCase(), d.addresses.REGISTRY_ADDRESS.toLowerCase());
  assert.equal(c.fee_bps, 100);
  assert.ok(!JSON.stringify(c).includes(W.attestor.privateKey));
});

test('wallet sign-in: a forged signature is refused; a real one yields a session; endpoints need it', async () => {
  const address = lc(W.alice);
  const n = await api(base, '/api/auth/nonce', { method: 'POST', body: { address } });
  const forged = await W.carol.signMessage(n.data.message);
  assert.equal((await api(base, '/api/auth/verify', { method: 'POST', body: { address, signature: forged } })).status, 401);
  const token = await login(base, S.alice);
  assert.ok(token.startsWith('tsr_'));
  assert.equal((await api(base, '/api/kyc/status')).status, 401);
  assert.equal((await api(base, '/api/kyc/status', { token: 'tsr_garbage.sig' })).status, 401);
  // a challenge is single-use
  const sig = await W.alice.signMessage((await api(base, '/api/auth/nonce', { method: 'POST', body: { address } })).data.message);
  assert.equal((await api(base, '/api/auth/verify', { method: 'POST', body: { address, signature: sig } })).status, 200);
  assert.equal((await api(base, '/api/auth/verify', { method: 'POST', body: { address, signature: sig } })).status, 401);
});

test('KYC needs consent first; an approved retail investor gets a signed claim and the response holds no PII', async () => {
  const token = await login(base, S.alice);
  assert.equal((await api(base, '/api/kyc/submit', { method: 'POST', token, body: profile() })).data.code, 'consent_required');
  await api(base, '/api/consent/grant', { method: 'POST', token });
  const k = await api(base, '/api/kyc/submit', { method: 'POST', token, body: profile() });
  assert.equal(k.data.status, 'approved'); assert.equal(k.data.tier, 1);
  assert.ok(k.data.claim.signature.startsWith('0x')); assert.ok(k.data.receipt.startsWith('tsrr_'));
  const body = JSON.stringify(k.data);
  assert.ok(!body.includes('Alice Investor') && !body.includes(profile().id_number));
  const row = db.prepare('SELECT * FROM users').get();                      // PII is encrypted at rest
  assert.ok(!String(row.full_name_enc).includes('Alice') && row.full_name_enc.startsWith('v1.'));
  assert.ok(!JSON.stringify(row).includes(profile().id_number));
});

test('a sanctions hit is rejected without tipping off, and the reason is recorded for analysts', async () => {
  const token = await login(base, S.carol);
  await api(base, '/api/consent/grant', { method: 'POST', token });
  const k = await api(base, '/api/kyc/submit', { method: 'POST', token, body: profile({ full_name: 'Test Sanctioned', id_number: SaId.make('1980-01-01', 5200), dob: '1980-01-01' }) });
  assert.equal(k.data.status, 'rejected'); assert.equal(k.data.claim, undefined);
  assert.ok(!/sanction/i.test(JSON.stringify(k.data)), 'applicant is not told why');
  const admin = (await api(base, '/api/admin/kyc?decision=rejected')).data.decisions[0];
  assert.ok(admin.gates.some((g) => g.code === 'sanctions_clear' && !g.passed));
});

test('bad ID, under-18 and provider outage: rejected with fixable hints, or failed closed to review', async () => {
  const wallet = async (w) => { const t = await login(base, w); await api(base, '/api/consent/grant', { method: 'POST', token: t }); return t; };
  const bad = await api(base, '/api/kyc/submit', { method: 'POST', token: await wallet(S.erin), body: profile({ id_number: '1234567890123' }) });
  assert.equal(bad.data.status, 'rejected'); assert.ok(bad.data.fixable_issues.length);
  const year = new Date().getFullYear() - 10, dob = `${year}-06-01`;
  assert.equal((await api(base, '/api/kyc/submit', { method: 'POST', token: await wallet(S.frank), body: profile({ dob, id_number: SaId.make(dob, 5100) }) })).data.status, 'rejected');
  const out = await api(base, '/api/kyc/submit', { method: 'POST', token: await wallet(S.gina), body: profile({ full_name: 'Provider Outage', id_number: SaId.make('1991-02-03', 5300), dob: '1991-02-03' }) });
  assert.equal(out.data.status, 'review'); assert.equal(out.data.claim, undefined);
});

test('PEP goes to manual review; the analyst approves it; only then is a claim issued', async () => {
  const token = await login(base, S.dave);
  await api(base, '/api/consent/grant', { method: 'POST', token });
  const k = await api(base, '/api/kyc/submit', { method: 'POST', token, body: profile({ full_name: 'Test Politician', id_number: SaId.make('1975-09-09', 5400), dob: '1975-09-09' }) });
  assert.equal(k.data.status, 'review'); assert.equal(k.data.claim, undefined);
  assert.equal((await api(base, `/api/admin/kyc/${k.data.id}/resolve`, { method: 'POST', body: { action: 'nonsense' } })).status, 422);
  assert.equal((await api(base, `/api/admin/kyc/${k.data.id}/resolve`, { method: 'POST', body: { action: 'approve' } })).status, 200);
  const st = (await api(base, '/api/kyc/status', { token })).data;
  assert.equal(st.status, 'approved'); assert.ok(st.claim);
});

test('one wallet cannot be claimed by two different people', async () => {
  const token = await login(base, S.alice);
  const r = await api(base, '/api/kyc/submit', { method: 'POST', token, body: profile({ full_name: 'Somebody Else', id_number: SaId.make('1988-08-08', 5500), dob: '1988-08-08' }) });
  assert.equal(r.status, 409);
});

test('registering on-chain: server verifies the tx itself; fake hashes are refused', async () => {
  const { token, decision } = await onboard(base, S.alice, d.registry, {});     // re-verification of the same person (new decision)
  assert.equal(decision.status, 'approved');
  assert.equal((await api(base, '/api/kyc/registered', { method: 'POST', token, body: { tx_hash: '0x' + '11'.repeat(32) } })).status, 422);
  const st = (await api(base, '/api/kyc/status', { token })).data;
  assert.equal(st.on_chain_tier, 1); assert.equal(st.registered, true);
  assert.equal(await d.registry.tierOf(W.alice.address), 1n);
  // Bob: accredited with evidence -> tier 2; accredited WITHOUT evidence -> approved at tier 1 with a to-do
  const bob = await onboard(base, S.bob, d.registry, { full_name: 'Bob Accredited', dob: '1982-03-02', id_number: SaId.make('1982-03-02', 5010), investor_type: 'accredited', accreditation: { net_worth_cents: 900_000_000, evidence_ref: 'evd_bob' } });
  assert.equal(bob.decision.tier, 2);
  const noEv = await api(base, '/api/kyc/submit', { method: 'POST', token: await (async () => { const t = await login(base, S.hank); await api(base, '/api/consent/grant', { method: 'POST', token: t }); return t; })(), body: profile({ full_name: 'Hank Claimant', dob: '1993-04-04', id_number: SaId.make('1993-04-04', 5600), investor_type: 'accredited', accreditation: { net_worth_cents: 900_000_000 } }) });
  assert.equal(noEv.data.tier, 1); assert.equal(noEv.data.required_action, 'submit_accreditation_evidence');
});

test('operator issues an asset: dossier hash on-chain matches the off-chain dossier', async () => {
  const s = SAMPLE_ASSETS[0], { price, ...spec } = s;
  tower = await createAsset(base, factoryOp, { ...spec, issuer: W.issuer.address });
  const a = (await api(base, `/api/market/assets/${tower.address}`)).data;
  assert.equal(a.name, 'Sandton Office Tower'); assert.equal(a.dossier_verified, true);
  assert.equal(a.document_hash, tower.hash);
  const onchain = await new ethers.Contract(tower.address, art('AssetToken').abi, S.operator).documentHash();
  assert.equal(onchain.toLowerCase(), tower.hash);
});

test('primary + secondary market: trades are indexed, compliance is enforced on-chain, fees flow', async () => {
  const m = d.market, token = new ethers.Contract(tower.address, art('AssetToken').abi, S.issuer);
  await (await token.approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
  await (await m.connect(S.issuer).list(tower.address, 1_000_000n, Z(10))).wait();
  for (const n of ['alice', 'bob', 'carol']) await (await d.stable.connect(S[n]).approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
  const fee0 = await d.stable.balanceOf(W.operator.address);
  await (await m.connect(S.alice).buy(1n, 5_000n)).wait();
  await (await m.connect(S.bob).buy(1n, 10_000n)).wait();
  assert.equal(await d.stable.balanceOf(W.operator.address) - fee0, Z(1500) , 'protocol fee = 1% of R150,000');
  // carol never completed KYC on-chain -> the TOKEN refuses her, the trade reverts
  await assert.rejects(m.connect(S.carol).buy.staticCall(1n, 10n));
  await api(base, '/api/market/sync', { method: 'POST' });
  const a = (await api(base, `/api/market/assets/${tower.address}`)).data;
  assert.equal(a.trades.length, 2); assert.equal(a.holders, 3);
  assert.equal(a.order_book[0].remaining, '985000'); assert.equal(a.last_price, String(Z(10)));
  const ps = (await api(base, '/api/market/assets')).data.stats;
  assert.equal(ps.trades, 2);
});

test('yield: issuer deposits income, holders get exact pro-rata amounts; keeper bot pushes payouts; portfolio reads live', async () => {
  const token = new ethers.Contract(tower.address, art('AssetToken').abi, S.issuer);
  await (await d.stable.connect(S.issuer).approve(tower.address, ethers.MaxUint256)).wait();
  await (await token.depositYield(Z(100_000), ethers.id('2026-10'))).wait();
  const aToken = token.connect(S.alice), tok = await login(base, S.alice);
  assert.equal(await aToken.pendingYield(W.alice.address), Z(500));                 // 5,000 / 1,000,000 of R100,000
  const p = (await api(base, '/api/portfolio', { token: tok })).data;
  assert.equal(p.positions[0].shares, '5000'); assert.equal(p.positions[0].pending_yield, String(Z(500)));
  const paid = await runKeeper(S.keeper, d.addresses.FACTORY_ADDRESS);
  assert.ok(paid.some((x) => x.holder === W.alice.address) && paid.some((x) => x.holder === W.bob.address));
  assert.equal(await aToken.pendingYield(W.alice.address), 0n);
  await api(base, '/api/market/sync', { method: 'POST' });
  const det = (await api(base, `/api/market/assets/${tower.address}`)).data;
  assert.equal(det.yield_deposited, String(Z(100_000)));
  assert.ok(BigInt(det.yield_claimed) >= Z(1500));
});

test('AML monitoring: a large trade and a wash trade raise alerts; freeze is enforced on-chain and learned by the indexer', async () => {
  const m = d.market;
  // large: bob buys R300,000 more (30,000 shares)
  await (await m.connect(S.bob).buy(1n, 30_000n)).wait();
  // wash: alice registers a SECOND wallet for the same person, then sells to it
  const a2 = await onboard(base, S.alice2, d.registry, {});
  assert.equal(a2.decision.status, 'approved');
  const token = new ethers.Contract(tower.address, art('AssetToken').abi, S.alice);
  await (await token.approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
  await (await d.stable.connect(S.alice2).approve(d.addresses.MARKET_ADDRESS, ethers.MaxUint256)).wait();
  await (await m.connect(S.alice).list(tower.address, 1000n, Z(10.5))).wait();
  const listingId = (await m.nextListingId()) - 1n;
  await (await m.connect(S.alice2).buy(listingId, 400n)).wait();
  await api(base, '/api/market/sync', { method: 'POST' });
  const alerts = (await api(base, '/api/admin/aml/alerts')).data.alerts;
  assert.ok(alerts.some((a) => a.rule === 'large_trade' && a.wallet === lc(W.bob)));
  const wash = alerts.find((a) => a.rule === 'wash_trade');
  assert.ok(wash && wash.severity === 'high');
  // freeze the wash-trader from the operator wallet
  await (await d.registry.connect(S.operator).freeze(W.alice2.address)).wait();
  await assert.rejects(token.connect(S.alice2).transfer.staticCall(W.bob.address, 1n));
  await api(base, '/api/market/sync', { method: 'POST' });
  const after = (await api(base, '/api/admin/aml/alerts')).data.alerts.find((a) => a.id === wash.id);
  assert.ok(['open', 'frozen'].includes(after.status));
  assert.ok((await api(base, '/api/admin/aml/alerts?status=frozen')).data.alerts.length >= 1);
});

test('receipts verify publicly; the audit log is anchored on-chain with browser-checkable proofs; tampering is caught', async () => {
  const token = await login(base, S.alice);
  const receipt = (await api(base, '/api/kyc/status', { token })).data.receipt;
  const v0 = (await api(base, '/api/chain/verify-receipt', { method: 'POST', body: { receipt } })).data;
  assert.equal(v0.valid, true); assert.equal(v0.on_record.matches_receipt, true); assert.equal(v0.registration.status, 'registered');
  assert.ok(v0.audit_trail.length >= 2 && v0.audit_trail.every((e) => e.anchored === false));
  const tampered = receipt.slice(0, -3) + (receipt.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.equal((await api(base, '/api/chain/verify-receipt', { method: 'POST', body: { receipt: tampered } })).data.valid, false);

  // anchor from the operator wallet
  const prep = (await api(base, '/api/admin/chain/anchor/prepare')).data;
  assert.equal(prep.pending, true);
  const rc = await (await d.anchor.connect(S.operator).anchor(prep.root, prep.from_id, prep.to_id, prep.count)).wait();
  assert.equal((await api(base, '/api/admin/chain/anchor/record', { method: 'POST', body: { root: prep.root, tx_hash: rc.hash } })).status, 200);
  assert.equal((await api(base, '/api/admin/chain/anchor/record', { method: 'POST', body: { root: '0x' + 'ab'.repeat(32), tx_hash: rc.hash } })).status, 502, 'a root that does not match the tx is refused');

  const { Merkle } = await import('../../app/Support/Merkle.js');
  const v1 = (await api(base, '/api/chain/verify-receipt', { method: 'POST', body: { receipt } })).data;
  const first = v1.audit_trail[0];
  assert.equal(first.anchored, true); assert.equal(first.root_on_chain, true); assert.equal(first.log_intact_since_anchor, true);
  assert.equal(Merkle.verify(first.proof, first.root, first.leaf), true);
  const [anchored] = await d.anchor.verify(first.root, first.leaf, first.proof); assert.equal(anchored, true);   // the CONTRACT agrees

  // the operator quietly rewrites history AND recomputes the hash chain - the on-chain root still exposes it
  const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(first.audit_id);
  db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('kyc.rejected', row.id);
  assert.equal((await api(base, '/api/admin/audit/verify')).data.intact, false);
  const { AuditLog } = await import('../../app/Models/AuditLog.js');
  let prev = row.prev_hash;
  for (const r of db.prepare('SELECT * FROM audit_log WHERE id >= ? ORDER BY id').all(row.id)) {
    const h = AuditLog.hashOf(prev, r); db.prepare('UPDATE audit_log SET prev_hash = ?, entry_hash = ? WHERE id = ?').run(prev, h, r.id); prev = h;
  }
  assert.equal((await api(base, '/api/admin/audit/verify')).data.intact, true, 'the rehashed chain is internally consistent...');
  const v2 = (await api(base, '/api/chain/verify-receipt', { method: 'POST', body: { receipt } })).data;
  assert.ok(v2.audit_trail.some((e) => e.anchored && e.log_intact_since_anchor === false), '...but no longer matches the root anchored on-chain');
});

test('data-subject rights: export shows what we hold; erasure wipes PII and unlinks the wallet; sessions stay valid but data is gone', async () => {
  const token = await login(base, S.dave);
  const ex = (await api(base, '/api/data-subject/export', { token })).data;
  assert.equal(ex.profile.full_name, 'Test Politician'); assert.ok(ex.on_chain_note);
  assert.equal((await api(base, '/api/data-subject/delete', { method: 'POST', token })).data.status, 'erased');
  assert.equal((await api(base, '/api/data-subject/export', { token })).status, 404);
  const row = db.prepare("SELECT * FROM users WHERE id_number_hash LIKE 'erased:%'").get();
  assert.ok(row && row.full_name_enc === null && row.dob_enc === null);
});

test('admin API is CSRF- and auth-protected when a password is configured (and open only in dev)', async () => {
  const { Config } = await import('../../app/Support/Config.js');
  process.env.ADMIN_PASSWORD = 'correct horse'; Config.reset();
  try {
    assert.equal((await api(base, '/api/admin/stats')).status, 401);
    assert.equal((await fetch(base + '/dashboard', { redirect: 'manual' })).status, 302, 'dashboard redirects to login');
    const r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=wrong', redirect: 'manual' });
    assert.equal(r.status, 401);
    const ok = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=correct%20horse', redirect: 'manual' });
    assert.equal(ok.status, 302);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await api(base, '/api/admin/stats', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await api(base, '/api/admin/retention/run', { method: 'POST', headers: { Cookie: cookie } })).status, 403, 'writes need the CSRF token');
    const csrf = (await api(base, '/api/admin/csrf', { headers: { Cookie: cookie } })).data.csrf;
    assert.equal((await api(base, '/api/admin/retention/run', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf } })).status, 200);
  } finally { delete process.env.ADMIN_PASSWORD; Config.reset(); }
});
