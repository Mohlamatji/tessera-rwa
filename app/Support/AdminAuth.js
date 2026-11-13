import crypto from 'node:crypto';
import { Config } from './Config.js';
import { Http } from './Http.js';
import { Tokens } from './Tokens.js';
import { RateLimitService } from '../Services/RateLimitService.js';

const COOKIE = 'tsr_admin';

/**
 * Admin (dashboard) authentication: signed session cookie, scrypt-hashed password, login throttling and a
 * per-session CSRF token for state-changing admin calls.
 *
 * Development with no admin password configured stays open so `npm start` just works; production with no
 * password configured is LOCKED.
 */
export const AdminAuth = {
  hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 32).toString('base64')}`;
  },
  _check(pw) {
    const s = Config.security();
    if (s.admin_password_hash) {
      const [, salt, hash] = s.admin_password_hash.split('$');
      const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 32), want = Buffer.from(hash, 'base64');
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    }
    if (s.admin_password) {
      const a = crypto.createHash('sha256').update(pw).digest(), b = crypto.createHash('sha256').update(s.admin_password).digest();
      return crypto.timingSafeEqual(a, b);
    }
    return false;
  },

  isConfigured() { const s = Config.security(); return Boolean(s.admin_password_hash || s.admin_password); },
  session(req) { return Tokens.verify(Http.cookies(req)[COOKIE], 'admin-session'); },
  isAuthenticated(req) { return AdminAuth.isConfigured() ? Boolean(AdminAuth.session(req)?.adm) : !Config.isProduction(); },
  csrfToken(req) { return AdminAuth.session(req)?.csrf ?? ''; },
  csrfValid(req) {
    if (!AdminAuth.isConfigured()) return true; // open dev mode has no session to protect
    const sent = Http.header(req, 'x-csrf-token') ?? '', want = AdminAuth.csrfToken(req);
    return sent !== '' && sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
  },

  /** @returns {{error?:string, cookie?:string}} */
  attemptLogin(req, password) {
    if (!RateLimitService.allow(RateLimitService.bucketKey(Http.ip(req), 'admin_login'), 5, 300)) return { error: 'Too many login attempts. Try again in a few minutes.' };
    if (!AdminAuth.isConfigured() || !AdminAuth._check(String(password ?? ''))) return { error: 'Incorrect password.' };
    const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
    const token = Tokens.sign({ adm: 1, csrf: Tokens.randomHex(24), exp }, 'admin-session');
    return { cookie: `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 3600}` };
  },
  logoutCookie() { return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; },
};
