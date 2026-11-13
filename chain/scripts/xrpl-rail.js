// Transaction builders for Tessera's XRP Ledger rail. Every Tessera control maps to a native MPT transaction - no smart contract.
//
//   identity gate   opt-in by the holder (MPTokenAuthorize) + authorisation by the issuer AFTER KYC (MPTokenAuthorize + Holder)
//   share transfer  Payment with an MPT amount (an unauthorised holder cannot receive it: the ledger refuses)
//   freeze          MPTokenIssuanceSet + Holder + tfMPTLock      (one holder)    |  without Holder: lock the whole issuance
//   recover         Clawback (issuer takes the shares back) and then a Payment to the replacement wallet
//
// Each builder validates the transaction with xrpl.js before returning it.
import { MPTokenIssuanceSetFlags as SF, MPTokenAuthorizeFlags as AF, validate } from 'xrpl';

export { encode, Wallet } from 'xrpl';

const shares = (n) => {
  const s = String(n);
  if (!/^[1-9]\d*$/.test(s)) throw new Error('Share amount must be a positive whole number.');
  return s;
};
const id = (x) => {
  if (!/^[0-9A-Fa-f]{48}$/.test(String(x))) throw new Error('MPT issuance id must be 48 hex characters.');
  return String(x).toUpperCase();
};
const ok = (t) => { validate(t); return t; };

export const XrplRail = {
  /** Holder opts in to hold the MPT (creates their MPToken entry). With RequireAuth this alone does NOT let them receive shares. */
  optIn: (holder, issuanceId) => ok({ TransactionType: 'MPTokenAuthorize', Account: holder, MPTokenIssuanceID: id(issuanceId) }),
  /** Issuer authorises a holder - done by Tessera ONLY after the KYC decision is approved. */
  authorize: (issuer, issuanceId, holder) => ok({ TransactionType: 'MPTokenAuthorize', Account: issuer, MPTokenIssuanceID: id(issuanceId), Holder: holder }),
  /** Issuer withdraws a holder's authorisation (e.g. KYC expired or revoked). */
  unauthorize: (issuer, issuanceId, holder) => ok({ TransactionType: 'MPTokenAuthorize', Account: issuer, MPTokenIssuanceID: id(issuanceId), Holder: holder, Flags: AF.tfMPTUnauthorize }),
  /** Move shares (primary sale, or holder to holder). */
  send: (from, issuanceId, to, n) => ok({ TransactionType: 'Payment', Account: from, Destination: to, Amount: { mpt_issuance_id: id(issuanceId), value: shares(n) } }),
  /** Freeze one holder's balance. */
  lockHolder: (issuer, issuanceId, holder) => ok({ TransactionType: 'MPTokenIssuanceSet', Account: issuer, MPTokenIssuanceID: id(issuanceId), Holder: holder, Flags: SF.tfMPTLock }),
  unlockHolder: (issuer, issuanceId, holder) => ok({ TransactionType: 'MPTokenIssuanceSet', Account: issuer, MPTokenIssuanceID: id(issuanceId), Holder: holder, Flags: SF.tfMPTUnlock }),
  /** Lock the WHOLE issuance: the XRPL way to halt trading of an asset (e.g. on a reserve shortfall). */
  lockAll: (issuer, issuanceId) => ok({ TransactionType: 'MPTokenIssuanceSet', Account: issuer, MPTokenIssuanceID: id(issuanceId), Flags: SF.tfMPTLock }),
  unlockAll: (issuer, issuanceId) => ok({ TransactionType: 'MPTokenIssuanceSet', Account: issuer, MPTokenIssuanceID: id(issuanceId), Flags: SF.tfMPTUnlock }),
  /** Court order / lost keys: issuer claws the shares back (needs tfMPTCanClawback at issuance), then re-sends to the replacement. */
  clawback: (issuer, issuanceId, holder, n) => ok({ TransactionType: 'Clawback', Account: issuer, Holder: holder, Amount: { mpt_issuance_id: id(issuanceId), value: shares(n) } }),
};

/** Is an MPToken ledger entry (from ledger_entry { mptoken }) locked / authorised? (lsfMPTLocked = 0x1, lsfMPTAuthorized = 0x2) */
export const mptokenState = (node) => ({ balance: String(node?.MPTAmount ?? '0'), locked: Boolean((node?.Flags ?? 0) & 0x1), authorized: Boolean((node?.Flags ?? 0) & 0x2) });
