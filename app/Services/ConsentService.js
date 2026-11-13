import { Consent } from '../Models/KycDecision.js';
import { AuditLog } from '../Models/AuditLog.js';

export const CONSENT_PURPOSE = 'kyc_processing';
export const CONSENT_VERSION = '2026-11';

/** POPIA/GDPR: personal data is processed for KYC/AML only after explicit, versioned, revocable consent. */
export const ConsentService = {
  grant(wallet, ip = null) {
    Consent.grant(wallet, CONSENT_PURPOSE, CONSENT_VERSION);
    AuditLog.append(`wallet:${wallet}`, 'consent.granted', 'wallets', wallet, ip);
    return { purpose: CONSENT_PURPOSE, version: CONSENT_VERSION };
  },
  has(wallet) { return Boolean(Consent.active(wallet, CONSENT_PURPOSE)); },
  revoke(wallet, ip = null) {
    Consent.revoke(wallet, CONSENT_PURPOSE);
    AuditLog.append(`wallet:${wallet}`, 'consent.revoked', 'wallets', wallet, ip);
  },
};
