/**
 * Identity-verification provider selection + the mock provider's screening lists.
 *
 * VERIFICATION_PROVIDER=mock (default) needs no credentials. A real deployment implements
 * app/Services/VerificationAdapters/VerificationAdapterInterface.js against its KYC vendor
 * (document + liveness check, sanctions/PEP screening) and registers it in AdapterFactory.js.
 *
 * The lists below are ILLUSTRATIVE test data for the mock provider only - they are NOT real
 * sanctions or PEP data. Real screening must use an authoritative, regularly updated source.
 */
export default {
  provider: process.env.VERIFICATION_PROVIDER || 'mock',

  mock: {
    // Names (normalised, lower-case) that the mock sanctions screen "hits".
    sanctions_names: ['test sanctioned', 'ivan sanctionov'],
    // Names the mock PEP screen flags (needs enhanced due diligence -> manual review).
    pep_names: ['test politician', 'polly exposed'],
    // ISO-3166 alpha-2. Illustrative only.
    prohibited_countries: ['KP', 'IR'],
    high_risk_countries: ['MM', 'SY', 'YE'],
    // Evidence references the mock accepts as proof of accreditation / source of funds.
    accepted_evidence_prefix: 'evd_',
  },
};
