import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { setup, claimFor, kyc, claimDomain, CLAIM_TYPES, reverts, mine } from './helpers.js';

test('a valid attested claim registers the wallet and emits Registered', async () => {
  const c = await setup(); const { c: claim, sig } = await claimFor(c, c.alice, 1);
  const rc = await (await c.registry.connect(c.alice).register(claim, sig)).wait();
  assert.ok(rc.logs.some((l) => l.fragment?.name === 'Registered' && l.args[3] === claim.decisionId));
  assert.equal(await c.registry.tierOf(await c.alice.getAddress()), 1n);
  assert.equal(await c.registry.isEligible(await c.alice.getAddress(), 1), true);
  assert.equal(await c.registry.isEligible(await c.alice.getAddress(), 2), false);
});

test('only the attested wallet can submit its claim (a leaked claim is useless to others)', async () => {
  const c = await setup(); const { c: claim, sig } = await claimFor(c, c.alice, 1);
  await reverts(c.registry.connect(c.mallory).register.staticCall(claim, sig), 'NotWallet');
});

test('a claim registers once (replay is rejected)', async () => {
  const c = await setup(); const { c: claim, sig } = await claimFor(c, c.alice, 1);
  await (await c.registry.connect(c.alice).register(claim, sig)).wait();
  await reverts(c.registry.connect(c.alice).register.staticCall(claim, sig), 'AlreadyUsed');
});

test('every signed field is bound: upgrading the tier or extending expiry breaks the signature', async () => {
  const c = await setup(); const { c: claim, sig } = await claimFor(c, c.alice, 1);
  await reverts(c.registry.connect(c.alice).register.staticCall({ ...claim, tier: 2 }, sig), 'BadSignature');
  await reverts(c.registry.connect(c.alice).register.staticCall({ ...claim, expiry: claim.expiry + 10 }, sig), 'BadSignature');
  await reverts(c.registry.connect(c.alice).register.staticCall({ ...claim, decisionId: ethers.id('other') }, sig), 'BadSignature');
});

test('a signature from anyone other than the attestor is rejected', async () => {
  const c = await setup(); const { c: claim } = await claimFor(c, c.alice, 1);
  const forged = await c.wallets[6].signTypedData(claimDomain(31337, await c.registry.getAddress()), CLAIM_TYPES, claim);
  await reverts(c.registry.connect(c.alice).register.staticCall(claim, forged), 'BadSignature');
});

test('bad tiers and expired claims are rejected', async () => {
  const c = await setup();
  for (const tier of [0, 3]) { const { c: cl, sig } = await claimFor(c, c.alice, tier); await reverts(c.registry.connect(c.alice).register.staticCall(cl, sig), 'BadTier'); }
  const { c: old, sig } = await claimFor(c, c.alice, 1, { expiry: c.now - 1 });
  await reverts(c.registry.connect(c.alice).register.staticCall(old, sig), 'Expired');
});

test('eligibility lapses at expiry (re-verification required) and can be renewed', async () => {
  const c = await setup(); const a = await c.alice.getAddress();
  await kyc(c, c.alice, 1, { expiry: c.now + 1000 });
  assert.equal(await c.registry.tierOf(a), 1n);
  await mine(c.provider, 2000);
  assert.equal(await c.registry.tierOf(a), 0n);
  const now2 = (await c.provider.getBlock('latest')).timestamp;
  await kyc(c, c.alice, 2, { expiry: now2 + 5000 });            // renewal + upgrade with a NEW decision
  assert.equal(await c.registry.tierOf(a), 2n);
});

test('AML freeze: attestor or owner freezes at once, only the owner unfreezes', async () => {
  const c = await setup(); const a = await c.alice.getAddress(); await kyc(c, c.alice, 1);
  await reverts(c.registry.connect(c.mallory).freeze.staticCall(a), 'NotAuthorised');
  await (await c.registry.connect(c.attestor).freeze(a)).wait();
  assert.equal(await c.registry.tierOf(a), 0n); assert.equal(await c.registry.isFrozen(a), true);
  await assert.rejects(c.registry.connect(c.attestor).unfreeze.staticCall(a));
  await (await c.registry.connect(c.owner).unfreeze(a)).wait();
  assert.equal(await c.registry.tierOf(a), 1n);
});

test('revoke clears a record; pause stops new registrations; attestor can be rotated', async () => {
  const c = await setup(); const a = await c.alice.getAddress(); await kyc(c, c.alice, 1);
  await (await c.registry.connect(c.owner).revoke(a)).wait();
  assert.equal(await c.registry.tierOf(a), 0n);
  await (await c.registry.connect(c.owner).pause()).wait();
  const { c: cl, sig } = await claimFor(c, c.bob, 1);
  await reverts(c.registry.connect(c.bob).register.staticCall(cl, sig), 'EnforcedPause');
  await (await c.registry.connect(c.owner).unpause()).wait();
  await (await c.registry.connect(c.owner).setAttestor(await c.mallory.getAddress())).wait();
  await reverts(c.registry.connect(c.bob).register.staticCall(cl, sig), 'BadSignature');
});
