/** Normalised provider answer. Keep raw vendor payloads out of this object (they may hold personal data). */
export function verificationResult(over = {}) {
  return {
    provider: 'unknown',
    id_check: { status: 'error', reasons: [], dob: null },        // status: match | no_match | error
    sanctions: { hit: false, matches: [] },                        // true -> hard stop
    pep: { hit: false },                                           // true -> enhanced due diligence (manual review)
    country: { prohibited: false, high_risk: false },
    accreditation: { status: 'not_requested' },                    // not_requested | verified | unverified
    source_of_funds: { status: 'not_requested' },                  // not_requested | verified | unverified
    ...over,
  };
}
