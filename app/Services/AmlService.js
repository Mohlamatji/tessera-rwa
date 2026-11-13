import { Config } from '../Support/Config.js';
import { AmlAlert, Trade } from '../Models/Asset.js';
import { Wallet } from '../Models/User.js';
import { AuditLog } from '../Models/AuditLog.js';

/**
 * Ongoing AML transaction monitoring over indexed on-chain trades. Rules are deliberately simple and
 * explainable; each raises an alert for a human to review (and, if warranted, freeze the wallet
 * on-chain via ComplianceRegistry.freeze). Alerts hold wallet addresses and amounts only.
 *
 * Rules: large_trade, velocity, fast_flip (buy then quickly sell), wash_trade (both sides are wallets of
 * the same verified person - the off-chain wallet<->person link is what makes this detectable).
 */
export const AmlService = {
  valueCents(t) {
    const dec = Config.get('chain.token_decimals');
    return Number((BigInt(t.amount) * BigInt(t.price_per_share)) / 10n ** BigInt(Math.max(dec - 2, 0)));
  },

  /** @param {object} t a trade row (with id) @param {string|null} issuer the asset's issuer (primary sales are exempt from fast_flip) */
  evaluateTrade(t, issuer = null) {
    const cfg = Config.get('aml');
    const raised = [];
    const raise = (rule, severity, wallet, detail) => {
      if (AmlAlert.exists(rule, wallet, t.id)) return;
      const id = AmlAlert.create({ rule, severity, wallet, detail, trade_id: t.id });
      AuditLog.append('aml-monitor', `aml.alert.${rule}`, 'aml_alerts', id);
      raised.push(rule);
    };
    const value = AmlService.valueCents(t);

    if (value >= cfg.large_trade_cents) raise('large_trade', 'medium', t.buyer, { value_cents: value, asset: t.asset, threshold_cents: cfg.large_trade_cents });

    const recent = Trade.byWalletSince(t.buyer, (t.block_time || 0) - cfg.velocity_window_seconds);
    if (recent.length >= cfg.velocity_count) raise('velocity', 'medium', t.buyer, { trades_in_window: recent.length, window_seconds: cfg.velocity_window_seconds });

    if (cfg.wash_trade) {
      const a = Wallet.userIdOf(t.buyer), b = Wallet.userIdOf(t.seller);
      if (a !== null && a === b) raise('wash_trade', 'high', t.buyer, { counterparty: t.seller, note: 'Both wallets are controlled by the same verified person.' });
    }

    if (t.seller !== issuer) {
      const bought = Trade.byWalletSince(t.seller, (t.block_time || 0) - cfg.fast_flip_seconds).filter((x) => x.buyer === t.seller && x.asset === t.asset && x.id !== t.id);
      if (bought.length) raise('fast_flip', 'low', t.seller, { asset: t.asset, held_seconds_max: cfg.fast_flip_seconds });
    }
    return raised;
  },
};
