/**
 * Front controller (the equivalent of identity-vault's public/index.php): a regex route table, auth scopes,
 * static files and security headers - on plain node:http, no framework.
 *
 * Scopes:  public  - anyone
 *          wallet  - an investor with a valid wallet-session bearer token (sign-in with wallet signature)
 *          admin   - an operator session (dashboard login) + CSRF token on writes
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// config/local.js (gitignored) sets process.env BEFORE any config is read.
const local = path.join(root, 'config', 'local.js');
if (fs.existsSync(local)) await import(pathToFileURL(local).href);

const { Config } = await import('../app/Support/Config.js');
const { Http, HttpError } = await import('../app/Support/Http.js');
const { View } = await import('../app/Support/View.js');
const { AdminAuth } = await import('../app/Support/AdminAuth.js');
const { AuthService } = await import('../app/Services/AuthService.js');
const { AuthContext } = await import('../app/Support/AuthContext.js');
const { getDb, closeDb } = await import('../config/database.js');
const { ApiController } = await import('../app/Controllers/ApiController.js');
const { MarketController } = await import('../app/Controllers/MarketController.js');
const { ChainController } = await import('../app/Controllers/ChainController.js');
const { AdminController } = await import('../app/Controllers/AdminController.js');
const { PayoutController } = await import('../app/Controllers/PayoutController.js');
const { IndexerService } = await import('../app/Services/IndexerService.js');
const { ChainService } = await import('../app/Services/ChainService.js');

const api = new ApiController(), market = new MarketController(), chain = new ChainController(), admin = new AdminController(), payouts = new PayoutController();

// [method, pattern, scope, handler]
const ROUTES = [
  ['POST', /^\/api\/auth\/nonce$/, 'public', (c) => api.nonce(c)],
  ['POST', /^\/api\/auth\/verify$/, 'public', (c) => api.verify(c)],
  ['POST', /^\/api\/consent\/grant$/, 'wallet', (c) => api.consentGrant(c)],
  ['POST', /^\/api\/consent\/revoke$/, 'wallet', (c) => api.consentRevoke(c)],
  ['POST', /^\/api\/kyc\/submit$/, 'wallet', (c) => api.kycSubmit(c)],
  ['GET', /^\/api\/kyc\/status$/, 'wallet', (c) => api.kycStatus(c)],
  ['POST', /^\/api\/kyc\/registered$/, 'wallet', (c) => api.kycRegistered(c)],
  ['GET', /^\/api\/data-subject\/export$/, 'wallet', (c) => api.dataExport(c)],
  ['POST', /^\/api\/data-subject\/delete$/, 'wallet', (c) => api.dataDelete(c)],

  ['GET', /^\/api\/chain\/config$/, 'public', (c) => chain.config(c)],
  ['POST', /^\/api\/chain\/verify-receipt$/, 'public', (c) => chain.verifyReceipt(c)],
  ['GET', /^\/api\/market\/assets$/, 'public', (c) => market.assets(c)],
  ['GET', /^\/api\/market\/assets\/(0x[0-9a-fA-F]{40})$/, 'public', (c) => market.asset(c)],
  ['POST', /^\/api\/market\/sync$/, 'public', (c) => market.sync(c)],
  ['GET', /^\/api\/portfolio$/, 'wallet', (c) => market.portfolio(c)],
  ['GET', /^\/api\/payouts$/, 'wallet', (c) => payouts.list(c)],
  ['POST', /^\/api\/payouts$/, 'wallet', (c) => payouts.create(c)],

  ['GET', /^\/api\/admin\/csrf$/, 'admin', (c) => admin.csrf(c)],
  ['GET', /^\/api\/admin\/stats$/, 'admin', (c) => admin.stats(c)],
  ['GET', /^\/api\/admin\/kyc$/, 'admin', (c) => admin.kycList(c)],
  ['POST', /^\/api\/admin\/kyc\/(\d+)\/resolve$/, 'admin', (c) => admin.kycResolve(c)],
  ['GET', /^\/api\/admin\/aml\/alerts$/, 'admin', (c) => admin.amlAlerts(c)],
  ['POST', /^\/api\/admin\/aml\/alerts\/(\d+)\/dismiss$/, 'admin', (c) => admin.amlDismiss(c)],
  ['POST', /^\/api\/admin\/assets\/prepare$/, 'admin', (c) => admin.assetPrepare(c)],
  ['POST', /^\/api\/admin\/backing\/prepare$/, 'admin', (c) => admin.backingPrepare(c)],
  ['GET', /^\/api\/admin\/trades$/, 'admin', (c) => admin.trades(c)],
  ['GET', /^\/api\/admin\/audit-log$/, 'admin', (c) => admin.auditLog(c)],
  ['GET', /^\/api\/admin\/audit\/verify$/, 'admin', (c) => admin.auditVerify(c)],
  ['POST', /^\/api\/admin\/retention\/run$/, 'admin', (c) => admin.retention(c)],
  ['POST', /^\/api\/admin\/sync$/, 'admin', (c) => admin.sync(c)],
  ['GET', /^\/api\/admin\/chain\/anchor\/prepare$/, 'admin', (c) => chain.anchorPrepare(c)],
  ['POST', /^\/api\/admin\/chain\/anchor\/record$/, 'admin', (c) => chain.anchorRecord(c)],
  ['GET', /^\/api\/admin\/chain\/anchors$/, 'admin', (c) => chain.anchors(c)],
  ['GET', /^\/api\/admin\/chain\/proof$/, 'admin', (c) => chain.proof(c)],
];

const PAGES = { '/': ['marketplace', 'market'], '/onboarding': ['onboarding', 'onboarding'], '/portfolio': ['portfolio', 'portfolio'], '/verify': ['verify', 'verify'], '/api-docs': ['api-docs', 'docs'] };
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function serveStatic(res, urlPath) {
  const file = path.normalize(path.join(here, urlPath));
  if (!file.startsWith(here + path.sep) || file === path.join(here, 'index.js') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
  return true;
}

async function handle(req, res) {
  Http.securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  try {
    if (m === 'GET' && p === '/health') return Http.json(res, 200, { status: 'ok', env: Config.get('env'), chain: ChainService.enabled() });

    // ---- pages
    if (m === 'GET' && PAGES[p]) return Http.html(res, 200, View.render(PAGES[p][0]));
    if (m === 'GET' && /^\/asset\/0x[0-9a-fA-F]{40}$/.test(p)) return Http.html(res, 200, View.render('asset'));
    if (m === 'GET' && p === '/login') return admin.loginForm({ res });
    if (m === 'POST' && p === '/login') return admin.login({ req, res });
    if (p === '/logout') return admin.logout({ res });
    if (m === 'GET' && p === '/dashboard') return AdminAuth.isAuthenticated(req) ? admin.dashboard({ req, res }) : Http.redirect(res, 'login');

    // ---- static
    if (m === 'GET' && serveStatic(res, p)) return;

    // ---- API
    for (const [method, re, scope, fn] of ROUTES) {
      if (method !== m) continue;
      const match = re.exec(p);
      if (!match) continue;

      let auth = null;
      if (scope === 'wallet') {
        auth = AuthService.authenticate(req);
        if (!auth) return Http.json(res, 401, { status: 'error', message: 'Sign in with your wallet first.' });
      } else if (scope === 'admin') {
        if (!AdminAuth.isAuthenticated(req)) return Http.json(res, 401, { status: 'error', message: 'Admin login required.' });
        if (m !== 'GET' && !AdminAuth.csrfValid(req)) return Http.json(res, 403, { status: 'error', message: 'Missing or invalid CSRF token.' });
        auth = new AuthContext('admin_session', 0, 'admin', { scopes: ['*'] });
      }
      const out = await fn({ req, res, match, auth, query: url.searchParams });
      if (out) Http.json(res, out[0], out[1]);
      return;
    }
    Http.json(res, 404, { status: 'error', message: 'Not found.' });
  } catch (e) {
    if (e instanceof HttpError) return Http.json(res, e.status, { status: 'error', message: e.message });
    console.error('[tessera] unhandled error:', e);
    Http.json(res, 500, { status: 'error', message: 'Internal error.' });
  }
}

/** Refuses to boot in production with insecure/missing settings (fail closed). Exported for tests/prod.js. */
export function assertProductionReady() {
  if (!Config.isProduction()) return;
  const s = Config.security(), problems = [];
  if (!s.encryption_key || s.encryption_key.length < 32) problems.push('APP_ENCRYPTION_KEY (32+ chars) is required');
  if (!s.admin_password_hash) problems.push('ADMIN_PASSWORD_HASH is required (plain ADMIN_PASSWORD is dev-only)');
  if (Config.get('demo_mode')) problems.push('DEMO_MODE must be off');
  if (!ChainService.enabled()) problems.push('chain must be fully configured (CHAIN_ENABLED, RPC, contract addresses, ATTESTOR_PRIVATE_KEY)');
  if (problems.length) throw new Error('Refusing to start in production:\n - ' + problems.join('\n - '));
}

export async function startServer({ port = Config.get('port') } = {}) {
  assertProductionReady();
  getDb();
  const server = http.createServer(handle);
  await new Promise((r) => server.listen(port, r));
  IndexerService.start();
  server.on('close', () => { IndexerService.stop(); closeDb(); });
  return { server, config: Config.all(), port: server.address().port };
}
