/* Tessera browser SDK: API client, wallet connect + sign-in, formatting, and the minimal contract ABIs the UI needs. */
(function () {
  const ABI = {
    registry: ['function register((bytes32 decisionId,address wallet,uint8 tier,uint64 expiry) c, bytes signature)', 'function tierOf(address) view returns (uint8)', 'function freeze(address)', 'function unfreeze(address)', 'function revoke(address)', 'function isFrozen(address) view returns (bool)'],
    market: ['function list(address asset,uint256 amount,uint256 pricePerShare) returns (uint256)', 'function buy(uint256 id,uint256 amount)', 'function cancel(uint256 id)', 'function feeBps() view returns (uint16)'],
    asset: ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function pendingYield(address) view returns (uint256)', 'function claim() returns (uint256)', 'function depositYield(uint256 amount, bytes32 ref)', 'function issuer() view returns (address)'],
    stable: ['function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function faucet()'],
    factory: ['function createAsset((string name,string symbol,address issuer,uint256 totalShares,uint8 assetClass,uint8 minTier,uint16 maxHolderBps,bytes32 documentHash,string documentURI) p) returns (address)'],
    anchor: ['function anchor(bytes32 root,uint64 fromId,uint64 toId,uint32 count)'],
    backing: ['function submit((address asset,uint256 backedShares,uint64 asOf,uint64 validUntil,bytes32 evidenceHash,uint64 nonce) a, bytes signature)'],
    recovery: ['function recoverWallet(address lost,address replacement,bytes32 reasonRef)', 'function forcedTransfer(address from,address to,uint256 amount,bytes32 reasonRef)'],
  };

  /** Asset picture: a real photo dropped into public/img/assets/<symbol>.jpg|.webp|.png wins, then the bundled
      illustration (<symbol>.svg), then default.svg. Missing files fall through (see wireImages). Illustrations are
      labelled so nobody mistakes them for a photograph of the real asset. */
  function assetImage(a, height = 112) {
    const sym = String(a.symbol || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const srcs = ['jpg', 'webp', 'png', 'svg'].map((x) => `/img/assets/${sym}.${x}`).concat('/img/assets/default.svg');
    const hue = Number(a.image_hue) || 210;
    // Inline styles on purpose: the compiled Tailwind stylesheet only contains the classes the pages already used.
    return `<div class="rounded-lg overflow-hidden" style="position:relative;height:${height}px;background:linear-gradient(135deg,hsl(${hue} 55% 22%),hsl(${(hue + 40) % 360} 60% 12%))">
      <img alt="${esc(a.name)}" src="${srcs[0]}" data-srcs="${srcs.join(',')}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
      <span data-illustration class="hidden text-xs text-slate-300" style="position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.6);padding:1px 6px;border-radius:4px">Illustrative image</span></div>`;
  }
  /** Walk each asset image through its fallback list; mark bundled .svg illustrations as illustrative. */
  function wireImages(scope = document) {
    scope.querySelectorAll('img[data-srcs]').forEach((img) => {
      const list = img.dataset.srcs.split(',');
      const mark = () => { const tag = img.parentElement.querySelector('[data-illustration]'); if (tag) tag.classList.toggle('hidden', !/\.svg$/.test(img.getAttribute('src'))); };
      img.addEventListener('load', mark);
      img.addEventListener('error', () => { const i = list.indexOf(img.getAttribute('src')); if (i >= 0 && i < list.length - 1) img.src = list[i + 1]; else img.remove(); });
    });
  }
  const KEY = 'tessera.session';
  let cfg = null, provider = null, signer = null, address = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  const session = () => { try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return s && s.expires_at * 1000 > Date.now() ? s : null; } catch { return null; } };

  async function api(path, { method = 'GET', body, auth = false, csrf } = {}) {
    const h = { 'Content-Type': 'application/json' };
    if (auth) { const s = session(); if (s) h.Authorization = 'Bearer ' + s.token; }
    if (csrf) h['X-CSRF-Token'] = csrf;
    const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.message || 'Request failed'); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  async function config() { return (cfg ||= await api('/api/chain/config')); }

  const decimals = () => (cfg && cfg.token ? cfg.token.decimals : 6);
  function units(v, dec = 6, frac = 2) {
    const n = Number(ethers.formatUnits(BigInt(v || 0), dec));
    return n.toLocaleString('en-ZA', { minimumFractionDigits: frac, maximumFractionDigits: frac });
  }
  const money = (v, frac = 2) => `${(cfg && cfg.currency && cfg.currency.symbol) || 'R'}\u00a0${units(v, decimals(), frac)}`;
  const toUnits = (human) => ethers.parseUnits(String(human), decimals());
  const num = (v) => Number(v).toLocaleString('en-ZA');

  function toast(msg, kind = 'info') {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'fixed bottom-4 right-4 z-50 space-y-2 max-w-sm'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'rounded-lg border px-4 py-3 text-sm shadow-lg ' + (kind === 'error' ? 'bg-danger/15 border-danger/40 text-red-200' : kind === 'ok' ? 'bg-teal/15 border-teal/40 text-teal-100' : 'bg-panel border-line text-slate-200');
    t.textContent = msg; box.appendChild(t); setTimeout(() => t.remove(), 6000);
  }

  /* Wallets (MetaMask & co.) report problems as EIP-1193 errors { code, message }. ethers v6 only recognises the
     phrase "user denied", so MetaMask's "User rejected the request." (4001), "Request already pending" (-32002) and
     most other wallet errors come out as the unhelpful `could not coalesce error`. Dig the real error out instead. */
  function rpcInfo(e) {
    const seen = new Set(); let code = null, message = '';
    const walk = (x, depth = 0) => {
      if (!x || typeof x !== 'object' || seen.has(x) || depth > 6) return;
      seen.add(x);
      if (code === null && Number.isFinite(Number(x.code)) && x.code !== '' ) code = Number(x.code);
      if (typeof x.message === 'string' && x.message && !/could not coalesce error/i.test(x.message) && x.message.length > message.length) message = x.message;
      for (const k of ['error', 'info', 'cause', 'data', 'payload']) walk(x[k], depth + 1);
    };
    walk(e);
    return { code, message };
  }

  function reason(e) {
    const { code, message } = rpcInfo(e);
    const sc = e && typeof e.code === 'string' ? e.code : '';
    const raw = [e && e.reason, e && e.shortMessage, message, e && e.message].filter(Boolean).join(' | ');
    if (code === 4001 || sc === 'ACTION_REJECTED' || /user (rejected|denied)|rejected the request/i.test(raw)) return 'You rejected the request in your wallet. Nothing was changed - click the button to try again.';
    if (code === -32002 || /already pending|already processing|request of type .* already/i.test(raw)) return 'Your wallet already has a request waiting. Open the MetaMask window (or its toolbar icon), approve or reject the pending request, then try again.';
    if (code === 4100 || /not been authorized|unauthorized/i.test(raw)) return 'Your wallet has not authorised this site for the selected account. In MetaMask make sure the account you want is selected and connected to this site (⋮ menu → Connected sites; disconnect, then click "Connect wallet" again), unlock the wallet, and disable other wallet extensions (Brave Wallet, Phantom, Coinbase…) while testing. Press F12 → Console for technical details.';
    if (code === 4900 || code === 4901 || /disconnected from (the )?chain/i.test(raw)) return 'Your wallet is disconnected from the network. Reconnect it and try again.';
    if (code === 4902 || /unrecognized chain/i.test(raw)) return 'Your wallet does not know this network yet. Click "Connect wallet" to add it.';
    if (/nonce too (high|low)|nonce has already been used|nonce.*(not|too).*(match|high|low)/i.test(raw) || sc === 'NONCE_EXPIRED') return 'Your wallet\'s transaction counter is out of sync with the local demo chain (the chain was probably restarted). In MetaMask: Settings → Advanced → "Clear activity tab data", then try again.';
    if (/insufficient funds/i.test(raw) || sc === 'INSUFFICIENT_FUNDS') return 'This wallet has no gas funds on this network. On the local demo chain use one of the funded demo keys; on a testnet use a faucet.';
    if (/NotEligible/.test(raw + JSON.stringify((e && e.data) || '')) || (e && e.revert && e.revert.name === 'NotEligible')) return 'That wallet is not KYC-verified for this asset (or is frozen).';
    if (/WalletFrozen/.test(raw)) return 'That wallet is frozen by the compliance operator.';
    if (/HolderCapExceeded/.test(raw)) return 'That purchase would take the wallet over the asset\'s per-holder cap.';
    if (/BackingShortfall/.test(raw)) return 'Trading in this asset is paused: the latest custodian attestation shows the reserve no longer covers every share.';
    if (/failed to fetch|network (error|request failed)|ECONNREFUSED|could not detect network|missing response|timeout/i.test(raw)) return 'Cannot reach the blockchain node. Is the demo still running (npm run demo) and is the wallet pointed at its RPC URL?';
    if (/user rejected|ACTION_REJECTED/i.test(sc)) return 'You rejected the request in your wallet.';
    const best = message || (e && (e.reason || e.shortMessage || e.message)) || 'Something went wrong';
    const clean = String(best).replace(/\s*\(action=.*$/s, '').replace(/^execution reverted:?\s*/i, 'The contract rejected this: ');
    if (/could not coalesce error/i.test(clean)) return 'Your wallet returned an error' + (code !== null ? ` (code ${code})` : '') + '. Check the wallet window, then try again.';
    if (typeof console !== 'undefined') console.debug('[Tessera] wallet/contract error', e);
    return clean.length > 200 ? clean.slice(0, 200) + '…' : clean;
  }

  /* Several wallet extensions (MetaMask, Brave Wallet, Phantom, Coinbase...) fight over window.ethereum and can answer a
     request with another wallet's permissions. Prefer MetaMask via EIP-6963 discovery, else whatever window.ethereum is. */
  let injected = null;
  async function discoverWallet() {
    if (injected) return injected;
    const found = [];
    if (typeof window.addEventListener === 'function' && typeof Event === 'function') {
      const on = (e) => found.push(e.detail);
      window.addEventListener('eip6963:announceProvider', on);
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      await new Promise((r) => setTimeout(r, 150));
      window.removeEventListener('eip6963:announceProvider', on);
    }
    const mm = found.find((f) => f && f.info && f.info.rdns === 'io.metamask');
    const eth = window.ethereum;
    injected = (mm && mm.provider) || (eth && Array.isArray(eth.providers) && eth.providers.find((p) => p.isMetaMask && !p.isBraveWallet)) || eth || (found[0] && found[0].provider) || null;
    return injected;
  }
  const W = () => injected || window.ethereum;
  /** personal_sign sent straight to the wallet for the account we connected (no ethers signer in between).
      Some wallet/browser combinations answer 4100 ("not authorised") for the lower-case address form, or when the
      site's permission went stale, so after a 4100 we retry with the checksummed address and then re-request the
      eth_accounts permission once. A rejection (4001) or a busy wallet (-32002) is never retried. */
  async function personalSign(message) {
    const hex = ethers.hexlify(ethers.toUtf8Bytes(message));
    const sign = (from) => W().request({ method: 'personal_sign', params: [hex, from] });
    const checksummed = (() => { try { return ethers.getAddress(address); } catch { return address; } })();
    try { return await sign(address); }
    catch (e1) {
      if (rpcInfo(e1).code !== 4100) throw e1;
      try { return await sign(checksummed); }
      catch (e2) {
        if (rpcInfo(e2).code !== 4100) throw e2;
        try { await W().request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
        catch (e3) { const c = rpcInfo(e3).code; if (c === 4001 || c === -32002) throw e3; /* unsupported by this wallet: fall through to one last try */ }
        return sign(checksummed);
      }
    }
  }

  /** Console helper: Tessera.diagnose() prints what the wallet reports, to debug connection problems. */
  async function diagnose() {
    const w = W() || {}, ask = (method) => w.request ? w.request({ method }).catch((e) => 'error ' + (rpcInfo(e).code ?? e.message)) : 'no wallet';
    const info = { appAddress: address, chainId: await ask('eth_chainId'), permittedAccounts: await ask('eth_accounts'), isMetaMask: w.isMetaMask, isBraveWallet: w.isBraveWallet, isPhantom: w.isPhantom, isCoinbaseWallet: w.isCoinbaseWallet, origin: location.origin };
    console.table(info); return info;
  }

  let connecting = null, signing = null, listening = false;

  /** Connect the browser wallet and make sure it is on the right chain. Safe to call repeatedly / concurrently. */
  function connect({ silent = false, force = false } = {}) {
    if (force) { signer = null; address = null; }
    if (address && signer && !silent) return Promise.resolve(address);
    if (connecting) return connecting;
    connecting = (async () => {
      if (!(await discoverWallet())) throw new Error('No browser wallet found. Install MetaMask (or any EIP-1193 wallet).');
      const c = await config();
      provider = new ethers.BrowserProvider(W());
      const accts = silent ? await W().request({ method: 'eth_accounts' }) : await provider.send('eth_requestAccounts', []);
      if (!accts || !accts.length) throw Object.assign(new Error('No wallet account is connected.'), { code: 'NO_ACCOUNT' });
      const want = '0x' + c.chain_id.toString(16);
      const have = await W().request({ method: 'eth_chainId' }).catch(() => null);
      if (silent) {
        if (!have || BigInt(have) !== BigInt(want)) throw Object.assign(new Error('Wallet is on a different network.'), { code: 'WRONG_CHAIN' });
      } else {
        try { await provider.send('wallet_switchEthereumChain', [{ chainId: want }]); }
        catch (e) {
          const { code, message } = rpcInfo(e);
          const nowHave = await W().request({ method: 'eth_chainId' }).catch(() => null);
          if ((code === 4902 || /unrecognized chain|not.*added|unknown chain/i.test(message)) && c.rpc_url) {
            await provider.send('wallet_addEthereumChain', [{ chainId: want, chainName: c.name, rpcUrls: [c.rpc_url], nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: c.explorer_url ? [c.explorer_url] : undefined }]);
          } else if (!(nowHave && BigInt(nowHave) === BigInt(want))) throw e; // already on the right chain: a refused switch is harmless
        }
      }
      provider = new ethers.BrowserProvider(W());
      signer = await provider.getSigner();
      address = (await signer.getAddress()).toLowerCase();
      if (!listening && W().on) {
        listening = true;
        W().on('accountsChanged', () => { sessionStorage.removeItem(KEY); location.reload(); });
        W().on('chainChanged', () => location.reload());
      }
      return address;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  /** Make sure the wallet's active account is still the one we think it is (and still authorised for this site). */
  async function syncAccount() {
    const accts = await W().request({ method: 'eth_accounts' }).catch(() => []);
    if (!accts || !accts.length || accts[0].toLowerCase() !== address) await connect({ force: true });
  }

  async function signInOnce() {
    if (!signer) await connect();
    await syncAccount();
    const s = session();
    if (s && s.address === address) return s;
    const ch = await api('/api/auth/nonce', { method: 'POST', body: { address } });
    toast('Sign the free login message in your wallet (no gas, no spending).');
    const signature = await personalSign(ch.message);
    const r = await api('/api/auth/verify', { method: 'POST', body: { address, signature } });
    const sess = { token: r.token, expires_at: r.expires_at, address };
    sessionStorage.setItem(KEY, JSON.stringify(sess));
    return sess;
  }

  /** Wallet-signature sign-in. One signature prompt at a time; if the wallet says the site is no longer authorised
      (4100: account switched, access revoked, wallet locked), re-request access once and retry. */
  function signIn() {
    if (signing) return signing;
    signing = (async () => {
      try { return await signInOnce(); }
      catch (e) {
        if (rpcInfo(e).code !== 4100) throw e;
        await connect({ force: true });
        try { return await signInOnce(); }
        catch (e2) {
          if (rpcInfo(e2).code === 4100 && typeof console !== 'undefined') {
            const w = W() || {};
            console.error('[Tessera] wallet refused personal_sign (4100) even after re-requesting access', { account: address, chainId: await w.request({ method: 'eth_chainId' }).catch(() => '?'), permittedAccounts: await w.request({ method: 'eth_accounts' }).catch(() => '?'),
              isMetaMask: w.isMetaMask, isBraveWallet: w.isBraveWallet, isPhantom: w.isPhantom, isCoinbaseWallet: w.isCoinbaseWallet, injectedProviders: Array.isArray(window.ethereum && window.ethereum.providers) ? window.ethereum.providers.length : 1, wallet_message: rpcInfo(e2).message });
          }
          throw e2;
        }
      }
    })().finally(() => { signing = null; });
    return signing;
  }
  const hasSession = () => { const s = session(); return Boolean(s && address && s.address === address); };

  const contract = (name, addr) => new ethers.Contract(addr, ABI[name], signer || provider);
  async function sendTx(label, fn) {
    toast(label + ' - confirm in your wallet…');
    const tx = await fn();
    toast('Submitted. Waiting for confirmation…');
    const rc = await tx.wait();
    toast(label + ' confirmed', 'ok');
    return rc;
  }
  async function ensureAllowance(tokenName, tokenAddr, spender, needed) {
    const t = contract(tokenName, tokenAddr);
    if ((await t.allowance(address, spender)) >= needed) return;
    await sendTx('Approve', () => t.approve(spender, ethers.MaxUint256));
  }

  async function header() {
    const c = await config().catch(() => null);
    const el = document.getElementById('chain-pill');
    if (el && c) { el.textContent = c.enabled ? c.name : 'Chain not configured'; el.classList.remove('hidden'); }
    const btn = document.getElementById('wallet-btn');
    if (!btn) return;
    const connected = () => { btn.textContent = short(address); document.dispatchEvent(new CustomEvent('tessera:connected', { detail: address })); };
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await connect(); connected(); } catch (e) { toast(reason(e), 'error'); } finally { btn.disabled = false; }
    });
    // Returning visitor whose wallet already approved this site: reconnect silently (no popups, no signature).
    if (await discoverWallet()) {
      try { const accts = await W().request({ method: 'eth_accounts' }); if (accts && accts.length) { await connect({ silent: true }); connected(); } } catch { /* stay disconnected; the button still works */ }
    }
  }

  window.Tessera = { ABI, api, config, connect, signIn, diagnose, assetImage, wireImages, hasSession, rpcInfo, session, contract, sendTx, ensureAllowance, esc, short, units, money, toUnits, num, toast, reason, header,
    get address() { return address; }, get signer() { return signer; }, get provider() { return provider; }, get cfg() { return cfg; },
    explorer(tx) { return cfg && cfg.explorer_url ? `${cfg.explorer_url}/tx/${tx}` : null; } };
  document.addEventListener('DOMContentLoaded', header);
})();
