import { Config } from '../Support/Config.js';
import { Eth } from '../Support/Eth.js';
import { SaId } from '../Support/SaId.js';
import { AuditLog } from '../Models/AuditLog.js';
import { User, Wallet } from '../Models/User.js';
import { KycDecision } from '../Models/KycDecision.js';
import { AdapterFactory } from './VerificationAdapters/AdapterFactory.js';
import { DecisionEngine } from './DecisionEngine.js';
import { EncryptionService } from './EncryptionService.js';
import { ConsentService } from './ConsentService.js';
import { ReceiptService } from './ReceiptService.js';
import { ChainService } from './ChainService.js';
import { IndexerService } from './IndexerService.js';
import { RateLimitService } from './RateLimitService.js';

const ACTIONS_SAFE = { manual_review: 'under_review', retry_verification: 'retry_verification', provide_source_of_funds: 'provide_source_of_funds', submit_accreditation_evidence: 'submit_accreditation_evidence' };
const MESSAGES = {
  approved: 'You are verified. Register your verification on-chain to start investing.',
  review: 'Your application needs a quick manual review. We will update this page - no action needed unless asked below.',
  rejected: 'We could not approve your application.',
};
export class KycError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }

const money = (v) => (v === undefined || v === null || v === '' ? 0 : Math.round(Number(v)));

/** Orchestrates identity verification -> explainable decision -> signed on-chain claim. */
export const KycService = {
  validate(i) {
    const s = (v, max = 120) => String(v ?? '').trim().slice(0, max);
    const p = {
      full_name: s(i.full_name), dob: s(i.dob, 10), country: s(i.country, 2).toUpperCase(),
      id_type: s(i.id_type || 'za_id', 10), id_number: s(i.id_number, 32).replace(/\s+/g, ''),
      investor_type: s(i.investor_type || 'retail', 12),
      accreditation: { net_worth_cents: money(i.accreditation?.net_worth_cents), annual_income_cents: money(i.accreditation?.annual_income_cents), evidence_ref: s(i.accreditation?.evidence_ref, 64) },
      intended_investment_cents: money(i.intended_investment_cents),
      source_of_funds: s(i.source_of_funds, 200), source_of_funds_evidence_ref: s(i.source_of_funds_evidence_ref, 64),
    };
    const bad = (m) => { throw new KycError(422, m); };
    if (p.full_name.length < 3) bad('Full name is required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dob)) bad('Date of birth must be YYYY-MM-DD.');
    if (!/^[A-Z]{2}$/.test(p.country)) bad('Country must be a 2-letter ISO code.');
    if (!['za_id', 'passport'].includes(p.id_type)) bad('id_type must be za_id or passport.');
    if (p.id_number.length < 6) bad('ID / passport number is required.');
    if (!['retail', 'accredited'].includes(p.investor_type)) bad('investor_type must be retail or accredited.');
    if (p.intended_investment_cents < 0) bad('Intended investment cannot be negative.');
    p.source_of_funds_required = p.intended_investment_cents >= Config.get('kyc.sof_required_cents');
    return p;
  },

  async submit(wallet, input, ip = null) {
    if (!ConsentService.has(wallet)) throw new KycError(403, 'Consent to KYC processing is required first.', { code: 'consent_required' });
    if (!RateLimitService.allow(RateLimitService.bucketKey(wallet, 'kyc_submit'), 5, 3600)) throw new KycError(429, 'Too many verification attempts. Try again later.');
    const profile = KycService.validate(input);

    const idHash = EncryptionService.blindIndex(`${profile.id_type}:${profile.id_number}`);
    let user = User.findByIdHash(idHash);
    if (user && user.deleted_at) throw new KycError(409, 'This identity can no longer be used.');
    if (!user) {
      const id = User.create({ id_number_hash: idHash, full_name_enc: EncryptionService.encrypt(profile.full_name), dob_enc: EncryptionService.encrypt(profile.dob), country: profile.country, investor_type: profile.investor_type });
      user = User.find(id);
    } else User.update(user.id, { investor_type: profile.investor_type, country: profile.country });
    if (!Wallet.bind(wallet, user.id)) throw new KycError(409, 'This wallet is already linked to a different verified person.');
    AuditLog.append(`wallet:${wallet}`, 'kyc.submitted', 'users', user.id, ip);

    let result = null, providerError = false;
    const adapter = AdapterFactory.create();
    try { result = await adapter.verify(profile); } catch (e) { providerError = true; console.error('[tessera] verification provider error:', e.message); }

    const out = DecisionEngine.evaluate({ profile, result, providerError });
    const decisionId = Eth.newDecisionId();
    const rowId = KycDecision.create({
      decision_id: decisionId, user_id: user.id, wallet, decision: out.decision, tier: out.tier, score: out.score, engine: out.engine,
      factors: out.factors, gates: out.gates, required_action: out.required_action, provider: adapter.name,
      claim_expiry: out.decision === 'approved' ? Math.floor(Date.now() / 1000) + Config.get('kyc.valid_days') * 86400 : null,
    });
    AuditLog.append(`wallet:${wallet}`, `kyc.${out.decision}`, 'kyc_decisions', rowId, ip);
    return KycService.view(KycDecision.find(rowId));
  },

  /** Customer-safe view: never discloses sanctions/PEP/jurisdiction outcomes (tipping-off), only fixable issues. */
  async view(d, { admin = false } = {}) {
    if (!d) return null;
    const v = {
      id: d.id, decision_id: d.decision_id, status: d.decision, tier: d.tier, message: MESSAGES[d.decision], registered: Boolean(d.registered_tx),
      required_action: d.required_action ? ACTIONS_SAFE[d.required_action] ?? null : null,
      fixable_issues: d.gates.filter((g) => !g.passed && ['adult', 'identity_match'].includes(g.code)).map((g) => g.detail),
      valid_until: d.claim_expiry ? new Date(d.claim_expiry * 1000).toISOString() : null, receipt: ReceiptService.issue(d), created_at: d.created_at,
    };
    if (admin) { v.score = d.score; v.engine = d.engine; v.factors = d.factors; v.gates = d.gates; v.wallet = d.wallet; v.provider = d.provider; v.raw_required_action = d.required_action; v.resolved_by = d.resolved_by; }
    if (d.decision === 'approved' && !d.registered_tx) {
      const c = await ChainService.issueClaim(d);
      if (c) v.claim = c;
    }
    return v;
  },

  async status(wallet) {
    const d = KycDecision.latestForWallet(wallet);
    const v = d ? await KycService.view(d) : { status: 'none', message: 'Not verified yet.' };
    v.on_chain_tier = null;
    try { v.on_chain_tier = await ChainService.tierOf(wallet); } catch { /* chain unreachable */ }
    v.consent = ConsentService.has(wallet);
    return v;
  },

  /** Analyst resolves a 'review' decision. Approval starts the on-chain validity clock. */
  resolveReview(adminLabel, id, action) {
    const d = KycDecision.find(id);
    if (!d) throw new KycError(404, 'Unknown decision.');
    if (d.decision !== 'review') throw new KycError(409, 'Only decisions under review can be resolved.');
    if (!['approve', 'reject'].includes(action)) throw new KycError(422, 'action must be approve or reject.');
    if (action === 'approve') {
      if (d.gates.some((g) => !g.passed)) throw new KycError(409, 'A hard gate failed; this cannot be approved.');
      KycDecision.update(id, { decision: 'approved', tier: Math.max(d.tier, 1), required_action: null, claim_expiry: Math.floor(Date.now() / 1000) + Config.get('kyc.valid_days') * 86400, resolved_by: adminLabel });
    } else KycDecision.update(id, { decision: 'rejected', tier: 0, required_action: null, resolved_by: adminLabel });
    AuditLog.append(`admin:${adminLabel}`, `kyc.review_${action === 'approve' ? 'approved' : 'rejected'}`, 'kyc_decisions', id);
    return KycDecision.find(id);
  },

  /** The investor says they registered on-chain; we verify the tx ourselves rather than trust them. */
  async confirmRegistration(wallet, txHash) {
    const d = KycDecision.latestApprovedForWallet(wallet);
    if (!d) throw new KycError(404, 'No approved verification for this wallet.');
    let ev;
    try { ev = await ChainService.verifyRegistration(txHash, wallet); } catch (e) { throw new KycError(422, e.message); }
    if (ev.decision_id.toLowerCase() !== d.decision_id.toLowerCase()) throw new KycError(409, 'That registration is for a different decision.');
    if (!d.registered_tx) { KycDecision.markRegistered(d.id, txHash); AuditLog.append(`wallet:${wallet}`, 'kyc.registered_on_chain', 'kyc_decisions', d.id); }
    IndexerService.syncIfStale(0).catch(() => {});
    return { status: 'registered', tier: ev.tier, expiry: ev.expiry };
  },
};
