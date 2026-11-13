import { Http } from '../Support/Http.js';
import { Eth } from '../Support/Eth.js';
import { User } from '../Models/User.js';
import { AuditLog } from '../Models/AuditLog.js';
import { ChallengeService } from '../Services/ChallengeService.js';
import { AuthService } from '../Services/AuthService.js';
import { ConsentService } from '../Services/ConsentService.js';
import { KycService, KycError } from '../Services/KycService.js';
import { DataSubjectService } from '../Services/DataSubjectService.js';
import { RateLimitService } from '../Services/RateLimitService.js';

const err = (status, message, extra = {}) => [status, { status: 'error', message, ...extra }];

/** Investor-facing API: wallet sign-in, consent, KYC, data-subject rights. */
export class ApiController {
  /** POST /api/auth/nonce {address} */
  async nonce({ req }) {
    const { address } = await Http.input(req);
    if (!Eth.isAddress(address)) return err(422, 'A valid wallet address is required.');
    if (!RateLimitService.allow(RateLimitService.bucketKey(Http.ip(req), 'nonce'), 30, 300)) return err(429, 'Too many requests.');
    return [200, ChallengeService.issue(Eth.norm(address))];
  }

  /** POST /api/auth/verify {address, signature} -> wallet session token */
  async verify({ req }) {
    const { address, signature } = await Http.input(req);
    if (!Eth.isAddress(address) || typeof signature !== 'string') return err(422, 'address and signature are required.');
    const a = Eth.norm(address);
    if (!RateLimitService.allow(RateLimitService.bucketKey(a, 'auth_verify'), 10, 300)) return err(429, 'Too many attempts.');
    if (!ChallengeService.consume(a, signature)) return err(401, 'Signature did not prove control of this wallet (or the challenge expired).');
    AuditLog.append(`wallet:${a}`, 'auth.signed_in', 'wallets', a, Http.ip(req));
    const s = AuthService.mint(a);
    return [200, { ...s, address: Eth.checksum(a), user_known: Boolean(User.findByWallet(a)) }];
  }

  async consentGrant({ req, auth }) { return [200, { status: 'ok', ...ConsentService.grant(auth.wallet, Http.ip(req)) }]; }
  async consentRevoke({ req, auth }) { ConsentService.revoke(auth.wallet, Http.ip(req)); return [200, { status: 'ok' }]; }

  async kycSubmit({ req, auth }) {
    try { return [200, await KycService.submit(auth.wallet, await Http.input(req), Http.ip(req))]; }
    catch (e) { if (e instanceof KycError) return err(e.status, e.message, e.extra); throw e; }
  }

  async kycStatus({ auth }) { return [200, await KycService.status(auth.wallet)]; }

  async kycRegistered({ req, auth }) {
    try { return [200, await KycService.confirmRegistration(auth.wallet, String((await Http.input(req)).tx_hash ?? ''))]; }
    catch (e) { if (e instanceof KycError) return err(e.status, e.message); throw e; }
  }

  async dataExport({ auth }) {
    try { return [200, DataSubjectService.export(auth.wallet)]; } catch (e) { if (e instanceof KycError) return err(e.status, e.message); throw e; }
  }

  async dataDelete({ auth }) {
    try { return [200, DataSubjectService.erase(auth.wallet)]; } catch (e) { if (e instanceof KycError) return err(e.status, e.message, e.extra); throw e; }
  }
}
