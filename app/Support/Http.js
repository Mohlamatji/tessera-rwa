import { Config } from './Config.js';

const MAX_BODY_BYTES = 1024 * 1024;

/** Request/response helpers shared by the router and controllers. */
export const Http = {
  json(res, status, body, headers = {}) {
    if (res.headersSent) return;
    const payload = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers });
    res.end(payload);
  },

  html(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  },

  redirect(res, location, headers = {}) {
    res.writeHead(302, { Location: location, ...headers });
    res.end();
  },

  /** Decoded JSON body, or {} if empty/invalid. Rejects oversized bodies (throws HttpError 413). */
  async input(req) {
    if (req._parsed !== undefined) return req._parsed;
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    req._raw = raw;
    const ct = String(req.headers['content-type'] || '');
    let data = {};
    try {
      if (ct.includes('application/x-www-form-urlencoded')) data = Object.fromEntries(new URLSearchParams(raw));
      else data = raw ? JSON.parse(raw) : {};
    } catch { data = {}; }
    return (req._parsed = data && typeof data === 'object' && !Array.isArray(data) ? data : {});
  },

  ip(req) {
    if (Config.get('trust_proxy_headers') && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
  },

  header(req, name) { const v = req.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : (v ?? null); },

  bearer(req) {
    const h = Http.header(req, 'authorization') || '';
    return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
  },

  cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  },

  securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Pages load ethers from jsDelivr and fonts from Google; wallets inject window.ethereum (no network needed for that).
    // connect-src is open to https/http(s) JSON-RPC because browser wallets and the app talk to the chain RPC.
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' https://cdn.jsdelivr.net",
      "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
  },
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
