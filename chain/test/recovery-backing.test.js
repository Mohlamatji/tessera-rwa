// Hackathon RWA controls: (1) freeze + recover, (2) custodian-signed proof of backing that halts trading on a shortfall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { setup, kyc, createAsset, fund, reverts, deploy, ZAR, mine } from './helpers.js';

const addr = (s) => s.getAddress();
const ATT_TYPES = { Attestation: [
  { name: 'asset', type: 'address' }, { name: 'backedShares', type: 'uint256' }, { name: 'asOf', type: 'uint64' },
  { name: 'validUntil', type: 'uint64' }, { name: 'evidenceHash', type: 'bytes32' }, { name: 'nonce', type: 'uint64' } ] };

async function world() {
  const c = await setup();
  for (const s of [c.alice, c.bob, c.carol]) await kyc(c, s, 1);
  c.asset = await createAsset(c);
  c.assetAddr = await c.asset.getAddress();
  return c;
}
async function withOracle(c) {
  const custodian = c.wallets[8];
  const oracle = await deploy('BackingOracle', c.owner, custodian.address, await addr(c.owner));
  await (await c.market.connect(c.owner).setBackingOracle(await oracle.getAddress())).wait();
  c.oracle = oracle; c.custodian = custodian;
  c.attest = async (backed, over = {}) => {
    const now = (await c.provider.getBlock('latest')).timestamp;
    c.nonce = (c.nonce ?? 0) + 1;
    const a = { asset: c.assetAddr, backedShares: backed, asOf: now, validUntil: now + 30 * 86400, evidenceHash: ethers.id('custodian statement ' + c.nonce), nonce: c.nonce, ...over };
    const sig = await custodian.signTypedData({ name: 'TesseraBacking', version: '1', chainId: 31337, verifyingContract: await oracle.getAddress() }, ATT_TYPES, a);
    return { a, sig };
  };
  return c;
}
async function listAndFund(c) {
  await (await c.asset.connect(c.issuer).approve(await addr(c.market), ethers.MaxUint256)).wait();
  const id = (await c.market.nextListingId());
  await (await c.market.connect(c.issuer).list(c.assetAddr, 10_000n, ZAR(10))).wait();
  await fund(c, c.alice, 1_000_000, await addr(c.market));
  return id;
}

// ------------------------------------------------------------------ freeze + recover

test('forced transfer moves shares out of a FROZEN wallet, but only to a KYC-eligible wallet, and only by the owner', async () => {
  const c = await world();
  await (await c.asset.connect(c.issuer).transfer(await addr(c.alice), 500n)).wait();
  await (await c.registry.connect(c.owner).freeze(await addr(c.alice))).wait();
  await reverts(c.asset.connect(c.alice).transfer.staticCall(await addr(c.bob), 1n), 'WalletFrozen');            // normal route is blocked
  await reverts(c.asset.connect(c.alice).forcedTransfer.staticCall(await addr(c.alice), await addr(c.bob), 1n, ethers.ZeroHash), 'OwnableUnauthorizedAccount');
  await reverts(c.asset.connect(c.owner).forcedTransfer.staticCall(await addr(c.alice), await addr(c.mallory), 1n, ethers.ZeroHash), 'NotEligible'); // can't launder to an unverified wallet
  const rc = await (await c.asset.connect(c.owner).forcedTransfer(await addr(c.alice), await addr(c.bob), 200n, ethers.id('court order 2026/118'))).wait();
  assert.equal(await c.asset.balanceOf(await addr(c.alice)), 300n);
  assert.equal(await c.asset.balanceOf(await addr(c.bob)), 200n);
  assert.ok(rc.logs.some((l) => { try { return c.asset.interface.parseLog(l)?.name === 'ForcedTransfer'; } catch { return false; } }), 'audit event emitted');
  await reverts(c.asset.connect(c.alice).transfer.staticCall(await addr(c.bob), 1n), 'WalletFrozen');            // still frozen afterwards
});

test('lost-key recovery moves ALL shares and the unclaimed yield to the re-verified replacement wallet', async () => {
  const c = await world();
  await (await c.asset.connect(c.issuer).transfer(await addr(c.alice), 1000n)).wait();
  await fund(c, c.issuer, 100_000, c.assetAddr);
  await (await c.asset.connect(c.issuer).depositYield(ZAR(100_000), ethers.id('2026-10'))).wait();
  const pending = await c.asset.pendingYield(await addr(c.alice));
  assert.ok(pending > 0n);
  const before = await c.stable.balanceOf(await addr(c.bob));
  // bob stands in for alice's NEW wallet (already KYC'd by the operator after re-verifying the same person)
  await (await c.asset.connect(c.owner).recoverWallet(await addr(c.alice), await addr(c.bob), ethers.id('lost keys ticket 77'))).wait();
  assert.equal(await c.asset.balanceOf(await addr(c.alice)), 0n);
  assert.equal(await c.asset.balanceOf(await addr(c.bob)), 1000n);
  assert.equal(await c.stable.balanceOf(await addr(c.bob)) - before, pending);
  assert.equal(await c.asset.pendingYield(await addr(c.alice)), 0n);
  await reverts(c.asset.connect(c.owner).recoverWallet.staticCall(await addr(c.alice), await addr(c.mallory), ethers.ZeroHash), 'NoShares'); // nothing left to recover
  // conservation: everything deposited is either claimed or still claimable
  const claimable = (await c.asset.pendingYield(await addr(c.bob))) + (await c.asset.pendingYield(await addr(c.issuer)));
  assert.ok((await c.asset.totalClaimed()) + claimable <= (await c.asset.totalDeposited()));
});

// ------------------------------------------------------------------ proof of backing

test('custodian attests full backing -> trading works; a shortfall attestation halts buying; re-attesting resumes it', async () => {
  const c = await withOracle(await world());
  const id = await listAndFund(c);
  let { a, sig } = await c.attest(1_000_000n);
  await (await c.oracle.submit(a, sig)).wait();
  assert.equal((await c.oracle.status(c.assetAddr)).state, 1n);
  await (await c.market.connect(c.alice).buy(id, 10n)).wait();                           // backed: fine

  ({ a, sig } = await c.attest(900_000n, { evidenceHash: ethers.id('statement: 100k shares unaccounted') }));
  const rc = await (await c.oracle.submit(a, sig)).wait();
  assert.equal((await c.oracle.status(c.assetAddr)).state, 3n);
  assert.equal(await c.oracle.isShortfall(c.assetAddr), true);
  assert.ok(rc.logs.some((l) => { try { const e = c.oracle.interface.parseLog(l); return e?.name === 'Attested' && e.args.shortfall === true; } catch { return false; } }));
  await reverts(c.market.connect(c.alice).buy.staticCall(id, 10n), 'BackingShortfall');   // the demo's failure case

  ({ a, sig } = await c.attest(1_000_000n));
  await (await c.oracle.submit(a, sig)).wait();
  await (await c.market.connect(c.alice).buy(id, 10n)).wait();                           // restored
});

test('attestations cannot be forged, replayed, back-dated into the future, or submitted already expired', async () => {
  const c = await withOracle(await world());
  const now = (await c.provider.getBlock('latest')).timestamp;
  const forged = { asset: c.assetAddr, backedShares: 1_000_000n, asOf: now, validUntil: now + 86400, evidenceHash: ethers.ZeroHash, nonce: 1 };
  const badSig = await c.wallets[6].signTypedData({ name: 'TesseraBacking', version: '1', chainId: 31337, verifyingContract: await c.oracle.getAddress() }, ATT_TYPES, forged);
  await reverts(c.oracle.submit.staticCall(forged, badSig), 'BadSignature');
  const good = await c.attest(1_000_000n);
  await (await c.oracle.submit(good.a, good.sig)).wait();
  await reverts(c.oracle.submit.staticCall(good.a, good.sig), 'StaleNonce');               // replay of the same attestation
  const future = await c.attest(1_000_000n, { asOf: now + 3600 });
  await reverts(c.oracle.submit.staticCall(future.a, future.sig), 'FromTheFuture');
  const expired = await c.attest(1_000_000n, { validUntil: now - 1 });
  await reverts(c.oracle.submit.staticCall(expired.a, expired.sig), 'AlreadyExpired');
});

test('a stale (expired) attestation is flagged but does not by itself halt trading; no attestation never halts', async () => {
  const c = await withOracle(await world());
  const id = await listAndFund(c);
  await (await c.market.connect(c.alice).buy(id, 1n)).wait();                              // unattested: allowed
  assert.equal((await c.oracle.status(c.assetAddr)).state, 0n);
  const { a, sig } = await c.attest(1_000_000n, { validUntil: (await c.provider.getBlock('latest')).timestamp + 600 });
  await (await c.oracle.submit(a, sig)).wait();
  await mine(c.provider, 3600);
  assert.equal((await c.oracle.status(c.assetAddr)).state, 2n);
  await (await c.market.connect(c.alice).buy(id, 1n)).wait();
});
