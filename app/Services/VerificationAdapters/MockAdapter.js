import providers from '../../../config/providers.js';
import { SaId } from '../../Support/SaId.js';
import { verificationResult } from './VerificationResult.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Deterministic, credential-free provider for demos and tests. Rules:
 *  - za_id numbers are fully validated (Luhn, real date, DOB agrees); passports need 6-12 alphanumerics
 *  - names on the mock sanctions / PEP lists (config/providers.js) hit those screens
 *  - evidence references starting with "evd_" count as verified accreditation / source-of-funds proof
 *  - a full name of "Provider Outage" simulates a vendor failure (fails closed)
 */
export class MockAdapter {
  name = 'mock';

  async verify(p) {
    const cfg = providers.mock;
    if (norm(p.full_name) === 'provider outage') throw new Error('mock provider outage');

    let id_check;
    if (p.id_type === 'za_id') {
      const r = SaId.inspect(p.id_number, p.dob);
      id_check = { status: r.valid ? 'match' : 'no_match', reasons: r.reason ? [r.reason] : [], dob: r.dob };
    } else {
      const ok = /^[A-Za-z0-9]{6,12}$/.test(String(p.id_number ?? ''));
      id_check = { status: ok ? 'match' : 'no_match', reasons: ok ? [] : ['Passport number must be 6-12 letters/digits.'], dob: p.dob };
    }

    const name = norm(p.full_name);
    const sanctionsHit = cfg.sanctions_names.includes(name);
    const country = String(p.country ?? '').toUpperCase();
    const ev = (ref) => (typeof ref === 'string' && ref.startsWith(cfg.accepted_evidence_prefix));

    return verificationResult({
      provider: this.name,
      id_check,
      sanctions: { hit: sanctionsHit, matches: sanctionsHit ? [{ list: 'mock-sanctions', name }] : [] },
      pep: { hit: cfg.pep_names.includes(name) },
      country: { prohibited: cfg.prohibited_countries.includes(country), high_risk: cfg.high_risk_countries.includes(country) },
      accreditation: { status: p.investor_type === 'accredited' ? (ev(p.accreditation?.evidence_ref) ? 'verified' : 'unverified') : 'not_requested' },
      source_of_funds: { status: p.source_of_funds_required ? (ev(p.source_of_funds_evidence_ref) ? 'verified' : 'unverified') : 'not_requested' },
    });
  }
}
