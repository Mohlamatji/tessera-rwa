import { Config } from '../Support/Config.js';
import { Eth } from '../Support/Eth.js';
import { AuditLog } from '../Models/AuditLog.js';
import { AssetMetadata, ASSET_CLASSES } from '../Models/Asset.js';
import { KycError } from './KycService.js';

const stable = (o) => JSON.stringify(o, Object.keys(o).sort());

/** Admin-side asset onboarding: build the off-chain dossier, hash it, hand back the exact factory call to sign. */
export const AssetService = {
  prepare(adminLabel, i) {
    const bad = (m) => { throw new KycError(422, m); };
    const name = String(i.name ?? '').trim(), symbol = String(i.symbol ?? '').trim().toUpperCase();
    if (name.length < 3) bad('name is required.');
    if (!/^[A-Z0-9]{2,8}$/.test(symbol)) bad('symbol must be 2-8 letters/digits.');
    if (!Eth.isAddress(i.issuer)) bad('issuer must be a wallet address.');
    const totalShares = Number(i.total_shares), asset_class = Number(i.asset_class ?? 0), min_tier = Number(i.min_tier ?? 1);
    if (!Number.isInteger(totalShares) || totalShares < 1 || totalShares > 1e12) bad('total_shares must be a positive integer.');
    if (!Number.isInteger(asset_class) || asset_class < 0 || asset_class >= ASSET_CLASSES.length) bad('asset_class is invalid.');
    if (![1, 2].includes(min_tier)) bad('min_tier must be 1 (retail) or 2 (accredited).');
    const maxBps = Number(i.max_holder_bps ?? 0);
    if (!Number.isInteger(maxBps) || maxBps < 0 || maxBps > 10000) bad('max_holder_bps must be 0-10000.');

    const dossier = {
      name, symbol, asset_class, description: String(i.description ?? '').slice(0, 1000), location: String(i.location ?? '').slice(0, 120),
      valuation_cents: Math.round(Number(i.valuation_cents) || 0), target_yield_bps: Math.round(Number(i.target_yield_bps) || 0),
      payout_frequency: String(i.payout_frequency ?? 'monthly').slice(0, 20), issuer_name: String(i.issuer_name ?? '').slice(0, 120),
      legal_structure: String(i.legal_structure ?? '').slice(0, 200), issuer: i.issuer.toLowerCase(), nonce: Number(i.nonce) || Date.now(),
    };
    const canonical = stable(dossier);
    const hash = Eth.keccak(Buffer.from(canonical, 'utf8')).toLowerCase();
    AssetMetadata.create({ metadata_hash: hash, ...dossier, image_hue: Math.abs(parseInt(hash.slice(2, 6), 16)) % 360, canonical_json: canonical });
    AuditLog.append(`admin:${adminLabel}`, 'asset.prepared', 'asset_metadata', hash.slice(0, 18));
    return {
      metadata_hash: hash, canonical_json: canonical, factory_address: Config.get('chain.factory_address') || null,
      create_asset_args: { name, symbol, issuer: Eth.checksum(i.issuer), totalShares: String(totalShares), assetClass: asset_class, minTier: min_tier, maxHolderBps: maxBps, documentHash: hash, documentURI: `tessera://dossier/${hash}` },
    };
  },
};
