import { ChainService } from '../Services/ChainService.js';
import { IndexerService } from '../Services/IndexerService.js';
import { Http } from '../Support/Http.js';

/** Chain config for wallets, the public receipt verifier, and operator anchoring of the audit log. */
export class ChainController {
  /** GET /api/chain/config - what a browser wallet needs (no keys). */
  async config() {
    const s = ChainService.status();
    if (s.enabled) { try { s.fee_bps = await ChainService.feeBps(); } catch { s.fee_bps = null; } }
    return [200, s];
  }

  /** POST /api/chain/verify-receipt {receipt} - PUBLIC: authenticity + on-chain evidence, no personal data. */
  async verifyReceipt({ req }) { return [200, await ChainService.verifyReceipt(String((await Http.input(req)).receipt ?? ''))]; }

  // ---- admin
  async anchorPrepare() { const p = ChainService.anchorPrepare(); return [200, { pending: p !== null, ...(p ?? {}), chain: ChainService.status() }]; }

  async anchorRecord({ req }) {
    if (!ChainService.enabled()) return [503, { status: 'error', message: 'On-chain mode is not configured.' }];
    const i = await Http.input(req);
    try { return [200, await ChainService.anchorRecord(String(i.root ?? ''), String(i.tx_hash ?? ''))]; }
    catch (e) { return [502, { status: 'error', message: e.message }]; }
  }

  async anchors() { return [200, { chain: ChainService.status(), anchors: ChainService.anchors() }]; }
  async proof({ query }) { return [200, await ChainService.proofForAudit(Number(query.get('audit_id') || 0))]; }
  indexStatus() { return [200, IndexerService.status()]; }
}
