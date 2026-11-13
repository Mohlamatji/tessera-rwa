// Offline checks for the XRPL rail: every transaction is valid, binary-encodes (so field names are real), and can be signed.
// These do NOT prove ledger behaviour - run chain/scripts/xrpl-demo.js against a test network for that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { XrplRail, mptokenState, encode, Wallet } from '../chain/scripts/xrpl-rail.js';

const issuer = Wallet.generate(), holder = Wallet.generate();
const ID = '0000000A' + 'B'.repeat(40);

const all = () => ({
  optIn: XrplRail.optIn(holder.address, ID),
  authorize: XrplRail.authorize(issuer.address, ID, holder.address),
  unauthorize: XrplRail.unauthorize(issuer.address, ID, holder.address),
  send: XrplRail.send(issuer.address, ID, holder.address, 100),
  lockHolder: XrplRail.lockHolder(issuer.address, ID, holder.address),
  unlockHolder: XrplRail.unlockHolder(issuer.address, ID, holder.address),
  lockAll: XrplRail.lockAll(issuer.address, ID),
  unlockAll: XrplRail.unlockAll(issuer.address, ID),
  clawback: XrplRail.clawback(issuer.address, ID, holder.address, 100),
});

test('every rail transaction encodes to the XRPL binary format and can be signed', () => {
  for (const [name, t] of Object.entries(all())) {
    assert.ok(encode({ ...t, Sequence: 1, Fee: '12', SigningPubKey: '' }), name);
    const signer = t.Account === holder.address ? holder : issuer;
    const signed = signer.sign({ ...t, Sequence: 1, Fee: '12', LastLedgerSequence: 100, NetworkID: undefined });
    assert.match(signed.tx_blob, /^[0-9A-F]+$/);
    assert.equal(signed.hash.length, 64, name);
  }
});

test('the identity gate has two sides: the holder opts in, only the issuer can authorise', () => {
  const t = all();
  assert.equal(t.optIn.Account, holder.address); assert.equal(t.optIn.Holder, undefined);
  assert.equal(t.authorize.Account, issuer.address); assert.equal(t.authorize.Holder, holder.address);
  assert.equal(t.unauthorize.Flags, 1);
});

test('freeze one holder vs halt the whole asset differ only by the Holder field', () => {
  const t = all();
  assert.equal(t.lockHolder.Holder, holder.address); assert.equal(t.lockAll.Holder, undefined);
  assert.equal(t.lockHolder.Flags, t.lockAll.Flags);
  assert.notEqual(t.unlockAll.Flags, t.lockAll.Flags);
});

test('amounts are whole shares in MPT form; bad input is refused', () => {
  assert.deepEqual(all().send.Amount, { mpt_issuance_id: ID, value: '100' });
  for (const bad of [0, -1, 1.5, '1e3', '', 'abc']) assert.throws(() => XrplRail.send(issuer.address, ID, holder.address, bad), /whole number/);
  assert.throws(() => XrplRail.optIn(holder.address, 'xyz'), /48 hex/);
});

test('mptokenState decodes the MPToken ledger flags', () => {
  assert.deepEqual(mptokenState({ MPTAmount: '100', Flags: 0x2 }), { balance: '100', locked: false, authorized: true });
  assert.deepEqual(mptokenState({ MPTAmount: '5', Flags: 0x3 }), { balance: '5', locked: true, authorized: true });
  assert.deepEqual(mptokenState(undefined), { balance: '0', locked: false, authorized: false });
});
