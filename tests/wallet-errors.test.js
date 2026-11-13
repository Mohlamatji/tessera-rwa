// Regression test for the "could not coalesce error" toast: ethers v6 turns most wallet (EIP-1193) errors into that
// generic message. Tessera's browser SDK must show the REAL, actionable reason instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'public', 'js', 'tessera.js'), 'utf8');

function loadSdk() {
  const win = { ethereum: undefined };
  const ctx = vm.createContext({ window: win, ethers, document: { addEventListener() {}, getElementById: () => null }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, console, Date, JSON, Number, BigInt, String, Set, Math, Object, Error, Promise, location: {} });
  vm.runInContext(code, ctx);
  return win.Tessera;
}

/** A wallet that fails every request with the given EIP-1193 error. */
const failingWallet = (err) => ({ request: async () => { throw Object.assign(new Error(err.message), err); }, on() {} });
async function captureEthersError(err, method = 'personal_sign') {
  const provider = new ethers.BrowserProvider(failingWallet(err), 31337, { staticNetwork: true });
  try { await provider.send(method, []); } catch (e) { return e; }
  throw new Error('expected the wallet call to fail');
}

const T = loadSdk();

test('the raw ethers error really is the unhelpful one (guards the premise of this test)', async () => {
  // ethers maps 4001 itself, but a wallet that is already busy (-32002) or any other code falls through to the generic error.
  const e = await captureEthersError({ code: -32002, message: "Request of type 'personal_sign' already pending for origin http://localhost:8000. Please wait." });
  assert.match(e.shortMessage || e.message, /could not coalesce error/);
});

for (const [name, err, expected] of [
  ['user rejects the signature', { code: 4001, message: 'User rejected the request.' }, /rejected the request/i],
  ['a second request while one is pending', { code: -32002, message: "Request of type 'personal_sign' already pending for origin http://localhost:8000. Please wait." }, /already has a request waiting/i],
  ['wallet not authorised yet', { code: 4100, message: 'The requested account and/or method has not been authorized by the user.' }, /not authorised/i],
  ['chain not added', { code: 4902, message: 'Unrecognized chain ID "0x7a69". Try adding the chain using wallet_addEthereumChain first.' }, /does not know this network/i],
  ['stale nonce after the demo chain restarted', { code: -32603, message: 'Internal JSON-RPC error. nonce too high' }, /out of sync with the local demo chain/i],
  ['RPC node down', { code: -32603, message: 'Failed to fetch' }, /Cannot reach the blockchain node/i],
]) {
  test(`reason(): ${name}`, async () => {
    const text = T.reason(await captureEthersError(err));
    assert.doesNotMatch(text, /coalesce/i);
    assert.match(text, expected);
  });
}

test('reason(): unknown wallet error keeps the wallet\'s own message and never says "coalesce"', async () => {
  const text = T.reason(await captureEthersError({ code: -32000, message: 'Some brand new wallet failure' }));
  assert.match(text, /Some brand new wallet failure/);
});

test('reason(): an error with no detail at all still gives a human sentence', () => {
  const e = Object.assign(new Error('could not coalesce error'), { code: 'UNKNOWN_ERROR', shortMessage: 'could not coalesce error' });
  const text = T.reason(e);
  assert.doesNotMatch(text, /coalesce/i);
  assert.match(text, /wallet/i);
});

test('reason(): contract custom errors are translated', () => {
  assert.match(T.reason({ revert: { name: 'NotEligible' }, shortMessage: 'execution reverted (unknown custom error)' }), /not KYC-verified/);
  assert.match(T.reason(new Error('execution reverted: WalletFrozen(0xabc)')), /frozen/i);
});

// ---- sign-in recovers when the wallet says the site is no longer authorised (4100) ----
test('signIn(): a 4100 on the signature request is retried with the checksummed address and then succeeds', async () => {
  const wallet = ethers.Wallet.createRandom();
  const calls = { personal_sign: 0, eth_requestAccounts: 0 };
  const stored = {};
  const ethereum = {
    on() {},
    async request({ method, params }) {
      if (method === 'eth_requestAccounts') { calls.eth_requestAccounts++; return [wallet.address]; }
      if (method === 'eth_accounts') return [wallet.address];
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'personal_sign') {
        if (++calls.personal_sign === 1) throw Object.assign(new Error('The requested account and/or method has not been authorized by the user.'), { code: 4100 });
        return wallet.signMessage(ethers.toUtf8String(params[0]));
      }
      throw new Error('unexpected ' + method);
    },
  };
  const fetchStub = async (path) => ({ ok: true, json: async () => (
    path === '/api/chain/config' ? { chain_id: 31337, name: 'Local', rpc_url: 'http://x' }
      : path === '/api/auth/nonce' ? { message: 'login ' + Math.random() }
      : { token: 'tsr_x', expires_at: Math.floor(Date.now() / 1000) + 3600 }) });
  const win = { ethereum };
  const doc = { addEventListener() {}, getElementById: () => ({ appendChild() {} }), createElement: () => ({}), body: { appendChild() {} } };
  const ctx = vm.createContext({ window: win, ethers, document: doc, fetch: fetchStub, setTimeout: () => 0, console, Date, JSON, Number, BigInt, String, Set, Math, Object, Error, Promise, location: {},
    sessionStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } } });
  vm.runInContext(code, ctx);
  const sdk = win.Tessera;
  await sdk.connect();
  const sess = await sdk.signIn();
  assert.equal(sess.address, wallet.address.toLowerCase());
  assert.equal(calls.personal_sign, 2, 'retried once');
  assert.equal(calls.eth_requestAccounts, 1, 'no need to re-request access when the retry works');
  assert.equal(sdk.hasSession(), true);
});

test('signIn(): if the wallet stays at 4100 it re-requests the eth_accounts permission, then signs', async () => {
  const wallet = ethers.Wallet.createRandom();
  const calls = { personal_sign: 0, wallet_requestPermissions: 0 };
  const stored = {};
  let permitted = false;
  const ethereum = {
    on() {},
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'wallet_requestPermissions') { calls.wallet_requestPermissions++; permitted = true; return [{ parentCapability: 'eth_accounts' }]; }
      if (method === 'personal_sign') {
        calls.personal_sign++;
        if (!permitted) throw Object.assign(new Error('The requested account and/or method has not been authorized by the user.'), { code: 4100 });
        return wallet.signMessage(ethers.toUtf8String(params[0]));
      }
      throw new Error('unexpected ' + method);
    },
  };
  const fetchStub = async (path) => ({ ok: true, json: async () => (
    path === '/api/chain/config' ? { chain_id: 31337, name: 'Local', rpc_url: 'http://x' }
      : path === '/api/auth/nonce' ? { message: 'login ' + Math.random() }
      : { token: 'tsr_x', expires_at: Math.floor(Date.now() / 1000) + 3600 }) });
  const win = { ethereum };
  const doc = { addEventListener() {}, getElementById: () => ({ appendChild() {} }), createElement: () => ({}), body: { appendChild() {} } };
  const ctx = vm.createContext({ window: win, ethers, document: doc, fetch: fetchStub, setTimeout: () => 0, console, Date, JSON, Number, BigInt, String, Set, Math, Object, Error, Promise, location: {},
    sessionStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } } });
  vm.runInContext(code, ctx);
  const sdk = win.Tessera;
  await sdk.connect();
  const sess = await sdk.signIn();
  assert.equal(sess.address, wallet.address.toLowerCase());
  assert.equal(calls.wallet_requestPermissions, 1);
  assert.equal(calls.personal_sign, 3, 'lower-case, checksummed, then after the permission request');
});

test('signIn(): a user rejection (4001) is surfaced at once and never retried', async () => {
  const wallet = ethers.Wallet.createRandom();
  let signs = 0;
  const ethereum = { on() {}, async request({ method }) {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'personal_sign') { signs++; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
    throw new Error('unexpected ' + method);
  } };
  const fetchStub = async (path) => ({ ok: true, json: async () => (path === '/api/chain/config' ? { chain_id: 31337, name: 'Local', rpc_url: 'http://x' } : { message: 'login x' }) });
  const win = { ethereum };
  const doc = { addEventListener() {}, getElementById: () => ({ appendChild() {} }), createElement: () => ({}), body: { appendChild() {} } };
  const ctx = vm.createContext({ window: win, ethers, document: doc, fetch: fetchStub, setTimeout: () => 0, console, Date, JSON, Number, BigInt, String, Set, Math, Object, Error, Promise, location: {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  vm.runInContext(code, ctx);
  const sdk = win.Tessera;
  await sdk.connect();
  await assert.rejects(() => sdk.signIn(), (e) => e.code === 4001);
  assert.equal(signs, 1);
});
