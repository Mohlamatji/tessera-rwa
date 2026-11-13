/**
 * Contract every KYC/AML provider adapter implements. Wire a real vendor (document + liveness
 * check, sanctions/PEP screening, accreditation evidence) by implementing this and registering
 * it in AdapterFactory.js - nothing else in the app changes.
 *
 * profile = {
 *   full_name, dob (YYYY-MM-DD), country (ISO alpha-2), id_type ('za_id'|'passport'), id_number,
 *   investor_type ('retail'|'accredited'), accreditation: { net_worth_cents, annual_income_cents, evidence_ref },
 *   intended_investment_cents, source_of_funds, source_of_funds_evidence_ref
 * }
 * returns Promise<VerificationResult> (see VerificationResult.js). Throwing is treated as a provider
 * outage and fails CLOSED (the decision engine routes it to manual review, never to approval).
 */
export const REQUIRED_METHODS = ['name', 'verify'];

export function assertAdapter(a) {
  for (const m of REQUIRED_METHODS) if (!(m in a)) throw new Error(`Verification adapter is missing "${m}".`);
  return a;
}
