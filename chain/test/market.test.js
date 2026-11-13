import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { setup, kyc, createAsset, fund, reverts, ZAR } from './helpers.js';

const addr = (s) => s.getAddress();
async function world(over = {}) {
  const c = await setup();
  for (const s of [c.alice, c.bob, c.carol]) await kyc(c, s, 1);
  c.asset = await createAsset(c, over);
  const m = await addr(c.market);
  await (await c.asset.connect(c.issuer).approve(m, ethers.MaxUint256)).wait();
  for (const s of [c.alice, c.bob, c.carol]) await fund(c, s, 500_000, m);
  return c;
}
const list = async (c, seller, n, priceZar) => {
  const rc = await (await c.market.connect(seller).list(await c.asset.getAddress(), n, ZAR(priceZar))).wait();
  return rc.logs.map((l) => { try { return c.market.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Listed').args.id;
};

test('primary sale: issuer lists, investor buys, shares and money move atomically (1% fee)', async () => {
  const c = await world(); const id = await list(c, c.issuer, 100_000n, 10);
  const issuerBefore = await c.stable.balanceOf(await addr(c.issuer)), feeBefore = await c.stable.balanceOf(await addr(c.treasury));
  const rc = await (await c.market.connect(c.alice).buy(id, 2_000n)).wait();
  assert.equal(await c.asset.balanceOf(await addr(c.alice)), 2000n);
  assert.equal(await c.stable.balanceOf(await addr(c.issuer)) - issuerBefore, ZAR(19_800));
  assert.equal(await c.stable.balanceOf(await addr(c.treasury)) - feeBefore, ZAR(200));
  assert.ok(rc.logs.some((l) => l.fragment?.name === 'Sold'));
  assert.equal((await c.market.listings(id)).remaining, 98_000n);
});

test('instant secondary liquidity: an investor resells to another, partial fills, sold-out closes the listing', async () => {
  const c = await world(); const p = await list(c, c.issuer, 10_000n, 10);
  await (await c.market.connect(c.alice).buy(p, 1000n)).wait();
  await (await c.asset.connect(c.alice).approve(await addr(c.market), ethers.MaxUint256)).wait();
  const id = await list(c, c.alice, 600n, 12);
  await (await c.market.connect(c.bob).buy(id, 250n)).wait();
  await (await c.market.connect(c.carol).buy(id, 350n)).wait();
  assert.equal(await c.asset.balanceOf(await addr(c.bob)), 250n); assert.equal(await c.asset.balanceOf(await addr(c.carol)), 350n);
  assert.equal((await c.market.listings(id)).active, false);
  await reverts(c.market.connect(c.bob).buy.staticCall(id, 1n), 'NotActive');
});

test('KYC/AML is enforced by the token: an unverified or frozen buyer cannot take shares and the whole trade reverts', async () => {
  const c = await world(); const id = await list(c, c.issuer, 1000n, 10);
  await fund(c, c.mallory, 10_000, await addr(c.market));
  const before = await c.stable.balanceOf(await addr(c.mallory));
  await reverts(c.market.connect(c.mallory).buy.staticCall(id, 10n), 'NotEligible');
  assert.equal(await c.stable.balanceOf(await addr(c.mallory)), before, 'no payment leaves a rejected buyer');
  await (await c.registry.connect(c.attestor).freeze(await addr(c.alice))).wait();
  await reverts(c.market.connect(c.alice).buy.staticCall(id, 10n), 'NotEligible');
});

test('a seller keeps earning yield on listed shares until they actually sell (non-custodial)', async () => {
  const c = await world(); const p = await list(c, c.issuer, 10_000n, 10);
  await (await c.market.connect(c.alice).buy(p, 5000n)).wait();
  await (await c.asset.connect(c.alice).approve(await addr(c.market), ethers.MaxUint256)).wait();
  await list(c, c.alice, 5000n, 11);                                            // listed, still in alice's wallet
  await fund(c, c.issuer, 100_000, await c.asset.getAddress());
  await (await c.asset.connect(c.issuer).depositYield(ZAR(100_000), ethers.id('p1'))).wait();
  assert.equal(await c.asset.pendingYield(await addr(c.alice)), ZAR(500));      // 0.5% of 100k
});

test('stale listings are safe: if the seller moved the shares or revoked approval, buy reverts and nobody pays', async () => {
  const c = await world(); const id = await list(c, c.issuer, 1000n, 10);
  await (await c.asset.connect(c.issuer).approve(await addr(c.market), 0n)).wait();
  const before = await c.stable.balanceOf(await addr(c.alice));
  await assert.rejects(c.market.connect(c.alice).buy.staticCall(id, 10n));
  assert.equal(await c.stable.balanceOf(await addr(c.alice)), before);
});

test('listing rules: only factory assets, only eligible sellers with the shares, sane numbers', async () => {
  const c = await world(); const a = await c.asset.getAddress();
  await reverts(c.market.connect(c.issuer).list.staticCall(await addr(c.stable), 1n, 1n), 'NotAnAsset');                // a look-alike token
  await reverts(c.market.connect(c.mallory).list.staticCall(a, 1n, ZAR(1)), 'NotEligible');
  await reverts(c.market.connect(c.alice).list.staticCall(a, 1n, ZAR(1)), 'InsufficientShares');
  await reverts(c.market.connect(c.issuer).list.staticCall(a, 0n, ZAR(1)), 'BadAmount');
  await reverts(c.market.connect(c.issuer).list.staticCall(a, 10n, 0n), 'BadAmount');
});

test('cancel: seller or owner only; self-trade blocked; over-buying blocked', async () => {
  const c = await world(); const id = await list(c, c.issuer, 100n, 10);
  await reverts(c.market.connect(c.alice).cancel.staticCall(id), 'NotAuthorised');
  await reverts(c.market.connect(c.issuer).buy.staticCall(id, 1n), 'SelfTrade');
  await reverts(c.market.connect(c.alice).buy.staticCall(id, 101n), 'BadAmount');
  await (await c.market.connect(c.issuer).cancel(id)).wait();
  await reverts(c.market.connect(c.alice).buy.staticCall(id, 1n), 'NotActive');
});

test('owner controls: pause, fee cap (5%), fee changes', async () => {
  const c = await world(); const id = await list(c, c.issuer, 100n, 10);
  await reverts(c.market.connect(c.owner).setFee.staticCall(501, await addr(c.treasury)), 'FeeTooHigh');
  await (await c.market.connect(c.owner).setFee(0, await addr(c.treasury))).wait();
  const before = await c.stable.balanceOf(await addr(c.issuer));
  await (await c.market.connect(c.alice).buy(id, 10n)).wait();
  assert.equal(await c.stable.balanceOf(await addr(c.issuer)) - before, ZAR(100));
  await (await c.market.connect(c.owner).pause()).wait();
  await reverts(c.market.connect(c.alice).buy.staticCall(id, 1n), 'EnforcedPause');
  await reverts(c.market.connect(c.issuer).list.staticCall(await c.asset.getAddress(), 1n, ZAR(1)), 'EnforcedPause');
});
