import { Config } from '../Support/Config.js';
import { getDb } from '../../config/database.js';
import { AuditLog } from '../Models/AuditLog.js';
import { KycDecision } from '../Models/KycDecision.js';
import { ChainService } from './ChainService.js';
import { MockMobileMoney } from './PayoutAdapters/MockMobileMoney.js';

export class PayoutError extends Error { constructor(status, message) { super(message); this.status = status; } }

const adapter = () => MockMobileMoney; // swap by PAYOUT_PROVIDER once a real adapter exists

const view = (r) => {
  const age = Math.floor(Date.now() / 1000) - r.created_at, settle = Config.get('payouts.settle_seconds');
  return { id: r.id, tx_hash: r.tx_hash, amount: r.amount, fee: r.fee, net: r.net, to: r.msisdn_masked, network: r.network, reference: r.provider_ref,
    status: age >= settle ? 'paid' : 'processing', simulated: r.provider === 'mock', created_at: r.created_at, explorer_url: ChainService.explorerTx(r.tx_hash) };
};

/** Path back to cash: stablecoin sent on-chain to the off-ramp address is paid out to the investor's mobile-money wallet. */
export const PayoutService = {
  options() { return { networks: adapter().networks, ...ChainService.status().cashout }; },

  async create(wallet, { tx_hash, msisdn, network }, ip = null) {
    if (!ChainService.status().cashout.enabled) throw new PayoutError(503, 'Cash-out is not configured on this server.');
    if (!KycDecision.latestApprovedForWallet(wallet)) throw new PayoutError(403, 'Only verified investors can cash out. Complete "Get verified" first.');
    if (!adapter().validMsisdn(msisdn)) throw new PayoutError(422, 'Enter the mobile number in international format, e.g. +27821234567.');
    if (!adapter().networks.includes(network)) throw new PayoutError(422, 'Choose a mobile-money network from the list.');
    const db = getDb();
    if (db.prepare('SELECT 1 FROM payouts WHERE tx_hash = ?').get(String(tx_hash).toLowerCase())) throw new PayoutError(409, 'That transfer has already been paid out.');

    let t; try { t = await ChainService.verifyStablecoinTransfer(String(tx_hash), wallet); } catch (e) { throw new PayoutError(422, e.message); }
    const dec = BigInt(Config.get('chain.token_decimals')), cents = (t.amount * 100n) / 10n ** dec;
    if (cents < BigInt(Config.get('payouts.min_cents'))) throw new PayoutError(422, 'That is below the minimum cash-out amount.');
    if (cents > BigInt(Config.get('payouts.max_cents'))) throw new PayoutError(422, 'That is above the maximum cash-out amount.');
    const fee = (t.amount * BigInt(Config.get('payouts.fee_bps'))) / 10_000n, net = t.amount - fee;

    const { provider_ref } = await adapter().send({ msisdn, network, netAmount: net.toString(), reference: tx_hash });
    const created = Math.floor(Date.now() / 1000);
    const { lastInsertRowid } = db.prepare('INSERT INTO payouts (wallet, tx_hash, amount, fee, net, msisdn_masked, network, provider, provider_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(wallet, String(tx_hash).toLowerCase(), t.amount.toString(), fee.toString(), net.toString(), adapter().mask(msisdn), network, adapter().name, provider_ref, created);
    AuditLog.append(`wallet:${wallet}`, 'payout.requested', 'payouts', Number(lastInsertRowid), ip);
    return view(db.prepare('SELECT * FROM payouts WHERE id = ?').get(Number(lastInsertRowid)));
  },

  list(wallet) { return getDb().prepare('SELECT * FROM payouts WHERE wallet = ? ORDER BY id DESC LIMIT 20').all(wallet).map(view); },
};
