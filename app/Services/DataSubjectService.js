import { User, Wallet } from '../Models/User.js';
import { KycDecision, Consent } from '../Models/KycDecision.js';
import { AmlAlert } from '../Models/Asset.js';
import { AuditLog } from '../Models/AuditLog.js';
import { EncryptionService } from './EncryptionService.js';
import { KycError } from './KycService.js';

/** POPIA / GDPR data-subject rights: export what we hold; erase what the law allows. */
export const DataSubjectService = {
  export(wallet) {
    const u = User.findByWallet(wallet);
    if (!u) throw new KycError(404, 'No personal data is held for this wallet.');
    const wallets = Wallet.forUser(u.id);
    AuditLog.append(`wallet:${wallet}`, 'data_subject.export', 'users', u.id);
    return {
      profile: { full_name: EncryptionService.decrypt(u.full_name_enc), dob: EncryptionService.decrypt(u.dob_enc), country: u.country, investor_type: u.investor_type, created_at: u.created_at },
      wallets, consents: Consent.forWallets(wallets),
      decisions: KycDecision.forUser(u.id).map((d) => ({ decision_id: d.decision_id, decision: d.decision, tier: d.tier, created_at: d.created_at, registered_on_chain: Boolean(d.registered_tx) })),
      on_chain_note: 'Wallet addresses, tiers and opaque decision ids on the blockchain are pseudonymous and cannot be erased.',
    };
  },

  /** Erases personal data and unlinks wallets. Refused while an AML alert is open (regulatory hold). */
  erase(wallet) {
    const u = User.findByWallet(wallet);
    if (!u) throw new KycError(404, 'No personal data is held for this wallet.');
    const wallets = Wallet.forUser(u.id);
    if (wallets.some((w) => AmlAlert.openFor(w) > 0)) throw new KycError(409, 'An open compliance review prevents erasure right now.', { code: 'regulatory_hold' });
    User.update(u.id, { full_name_enc: null, dob_enc: null, country: null, id_number_hash: `erased:${u.id}`, deleted_at: new Date().toISOString() });
    Wallet.unlinkUser(u.id);
    for (const w of wallets) Consent.revoke(w, 'kyc_processing');
    AuditLog.append(`wallet:${wallet}`, 'data_subject.erased', 'users', u.id);
    return {
      status: 'erased', wallets_unlinked: wallets.length,
      on_chain_note: 'On-chain records are pseudonymous and immutable; ask the operator to revoke your registry record if you no longer wish to be eligible. Regulated record-keeping duties may require the operator to retain some compliance records - confirm with counsel.',
    };
  },
};
