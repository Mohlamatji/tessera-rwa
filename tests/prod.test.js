// Production must fail CLOSED: refuse to boot with missing/weak settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boot = (env) => spawnSync(process.execPath, ['-e', "import('./public/index.js').then(m=>m.startServer({port:0})).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(3)})"],
  { cwd: root, env: { PATH: process.env.PATH, DB_SQLITE_PATH: ':memory:', ...env }, encoding: 'utf8', timeout: 30000 });

const GOOD = {
  APP_ENV: 'production', APP_ENCRYPTION_KEY: 'x'.repeat(40), ADMIN_PASSWORD_HASH: 'scrypt$c2FsdA==$aGFzaA==',
  CHAIN_ENABLED: '1', CHAIN_ID: '84532', CHAIN_RPC_URL: 'http://127.0.0.1:1', REGISTRY_ADDRESS: '0x' + '1'.repeat(40), FACTORY_ADDRESS: '0x' + '2'.repeat(40),
  MARKET_ADDRESS: '0x' + '3'.repeat(40), ANCHOR_ADDRESS: '0x' + '4'.repeat(40), TOKEN_ADDRESS: '0x' + '5'.repeat(40), ATTESTOR_PRIVATE_KEY: '0x' + '6'.repeat(64),
};

test('production with no configuration refuses to start and says why', () => {
  const r = boot({ APP_ENV: 'production' });
  assert.equal(r.status, 3);
  for (const s of ['APP_ENCRYPTION_KEY', 'ADMIN_PASSWORD_HASH', 'chain must be fully configured']) assert.ok(r.stderr.includes(s), s);
});

test('production refuses a short encryption key, a plain admin password, demo mode, and a missing attestor key', () => {
  assert.equal(boot({ ...GOOD, APP_ENCRYPTION_KEY: 'short' }).status, 3);
  assert.equal(boot({ ...GOOD, ADMIN_PASSWORD_HASH: '', ADMIN_PASSWORD: 'hunter2' }).status, 3);
  assert.equal(boot({ ...GOOD, DEMO_MODE: '1' }).status, 3);
  assert.equal(boot({ ...GOOD, ATTESTOR_PRIVATE_KEY: '' }).status, 3);
});

test('a fully configured production environment boots', () => {
  const r = boot(GOOD);
  assert.equal(r.status, 0, r.stderr);
});

test('development boots with zero configuration (chain off)', () => {
  assert.equal(boot({ APP_ENV: 'development' }).status, 0);
});
