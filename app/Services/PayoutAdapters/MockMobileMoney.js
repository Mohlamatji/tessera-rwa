import crypto from 'node:crypto';

/**
 * SIMULATED mobile-money off-ramp. No money moves anywhere. It exists so the whole "token -> cash in a phone wallet"
 * journey can be demonstrated end to end on a testnet.
 *
 * To make it real, implement the same two methods against a licensed partner (a stablecoin off-ramp provider and/or a
 * mobile-money aggregator / bank with the right FSCA / SARB / local e-money licences) and select it with PAYOUT_PROVIDER.
 */
export const NETWORKS = ['MTN MoMo', 'Vodacom M-Pesa', 'Airtel Money', 'Orange Money'];

export const MockMobileMoney = {
  name: 'mock',
  networks: NETWORKS,
  /** E.164 number, 9-14 digits after '+'. */
  validMsisdn: (m) => /^\+[1-9]\d{8,13}$/.test(String(m ?? '')),
  mask: (m) => String(m).slice(0, 3) + '•'.repeat(Math.max(0, String(m).length - 7)) + String(m).slice(-4),
  /** "Sends" the money: returns a provider reference. Nothing leaves this process. */
  async send({ msisdn, network, netAmount, reference }) {
    return { provider_ref: 'SIM-' + crypto.createHash('sha256').update([msisdn, network, netAmount, reference].join('|')).digest('hex').slice(0, 12).toUpperCase() };
  },
};
