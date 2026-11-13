import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

process.env.DB_SQLITE_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = 'unit-test-key-unit-test-key-unit-test-key';
const { SaId } = await import('../app/Support/SaId.js');
const { Merkle } = await import('../app/Support/Merkle.js');
const { Tokens } = await import('../app/Support/Tokens.js');
const { Eth } = await import('../app/Support/Eth.js');
const { EncryptionService } = await import('../app/Services/EncryptionService.js');
const { DecisionEngine } = await import('../app/Services/DecisionEngine.js');
const { MockAdapter } = await import('../app/Services/VerificationAdapters/MockAdapter.js');
const { AuditLog } = await import('../app/Models/AuditLog.js');
const { getDb } = await import('../config/database.js');

test('SaId: generated IDs validate; checksum, date and DOB mismatches are caught', () => {
  const id = SaId.make('1990-05-15', 5009);
  assert.equal(SaId.inspect(id, '1990-05-15').valid, true);
  assert.equal(SaId.inspect(id, '1991-05-15').valid, false);
  assert.equal(SaId.inspect(id.slice(0, 12) + ((Number(id[12]) + 1) % 10)).valid, false);
  assert.equal(SaId.inspect('9013320000080').valid, false);
  assert.equal(SaId.inspect('abc').valid, false);
});

test('Merkle: every leaf of every tree size verifies; tampering and wrong roots do not', () => {
  for (let n = 1; n <= 17; n++) {
    const leaves = Array.from({ length: n }, (_, i) => ethers.id('leaf' + i));
    const { root, layers } = Merkle.build(leaves);
    for (let i = 0; i < n; i++) assert.equal(Merkle.verify(Merkle.proof(layers, i), root, leaves[i]), true, `n=${n} i=${i}`);
    assert.equal(Merkle.verify(Merkle.proof(layers, 0), root, ethers.id('forged')), false);
  }
  assert.throws(() => Merkle.build([]));
  assert.throws(() => Merkle.build(['0x1234']));
});

test('Tokens: signed tokens verify; any change, wrong purpose, or expiry fails', () => {
  const t = Tokens.sign({ sub: 'x', exp: Math.floor(Date.now() / 1000) + 60 }, 'p', 'pre_');
  assert.equal(Tokens.verify(t, 'p', 'pre_').sub, 'x');
  assert.equal(Tokens.verify(t, 'other', 'pre_'), null);
  assert.equal(Tokens.verify(t.replace('pre_', 'bad_'), 'p', 'pre_'), null);
  assert.equal(Tokens.verify(t.slice(0, -2) + 'AA', 'p', 'pre_'), null);
  assert.equal(Tokens.verify(Tokens.sign({ sub: 'x', exp: 1 }, 'p', 'pre_'), 'p', 'pre_'), null);
});

test('EncryptionService: round trip, tamper detection, stable normalised blind index', () => {
  const c = EncryptionService.encrypt('Alice Investor');
  assert.equal(EncryptionService.decrypt(c), 'Alice Investor');
  assert.notEqual(c, EncryptionService.encrypt('Alice Investor'));            // random IV
  const parts = c.split('.'); parts[3] = Buffer.from('xxxxxxxxxxxxxx').toString('base64');
  assert.throws(() => EncryptionService.decrypt(parts.join('.')));
  assert.equal(EncryptionService.blindIndex('za_id: 123 456'), EncryptionService.blindIndex('ZA_ID:123456'));
});

test('Eth: the attestor claim signature recovers to the attestor (EIP-712)', async () => {
  const w = ethers.Wallet.createRandom(), reg = ethers.Wallet.createRandom().address;
  const claim = { decisionId: Eth.newDecisionId(), wallet: reg, tier: 1, expiry: 2_000_000_000 };
  const sig = await Eth.signClaim(w.privateKey, 1, reg, claim);
  assert.equal(ethers.verifyTypedData(Eth.claimDomain(1, reg), Eth.CLAIM_TYPES, claim, sig), w.address);
  assert.equal(Eth.isAddress('0x123'), false);
  assert.throws(() => Eth.norm('nope'));
});

const base = (o = {}) => ({ full_name: 'Alice Investor', dob: '1990-05-15', country: 'ZA', id_type: 'za_id', id_number: SaId.make('1990-05-15', 5009), investor_type: 'retail', accreditation: {}, intended_investment_cents: 1_000_000, ...o });
const run = async (p) => { p.source_of_funds_required = p.intended_investment_cents >= 25_000_000; return DecisionEngine.evaluate({ profile: p, result: await new MockAdapter().verify(p) }); };

test('DecisionEngine: a clean retail applicant is approved at tier 1 with an explainable score', async () => {
  const r = await run(base());
  assert.equal(r.decision, 'approved'); assert.equal(r.tier, 1); assert.ok(r.score >= 70);
  assert.ok(r.factors.length >= 4 && r.gates.every((g) => g.passed));
});

test('DecisionEngine: hard gates reject regardless of score; soft flags force review; provider outage fails closed', async () => {
  const s = await run(base({ full_name: 'Test Sanctioned' }));
  assert.equal(s.decision, 'rejected'); assert.ok(s.score >= 50, 'high score cannot buy past a sanctions hit');
  assert.equal((await run(base({ country: 'KP' }))).decision, 'rejected');
  assert.equal((await run(base({ dob: '2015-01-01', id_number: SaId.make('2015-01-01', 5009) }))).decision, 'rejected');
  assert.equal((await run(base({ full_name: 'Test Politician' }))).decision, 'review');
  assert.equal((await run(base({ country: 'MM' }))).decision, 'review');
  const big = await run(base({ intended_investment_cents: 30_000_000 }));
  assert.equal(big.decision, 'review'); assert.equal(big.required_action, 'provide_source_of_funds');
  assert.equal((await run(base({ intended_investment_cents: 30_000_000, source_of_funds_evidence_ref: 'evd_ok' }))).decision, 'approved');
  const out = DecisionEngine.evaluate({ profile: base(), result: null, providerError: true });
  assert.equal(out.decision, 'review'); assert.equal(out.tier, 0);
});

test('DecisionEngine: tier 2 needs declared wealth AND verified evidence; otherwise tier 1 plus a to-do', async () => {
  const acc = (o) => base({ investor_type: 'accredited', accreditation: o });
  assert.equal((await run(acc({ net_worth_cents: 900_000_000, evidence_ref: 'evd_1' }))).tier, 2);
  const noEv = await run(acc({ net_worth_cents: 900_000_000 }));
  assert.equal(noEv.tier, 1); assert.equal(noEv.required_action, 'submit_accreditation_evidence');
  assert.equal((await run(acc({ net_worth_cents: 100, evidence_ref: 'evd_1' }))).tier, 1);
});

test('AuditLog: hash chain verifies, and editing or deleting any row is detected', () => {
  for (let i = 0; i < 5; i++) AuditLog.append('t', 'a' + i, 'x', i);
  assert.equal(AuditLog.verifyChain().intact, true);
  const db = getDb();
  db.prepare('UPDATE audit_log SET action = ? WHERE id = 3').run('forged');
  assert.deepEqual([AuditLog.verifyChain().intact, AuditLog.verifyChain().first_bad_id], [false, 3]);
  db.prepare('UPDATE audit_log SET action = ? WHERE id = 3').run('a2');
  assert.equal(AuditLog.verifyChain().intact, true);
  db.prepare('DELETE FROM audit_log WHERE id = 2').run();
  assert.equal(AuditLog.verifyChain().intact, false);
});
