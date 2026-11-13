import { Config } from '../Support/Config.js';
import { Asset, ASSET_CLASSES, Holding, Listing, Trade, YieldEvent } from '../Models/Asset.js';
import { ChainService } from './ChainService.js';

const shape = (a) => {
  const listings = Listing.active(a.address);
  const best = listings[0] ?? null, last = Trade.last(a.address);
  const t = YieldEvent.totals(a.address);
  const available = listings.reduce((s, l) => s + BigInt(l.remaining), 0n);
  const ref = last?.price_per_share ?? best?.price_per_share ?? null;
  return {
    address: a.address, name: a.name, symbol: a.symbol, asset_class: a.asset_class, asset_class_name: ASSET_CLASSES[a.asset_class] ?? 'Other',
    issuer: a.issuer, total_shares: a.total_shares, min_tier: a.min_tier, document_hash: a.document_hash,
    description: a.description ?? null, location: a.location ?? null, valuation_cents: a.valuation_cents ?? null, target_yield_bps: a.target_yield_bps ?? null,
    payout_frequency: a.payout_frequency ?? null, issuer_name: a.issuer_name ?? null, legal_structure: a.legal_structure ?? null, image_hue: a.image_hue ?? 210,
    dossier_verified: a.valuation_cents !== null && a.valuation_cents !== undefined, // the off-chain dossier hashes to the on-chain document hash
    best_ask: best?.price_per_share ?? null, last_price: last?.price_per_share ?? null,
    market_cap: ref ? (BigInt(ref) * BigInt(a.total_shares)).toString() : null,
    shares_for_sale: available.toString(), listings: listings.length, holders: Holding.holderCount(a.address),
    yield_deposited: t.deposited.toString(), yield_claimed: t.claimed.toString(),
  };
};

export const MarketService = {
  assets() { return Asset.all().map(shape); },

  detail(address) {
    const a = Asset.find(address);
    if (!a) return null;
    return {
      ...shape(a),
      order_book: Listing.active(a.address).map((l) => ({ id: l.id, seller: l.seller, remaining: l.remaining, price_per_share: l.price_per_share })),
      trades: Trade.forAsset(a.address, 20).map((t) => ({ tx_hash: t.tx_hash, buyer: t.buyer, seller: t.seller, amount: t.amount, price_per_share: t.price_per_share, time: t.block_time })),
      yield_history: YieldEvent.forAsset(a.address, 'deposit', 24).map((y) => ({ amount: y.amount, time: y.block_time, tx_hash: y.tx_hash })),
      top_holders: Holding.holders(a.address).slice(0, 5),
    };
  },

  async portfolio(wallet) {
    const assets = Asset.all();
    const chain = ChainService.enabled();
    const pos = chain ? await ChainService.positions(wallet, assets.map((a) => a.address)) : [];
    const positions = pos.filter((p) => p.shares !== '0' || p.pending_yield !== '0' || p.claimed_yield !== '0').map((p) => {
      const a = assets.find((x) => x.address === p.asset), s = shape(a);
      const px = s.last_price ?? s.best_ask;
      return { ...p, name: a.name, symbol: a.symbol, last_price: px, value: px ? (BigInt(px) * BigInt(p.shares)).toString() : null,
        my_listings: Listing.active(a.address).filter((l) => l.seller === wallet).map((l) => ({ id: l.id, remaining: l.remaining, price_per_share: l.price_per_share })) };
    });
    const totalPending = positions.reduce((s, p) => s + BigInt(p.pending_yield), 0n);
    return { wallet, positions, total_pending_yield: totalPending.toString(), stable_balance: chain ? await ChainService.stableBalance(wallet) : null };
  },

  stats() {
    const assets = MarketService.assets();
    const trades = Trade.all();
    const vol = trades.reduce((s, t) => s + BigInt(t.amount) * BigInt(t.price_per_share), 0n);
    const dep = assets.reduce((s, a) => s + BigInt(a.yield_deposited), 0n);
    const tvl = assets.reduce((s, a) => s + BigInt(a.market_cap ?? 0), 0n);
    return { assets: assets.length, trades: trades.length, volume: vol.toString(), yield_distributed: dep.toString(), tokenized_value: tvl.toString(), decimals: Config.get('chain.token_decimals') };
  },
};
