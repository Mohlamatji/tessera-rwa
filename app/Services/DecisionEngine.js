import { Config } from '../Support/Config.js';

const ageOn = (dob, now) => {
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return -1;
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
};

/**
 * Explainable KYC/AML decision. Pure function (no I/O) so it is trivially testable.
 *
 *  1. HARD GATES no score can override: adult, identity matches, sanctions clear, jurisdiction permitted.
 *  2. SOFT FLAGS that force a human: PEP hit, high-risk jurisdiction, missing source-of-funds proof,
 *     provider outage (fail closed).
 *  3. SCORE of named factors, compared with approve/review thresholds.
 *  4. TIER: tier 2 (accredited) only with declared wealth/income over the threshold AND verified evidence;
 *     otherwise a verified accredited applicant is approved at tier 1 and told what evidence is missing.
 *
 * Every factor and gate is returned so analysts (and the applicant, where safe) can see why.
 */
export const DecisionEngine = {
  evaluate({ profile, result, providerError = false, now = new Date() }) {
    const cfg = Config.get('kyc');
    const factors = [], gates = [], flags = [];
    const gate = (code, passed, detail) => gates.push({ code, passed, detail });
    const factor = (code, points, detail) => factors.push({ code, points, detail });

    if (providerError || !result) {
      gate('provider_available', false, 'Verification provider unavailable - failing closed.');
      return { decision: 'review', tier: 0, score: 0, engine: cfg.engine_version, factors, gates, required_action: 'retry_verification', flags: ['provider_outage'] };
    }

    // ---- hard gates
    const age = ageOn(profile.dob, now);
    gate('adult', age >= cfg.min_age, age >= cfg.min_age ? `Age ${age}.` : `Must be at least ${cfg.min_age}.`);
    gate('identity_match', result.id_check.status === 'match', result.id_check.status === 'match' ? 'Identity document verified.' : (result.id_check.reasons[0] || 'Identity could not be verified.'));
    gate('sanctions_clear', !result.sanctions.hit, result.sanctions.hit ? 'Sanctions screening hit.' : 'No sanctions match.');
    gate('jurisdiction_permitted', !result.country.prohibited, result.country.prohibited ? 'Prohibited jurisdiction.' : 'Jurisdiction permitted.');
    const failed = gates.filter((g) => !g.passed);

    // ---- score
    if (result.id_check.status === 'match') factor('identity_verified', 30, 'Document and number verified.');
    if (result.id_check.status === 'match' && result.id_check.dob === profile.dob) factor('dob_consistent', 10, 'Declared date of birth matches the document.');
    if (!result.sanctions.hit) factor('sanctions_clear', 20, 'No sanctions match.');
    if (!result.pep.hit) factor('pep_clear', 15, 'Not a politically exposed person.');
    else flags.push('pep');
    if (!result.country.high_risk && !result.country.prohibited) factor('jurisdiction_standard', 10, 'Standard-risk jurisdiction.');
    else if (result.country.high_risk) flags.push('high_risk_jurisdiction');

    const sofNeeded = Number(profile.intended_investment_cents || 0) >= cfg.sof_required_cents;
    if (sofNeeded) {
      if (result.source_of_funds.status === 'verified') factor('source_of_funds_verified', 15, 'Source-of-funds evidence verified.');
      else flags.push('source_of_funds_missing');
    } else factor('source_of_funds_not_required', 10, 'Intended investment below the enhanced-checks threshold.');

    const score = factors.reduce((s, f) => s + f.points, 0);

    // ---- tier
    let tier = 1, tierNote = 'retail';
    let requiredAction = null;
    if (profile.investor_type === 'accredited') {
      const a = profile.accreditation || {};
      const wealthy = Number(a.net_worth_cents || 0) >= cfg.accredited_net_worth_cents || Number(a.annual_income_cents || 0) >= cfg.accredited_income_cents;
      if (wealthy && result.accreditation.status === 'verified') { tier = 2; tierNote = 'accredited'; }
      else { requiredAction = 'submit_accreditation_evidence'; tierNote = 'retail (accreditation not established)'; }
    }
    factor('investor_category', 0, `Category: ${tierNote}.`);

    // ---- outcome
    let decision;
    if (failed.length) { decision = 'rejected'; tier = 0; requiredAction = null; }
    else if (flags.length) { decision = 'review'; requiredAction = flags.includes('source_of_funds_missing') && flags.length === 1 ? 'provide_source_of_funds' : 'manual_review'; }
    else if (score >= cfg.approve_threshold) decision = 'approved';
    else if (score >= cfg.review_threshold) { decision = 'review'; requiredAction = 'manual_review'; }
    else { decision = 'rejected'; tier = 0; requiredAction = null; }

    return { decision, tier, score, engine: cfg.engine_version, factors, gates, required_action: requiredAction, flags };
  },
};
