/** Data-retention windows (days) applied by RetentionService. POPIA/GDPR: keep personal data no longer than needed. */
export default {
  rejected_kyc_pii_days: 90,       // PII of rejected applicants is wiped after this
  expired_challenges_days: 1,      // wallet sign-in nonces
  rate_limit_hits_days: 2,
  // Audit-log entries are never deleted (they hold no personal data - only opaque ids/actions).
};
