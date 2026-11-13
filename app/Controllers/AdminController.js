import { Http } from '../Support/Http.js';
import { View } from '../Support/View.js';
import { AdminAuth } from '../Support/AdminAuth.js';
import { Eth } from '../Support/Eth.js';
import { AuditLog } from '../Models/AuditLog.js';
import { KycDecision } from '../Models/KycDecision.js';
import { User } from '../Models/User.js';
import { AmlAlert, Trade } from '../Models/Asset.js';
import { KycService, KycError } from '../Services/KycService.js';
import { AssetService } from '../Services/AssetService.js';
import { MarketService } from '../Services/MarketService.js';
import { IndexerService } from '../Services/IndexerService.js';
import { RetentionService } from '../Services/RetentionService.js';
import { ChainService } from '../Services/ChainService.js';

const err = (status, message) => [status, { status: 'error', message }];

/** Operator console: login, KYC review queue, AML alerts, asset onboarding, audit log. */
export class AdminController {
  dashboard({ req, res }) { Http.html(res, 200, View.render('dashboard', { csrf: AdminAuth.csrfToken(req) })); }
  loginForm({ res }, error = '') { Http.html(res, error ? 401 : 200, View.render('login', { error })); }

  async login({ req, res }) {
    const r = AdminAuth.attemptLogin(req, (await Http.input(req)).password);
    if (r.error) return this.loginForm({ res }, r.error);
    Http.redirect(res, 'dashboard', { 'Set-Cookie': r.cookie });
  }
  logout({ res }) { Http.redirect(res, 'login', { 'Set-Cookie': AdminAuth.logoutCookie() }); }

  csrf({ req }) { return [200, { csrf: AdminAuth.csrfToken(req) }]; }

  async stats() {
    return [200, {
      market: MarketService.stats(), kyc: KycDecision.counts(), users: User.count(), open_aml_alerts: AmlAlert.list('open').length,
      audit: AuditLog.verifyChain(), anchored_up_to: ChainService.lastAnchoredId(), index: IndexerService.status(), chain: ChainService.status(),
    }];
  }

  async kycList({ query }) {
    const rows = KycDecision.list({ decision: query.get('decision') || null });
    return [200, { decisions: await Promise.all(rows.map((d) => KycService.view(d, { admin: true }).then(({ claim, receipt, ...v }) => v))) }];
  }

  async kycResolve({ req, match }) {
    try { const d = KycService.resolveReview('admin', Number(match[1]), String((await Http.input(req)).action ?? '')); return [200, { status: 'ok', decision: d.decision }]; }
    catch (e) { if (e instanceof KycError) return err(e.status, e.message); throw e; }
  }

  amlAlerts({ query }) { return [200, { alerts: AmlAlert.list(query.get('status') || null) }]; }

  amlDismiss({ match }) {
    const a = AmlAlert.find(Number(match[1]));
    if (!a) return err(404, 'Unknown alert.');
    AmlAlert.resolve(a.id, 'dismissed');
    AuditLog.append('admin', 'aml.alert_dismissed', 'aml_alerts', a.id);
    return [200, { status: 'ok' }];
  }

  async assetPrepare({ req }) {
    try { return [200, AssetService.prepare('admin', await Http.input(req))]; }
    catch (e) { if (e instanceof KycError) return err(e.status, e.message); throw e; }
  }

  /** MOCK custodian: sign a backing attestation (full, or a simulated shortfall) for the operator's wallet to relay on-chain. */
  async backingPrepare({ req }) {
    const i = await Http.input(req);
    if (!['full', 'shortfall'].includes(i.mode)) return err(422, 'mode must be "full" or "shortfall".');
    try {
      const out = await ChainService.prepareAttestation({ asset: String(i.asset ?? ''), mode: i.mode, backedShares: i.backed_shares ?? null, evidence: String(i.evidence ?? '') });
      AuditLog.append('admin', `backing.attestation_prepared_${i.mode}`, 'assets', out.attestation.asset);
      return [200, out];
    } catch (e) { return err(422, e.message); }
  }

  async trades() { await IndexerService.syncIfStale(); return [200, { trades: Trade.recent(100) }]; }
  auditLog() { return [200, { entries: AuditLog.list(200) }]; }
  auditVerify() { return [200, AuditLog.verifyChain()]; }
  retention() { return [200, RetentionService.run()]; }
  async sync() { return [200, { status: 'ok', ...(await IndexerService.sync()) }]; }
  walletCheck({ query }) { const a = query.get('address'); return Eth.isAddress(a) ? [200, { address: Eth.checksum(a) }] : err(422, 'Invalid address.'); }
}
