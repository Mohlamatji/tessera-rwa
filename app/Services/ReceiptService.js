import { Config } from '../Support/Config.js';
import { Tokens } from '../Support/Tokens.js';

const PREFIX = 'tsrr_';

/**
 * Signed KYC decision receipts (HMAC). The holder can hand one to a regulator, bank or counterparty;
 * /verify checks it is genuine and unaltered without calling any private API. It carries NO personal
 * data - only the opaque decision id, outcome, tier, score and engine version.
 */
export const ReceiptService = {
  issue(d) {
    const iat = Math.floor(Date.now() / 1000);
    return Tokens.sign({ did: d.decision_id, dec: d.decision, tier: d.tier, score: d.score, eng: d.engine, iat, exp: iat + Config.get('tokens.receipt_ttl') }, 'receipt', PREFIX);
  },
  verify(token) { return Tokens.verify(String(token ?? '').trim(), 'receipt', PREFIX); },
};
