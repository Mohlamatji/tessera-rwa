import { Config } from '../Support/Config.js';
import { Http } from '../Support/Http.js';
import { Tokens } from '../Support/Tokens.js';
import { AuthContext } from '../Support/AuthContext.js';

const PREFIX = 'tsr_';

/** Wallet-session tokens (HMAC-signed, 1h). Obtained by signing a ChallengeService nonce. */
export const AuthService = {
  mint(address) {
    const ttl = Config.get('tokens.session_ttl');
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return { token: Tokens.sign({ sub: address, exp }, 'wallet-session', PREFIX), expires_at: exp };
  },

  /** @returns {AuthContext|null} */
  authenticate(req) {
    const p = Tokens.verify(Http.bearer(req), 'wallet-session', PREFIX);
    return p?.sub ? new AuthContext('wallet', p.sub, `wallet ${p.sub.slice(0, 8)}`, { wallet: p.sub, scopes: ['investor'] }) : null;
  },
};
