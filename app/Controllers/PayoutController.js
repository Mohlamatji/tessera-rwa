import { Http } from '../Support/Http.js';
import { PayoutService, PayoutError } from '../Services/PayoutService.js';
import { RateLimitService } from '../Services/RateLimitService.js';

/** Investor cash-out to mobile money. */
export class PayoutController {
  options() { return [200, PayoutService.options()]; }
  list({ auth }) { return [200, { payouts: PayoutService.list(auth.wallet), ...PayoutService.options() }]; }
  async create({ req, auth }) {
    if (!RateLimitService.allow(RateLimitService.bucketKey(auth.wallet, 'payout'), 10, 3600)) return [429, { status: 'error', message: 'Too many cash-out requests. Try again later.' }];
    try { return [200, await PayoutService.create(auth.wallet, await Http.input(req), Http.ip(req))]; }
    catch (e) { if (e instanceof PayoutError) return [e.status, { status: 'error', message: e.message }]; throw e; }
  }
}
