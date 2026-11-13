import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { setup, kyc, createAsset, fund, reverts, ZAR } from './helpers.js';

const addr = (s) => s.getAddress();
async function world(over = {}) {
  const c = await setup();
  for (const s of [c.alice, c.bob, c.carol]) await kyc(c, s, 1);
  const asset = await createAsset(c, over);
  c.asset = asset;
  return c;
}
const send = async (c, from, to, n) => (await c.asset.connect(from).transfer(await addr(to), n)).wait();
const deposit = async (c, amountZar, ref = 'p') => {
  await fund(c, c.issuer, amountZar, await c.asset.getAddress());
  return (await c.asset.connect(c.issuer).depositYield(ZAR(amountZar), ethers.id(ref))).wait();
};

test('shares move only between KYC-verified wallets; the token itself refuses the rest', async () => {
  const c = await world();
  await send(c, c.issuer, c.alice, 1000n);
  assert.equal(await c.asset.balanceOf(await addr(c.alice)), 1000n);
  await reverts(c.asset.connect(c.issuer).transfer.staticCall(await addr(c.mallory), 1n), 'NotEligible');   // never KYC'd
  await send(c, c.alice, c.bob, 100n);                                                                        // peer-to-peer is also gated, and fine here
  await reverts(c.asset.connect(c.alice).transfer.staticCall(await addr(c.mallory), 1n), 'NotEligible');
});

test('an asset can require accredited (tier 2) investors', async () => {
  const c = await world({ minTier: 2, symbol: 'PCRD', name: 'Private credit note' });
  await reverts(c.asset.connect(c.issuer).transfer.staticCall(await addr(c.alice), 1n), 'NotEligible'); // retail
  await kyc(c, c.bob, 2);                                                                               // bob upgrades
  await send(c, c.issuer, c.bob, 50n);
  assert.equal(await c.asset.balanceOf(await addr(c.bob)), 50n);
});

test('expired KYC cannot receive shares but can still sell what it holds', async () => {
  const c = await world(); await send(c, c.issuer, c.alice, 500n);
  await c.provider.send('evm_increaseTime', [400 * 86400]); await c.provider.send('evm_mine', []);
  await kyc(c, c.bob, 1, { expiry: (await c.provider.getBlock('latest')).timestamp + 86400 });
  await send(c, c.alice, c.bob, 100n);                                                                   // alice (lapsed) -> bob (valid): allowed
  await reverts(c.asset.connect(c.bob).transfer.staticCall(await addr(c.alice), 1n), 'NotEligible');   // to a lapsed wallet: refused
});

test('AML freeze: a frozen wallet can neither send nor receive shares, and cannot claim yield', async () => {
  const c = await world(); await send(c, c.issuer, c.alice, 1000n); await deposit(c, 1000);
  await (await c.registry.connect(c.attestor).freeze(await addr(c.alice))).wait();
  await reverts(c.asset.connect(c.alice).transfer.staticCall(await addr(c.bob), 1n), 'WalletFrozen');
  await reverts(c.asset.connect(c.issuer).transfer.staticCall(await addr(c.alice), 1n), 'NotEligible');
  await reverts(c.asset.connect(c.alice).claim.staticCall(), 'WalletFrozen');
  await (await c.registry.connect(c.owner).unfreeze(await addr(c.alice))).wait();
  assert.ok((await c.asset.connect(c.alice).claim.staticCall()) > 0n);                                   // income was waiting, nothing lost
});

test('concentration cap: no single non-issuer wallet may exceed maxHolderBps', async () => {
  const c = await world({ maxHolderBps: 1000 });                                                         // 10% of 1,000,000
  await send(c, c.issuer, c.alice, 100_000n);
  await reverts(c.asset.connect(c.issuer).transfer.staticCall(await addr(c.alice), 1n), 'HolderCapExceeded');
  await send(c, c.issuer, c.bob, 100_000n);
});

test('an asset can be paused by the platform (e.g. legal hold) without touching other assets', async () => {
  const c = await world(); await send(c, c.issuer, c.alice, 10n);
  await (await c.asset.connect(c.owner).pause()).wait();
  await reverts(c.asset.connect(c.alice).transfer.staticCall(await addr(c.bob), 1n), 'EnforcedPause');
  await (await c.asset.connect(c.owner).unpause()).wait(); await send(c, c.alice, c.bob, 1n);
});

test('yield is shared pro rata and exactly: 1,000 shares of 1,000,000 earn 0.1% of the income', async () => {
  const c = await world(); await send(c, c.issuer, c.alice, 1000n); await send(c, c.issuer, c.bob, 3000n);
  await deposit(c, 10_000);
  assert.equal(await c.asset.pendingYield(await addr(c.alice)), ZAR(10));
  assert.equal(await c.asset.pendingYield(await addr(c.bob)), ZAR(30));
  assert.equal(await c.asset.pendingYield(await addr(c.issuer)), ZAR(9960));
  const before = await c.stable.balanceOf(await addr(c.alice));
  await (await c.asset.connect(c.alice).claim()).wait();
  assert.equal(await c.stable.balanceOf(await addr(c.alice)) - before, ZAR(10));
  assert.equal(await c.asset.pendingYield(await addr(c.alice)), 0n);
});

test('a buyer never receives income earned before they bought; a seller keeps what they accrued', async () => {
  const c = await world(); await send(c, c.issuer, c.alice, 10_000n);
  await deposit(c, 100_000, 'p1');                                  // alice has accrued R1,000 (1%)
  await send(c, c.alice, c.bob, 10_000n);                           // sells everything to bob AFTER the payout
  assert.equal(await c.asset.pendingYield(await addr(c.alice)), ZAR(1000), 'seller keeps accrued income');
  assert.equal(await c.asset.pendingYield(await addr(c.bob)), 0n, 'buyer gets nothing for the past');
  await deposit(c, 100_000, 'p2');                                  // next period belongs to bob
  assert.equal(await c.asset.pendingYield(await addr(c.bob)), ZAR(1000));
  assert.equal(await c.asset.pendingYield(await addr(c.alice)), ZAR(1000));
});

test('transfers in the middle of many periods keep every holder exact (conservation)', async () => {
  const c = await world();
  await send(c, c.issuer, c.alice, 7_777n); await send(c, c.issuer, c.bob, 12_345n); await send(c, c.issuer, c.carol, 333n);
  await deposit(c, 12_345.67, 'a'); await send(c, c.alice, c.carol, 1_111n);
  await deposit(c, 999.99, 'b'); await send(c, c.bob, c.alice, 5_000n); await send(c, c.carol, c.bob, 7n);
  await deposit(c, 54_321.01, 'c');
  const holders = [c.issuer, c.alice, c.bob, c.carol];
  let sum = 0n;
  for (const h of holders) { const p = await c.asset.pendingYield(await addr(h)); sum += p; await (await c.asset.connect(c.treasury).claimFor(await addr(h))).wait(); }
  const deposited = await c.asset.totalDeposited();
  assert.ok(sum <= deposited, 'never pays out more than was deposited');
  assert.ok(deposited - sum < 10n, `rounding dust stays tiny (${deposited - sum} micro-units)`);
  assert.equal(await c.asset.totalClaimed(), sum);
});

test('claimFor lets a keeper push income to holders, and the money only ever goes to the holder', async () => {
  const c = await world(); await send(c, c.issuer, c.alice, 5000n); await deposit(c, 50_000);
  const keeper = await addr(c.treasury);
  const a = await addr(c.alice), kBefore = await c.stable.balanceOf(keeper), aBefore = await c.stable.balanceOf(a);
  await (await c.asset.connect(c.treasury).claimFor(a)).wait();
  assert.equal(await c.stable.balanceOf(a) - aBefore, ZAR(250));
  assert.equal(await c.stable.balanceOf(keeper), kBefore);
  assert.equal(await c.asset.connect(c.treasury).claimFor.staticCall(a), 0n);                           // nothing left to double-claim
});

test('only the issuer can deposit yield or update the legal document hash', async () => {
  const c = await world();
  await fund(c, c.mallory, 100, await c.asset.getAddress());
  await reverts(c.asset.connect(c.mallory).depositYield.staticCall(ZAR(1), ethers.id('x')), 'NotIssuer');
  await reverts(c.asset.connect(c.issuer).depositYield.staticCall(0n, ethers.id('x')), 'ZeroAmount');
  await reverts(c.asset.connect(c.mallory).updateDocument.staticCall(ethers.id('v2'), 'ipfs://v2'), 'NotIssuer');
  const rc = await (await c.asset.connect(c.issuer).updateDocument(ethers.id('v2'), 'ipfs://v2')).wait();
  assert.ok(rc.logs.some((l) => l.fragment?.name === 'DocumentUpdated'));
  assert.equal(await c.asset.documentHash(), ethers.id('v2'));
});

test('factory: only the owner creates assets; parameters are validated; marketplace trusts only factory assets', async () => {
  const c = await setup();
  const p = { name: 'X', symbol: 'X', issuer: await addr(c.issuer), totalShares: 10n, assetClass: 0, minTier: 1, maxHolderBps: 0, documentHash: ethers.ZeroHash, documentURI: '' };
  await assert.rejects(c.factory.connect(c.mallory).createAsset.staticCall(p));
  await reverts(c.factory.connect(c.owner).createAsset.staticCall({ ...p, totalShares: 0n }), 'BadParams');
  await reverts(c.factory.connect(c.owner).createAsset.staticCall({ ...p, minTier: 3 }), 'BadParams');
  const a = await createAsset(c);
  assert.equal(await c.factory.isAsset(await a.getAddress()), true);
  assert.equal(await c.factory.assetCount(), 1n);
});
