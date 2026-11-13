(async function () {
  const T = Tessera, $ = (s) => document.querySelector(s), addr = location.pathname.split('/').pop().toLowerCase();
  const root = $('#root');
  let a, kyc = null;

  async function load() {
    await T.config();
    a = await T.api('/api/market/assets/' + addr);
    if (T.address && T.hasSession()) { try { kyc = await T.api('/api/kyc/status', { auth: true }); } catch { kyc = null; } }
    render();
  }

  function banner() {
    if (!T.address) return '<div class="card border-gold/40 text-sm text-slate-300">Connect your wallet to trade.</div>';
    if (!kyc && !T.hasSession()) return '<div class="card border-gold/40 text-sm text-slate-300">Wallet connected. <button id="signin" class="text-gold underline">Sign in (free signature)</button> to check your verification status - you can still browse without it.</div>';
    if (!kyc || kyc.on_chain_tier === 0 || kyc.on_chain_tier === null) return '<div class="card border-gold/40 text-sm text-slate-300">Your wallet is not verified on-chain yet. <a href="/onboarding" class="text-gold underline">Get verified</a> to buy this asset.</div>';
    if (kyc.on_chain_tier < a.min_tier) return '<div class="card border-gold/40 text-sm text-slate-300">This asset is for <b>accredited</b> investors. <a href="/onboarding" class="text-gold underline">Upgrade your verification</a>.</div>';
    return `<div class="card border-teal/40 text-sm text-teal">✓ Verified on-chain (tier ${kyc.on_chain_tier}). You can trade this asset.</div>`;
  }


  function backingCard() {
    const b = a.backing || { state: 'unattested' };
    const MAP = { backed: ['✓ Fully backed', 'border-teal/40 text-teal'], shortfall: ['✗ Reserve shortfall - buying is halted', 'border-danger/40 text-red-300'], stale: ['! Attestation has expired', 'border-gold/50 text-gold'], unattested: ['No custodian attestation yet', 'border-line text-slate-400'], unknown: ['Backing status unavailable', 'border-line text-slate-400'] };
    const [label, cls] = MAP[b.state] || MAP.unknown;
    const when = (t) => (t ? new Date(t * 1000).toLocaleString() : '-');
    const detail = b.state === 'unattested' || b.state === 'unknown' || !b.enabled ? '' : `<dl class="mt-3 grid gap-1 text-xs text-slate-400 md:grid-cols-2">
        <div><dt class="inline">Shares backed:</dt> <dd class="inline text-slate-200">${T.num(b.backed_shares)} of ${T.num(b.supply)}${b.coverage_bps !== null ? ' (' + (b.coverage_bps / 100).toFixed(1) + '%)' : ''}</dd></div>
        <div><dt class="inline">Checked:</dt> <dd class="inline text-slate-200">${when(b.as_of)}</dd></div>
        <div><dt class="inline">Valid until:</dt> <dd class="inline text-slate-200">${when(b.valid_until)}</dd></div>
        <div><dt class="inline">Custodian:</dt> <dd class="inline font-mono text-slate-200">${T.short(b.custodian)}</dd></div>
        <div class="md:col-span-2"><dt class="inline">Evidence hash (statement / deed / receipt):</dt> <dd class="inline break-all font-mono text-slate-200">${b.evidence_hash}</dd></div></dl>`;
    return `<div class="card ${cls.split(' ')[0]}"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-semibold text-white">Proof of backing</h2><span class="pill ${cls}">${label}</span></div>
      <p class="mt-2 text-sm text-slate-400">Is the asset really there? A custodian signs a statement of how many shares are backed. The marketplace contract checks it on every purchase and refuses to sell shares if the reserve falls short.${T.cfg.backing && T.cfg.backing.mock_custodian ? ' <span class="text-gold">Demo: the custodian is simulated.</span>' : ''}</p>${detail}</div>`;
  }


  function documentsCard() {
    const ex = (p) => (T.cfg && T.cfg.explorer_url ? `${T.cfg.explorer_url}/${p}` : null);
    const link = (href, text) => (href ? `<a href="${T.esc(href)}" target="_blank" rel="noopener" class="text-gold underline">${text}</a>` : '<span class="text-slate-500">not available on this network</span>');
    const b = a.backing || {};
    const row = (k, v) => `<div class="border-t border-line py-2"><div class="text-xs uppercase tracking-wide text-slate-400">${k}</div><div class="mt-1 text-sm text-slate-200 break-all">${v}</div></div>`;
    return `<div class="card"><h2 class="mb-1 font-semibold text-white">Documents &amp; evidence</h2>
      <p class="mb-2 text-sm text-slate-400">Everything an investor, owner or regulator can check without trusting Tessera.</p>
      ${row('Asset dossier (valuation, legal structure, manager)', `Fingerprint <span class="font-mono">${T.short(a.document_hash)}</span> is stored in the token contract. ${a.dossier_verified ? '<span class="text-teal">✓ The dossier shown on this page matches it.</span>' : '<span class="text-gold">The dossier shown here could not be matched to the on-chain fingerprint.</span>'}`)}
      ${row('Custodian evidence (statement, deed or receipt)', b.evidence_hash && b.evidence_hash !== '0x' + '0'.repeat(64) ? `Fingerprint <span class="font-mono">${T.short(b.evidence_hash)}</span> signed by the custodian. Keep the original file: its hash must match.` : 'No custodian statement has been submitted yet.')}
      ${row('Token contract on the blockchain explorer', link(ex('address/' + a.address), 'View contract and every mint, transfer and yield event'))}
      ${row('Check a receipt yourself', '<a href="/verify" class="text-gold underline">Open the public receipt verifier</a>')}
      <p class="mt-3 text-xs text-slate-500">Status: ${a.dossier_verified ? 'dossier verified' : 'dossier unverified'} · ${b.state === 'backed' ? 'reserve attested' : b.state === 'shortfall' ? 'reserve shortfall' : b.state === 'stale' ? 'attestation expired' : 'no attestation'}</p></div>`;
  }

  function risksCard() {
    return `<div class="card"><h2 class="mb-2 font-semibold text-white">Risks, in plain language</h2><ul class="list-disc space-y-1 pl-5 text-sm text-slate-300">
      <li><b>You hold a claim, not the building.</b> Your rights come from the legal structure (${T.esc(a.legal_structure || 'see dossier')}), not from the token alone.</li>
      <li><b>Value can go down.</b> The share price follows what buyers will pay, and the underlying asset can lose value.</li>
      <li><b>Selling needs a buyer.</b> You can list shares at any time, but nobody is obliged to buy them.</li>
      <li><b>Income depends on the issuer.</b> Yield is only paid if the asset earns it and the issuer deposits it.</li>
      <li><b>Only verified wallets can hold shares.</b> Frozen or unverified wallets cannot receive or sell them.</li></ul></div>`;
  }

  function render() {
    const yieldPct = a.target_yield_bps ? (a.target_yield_bps / 100).toFixed(1) + '%' : '-';
    const px = a.best_ask || a.last_price;
    root.innerHTML = `
    <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div><h1 class="text-3xl font-bold text-white">${T.esc(a.name)} <span class="font-mono text-lg text-slate-400">${T.esc(a.symbol)}</span></h1>
      <p class="mt-1 text-slate-400">${T.esc(a.asset_class_name)}${a.location ? ' · ' + T.esc(a.location) : ''}</p></div>
      <span class="pill ${a.min_tier === 2 ? 'border-gold/50 text-gold' : 'border-teal/40 text-teal'}">${a.min_tier === 2 ? 'Accredited investors' : 'Verified retail + accredited'}</span></div>
    <div class="mb-6" id="hero">${T.assetImage(a, 220)}</div>
    <div class="mb-6">${banner()}</div>
    <div class="grid gap-6 lg:grid-cols-3">
      <div class="space-y-6 lg:col-span-2">
        <div class="card"><div class="grid grid-cols-2 gap-4 md:grid-cols-4">
          ${[['Price / share', px ? T.money(px) : '-'], ['Target yield', yieldPct], ['Valuation', a.valuation_cents ? T.money(BigInt(a.valuation_cents) * 10n ** BigInt(T.cfg.token.decimals - 2), 0) : '-'], ['Holders', a.holders]]
            .map(([k, v]) => `<div><div class="text-xs uppercase tracking-wide text-slate-400">${k}</div><div class="mt-1 text-lg font-semibold text-white">${v}</div></div>`).join('')}</div>
          <p class="mt-4 text-sm text-slate-300">${T.esc(a.description || '')}</p>
          <dl class="mt-4 grid gap-2 text-xs text-slate-400 md:grid-cols-2">
            <div><dt class="inline">Legal structure:</dt> <dd class="inline text-slate-300">${T.esc(a.legal_structure || '-')}</dd></div>
            <div><dt class="inline">Payouts:</dt> <dd class="inline text-slate-300">${T.esc(a.payout_frequency || '-')}</dd></div>
            <div class="md:col-span-2"><dt class="inline">Dossier hash (on-chain):</dt> <dd class="inline font-mono text-slate-300 break-all">${a.document_hash}</dd> ${a.dossier_verified ? '<span class="pill border-teal/40 text-teal">matches dossier</span>' : '<span class="pill border-line">no dossier</span>'}</div>
            <div class="md:col-span-2"><dt class="inline">Token contract:</dt> <dd class="inline font-mono text-slate-300 break-all">${a.address}</dd></div></dl></div>

        ${backingCard()}
        ${documentsCard()}
        <div class="card"><h2 class="mb-3 font-semibold text-white">Order book</h2>
          ${a.order_book.length ? `<table class="w-full"><thead><tr><th class="th">Seller</th><th class="th">Shares</th><th class="th">Price</th><th class="th"></th></tr></thead><tbody>
            ${a.order_book.map((l) => `<tr class="border-t border-line"><td class="td font-mono text-xs">${T.short(l.seller)}${l.seller === a.issuer ? ' <span class="pill border-gold/40 text-gold">issuer</span>' : ''}</td><td class="td">${T.num(l.remaining)}</td><td class="td">${T.money(l.price_per_share)}</td>
            <td class="td text-right">${(T.address && l.seller === T.address) ? `<button data-cancel="${l.id}" class="btn-ghost py-1">Cancel</button>` : `<button data-buy="${l.id}" data-price="${l.price_per_share}" data-max="${l.remaining}" class="btn-gold py-1 ${a.backing && a.backing.state === 'shortfall' ? 'opacity-40' : ''}" ${a.backing && a.backing.state === 'shortfall' ? 'disabled title="Buying is halted: the custodian reports a reserve shortfall."' : ''}>Buy</button>`}</td></tr>`).join('')}</tbody></table>` : '<p class="text-sm text-slate-400">No shares for sale right now.</p>'}</div>

        <div class="card"><h2 class="mb-3 font-semibold text-white">Recent trades</h2>
          ${a.trades.length ? `<table class="w-full"><thead><tr><th class="th">When</th><th class="th">Buyer</th><th class="th">Shares</th><th class="th">Price</th></tr></thead><tbody>${a.trades.map((t) => `<tr class="border-t border-line"><td class="td text-xs text-slate-400">${new Date(t.time * 1000).toLocaleString()}</td><td class="td font-mono text-xs">${T.short(t.buyer)}</td><td class="td">${T.num(t.amount)}</td><td class="td">${T.money(t.price_per_share)}</td></tr>`).join('')}</tbody></table>` : '<p class="text-sm text-slate-400">No trades yet.</p>'}</div>
      </div>

      <div class="space-y-6">
        ${risksCard()}
        <div class="card" id="yield-card"><h2 class="mb-3 font-semibold text-white">Yield</h2>
          <div class="text-sm text-slate-400">Paid out so far</div><div class="text-xl font-semibold text-teal">${T.money(a.yield_deposited)}</div>
          <div id="my-yield" class="mt-3 text-sm text-slate-400"></div>
          ${a.yield_history.length ? `<div class="mt-4 space-y-1 text-xs text-slate-400">${a.yield_history.slice(0, 6).map((y) => `<div class="flex justify-between"><span>${new Date(y.time * 1000).toLocaleDateString()}</span><span class="text-slate-200">${T.money(y.amount)}</span></div>`).join('')}</div>` : ''}</div>
        <div class="card hidden" id="sell-card"><h2 class="mb-3 font-semibold text-white">Sell your shares</h2>
          <p class="mb-3 text-xs text-slate-400">Non-custodial: shares stay in your wallet and keep earning yield until a buyer takes them.</p>
          <div id="holding" class="mb-2 text-sm text-slate-300"></div>
          <label class="label">Shares</label><input id="sell-n" type="number" min="1" class="input mb-2">
          <label class="label">Price per share</label><input id="sell-p" type="number" step="0.01" min="0.01" class="input mb-3">
          <button id="sell-go" class="btn-gold w-full">List for sale</button></div>
        <div class="card hidden" id="issuer-card"><h2 class="mb-3 font-semibold text-white">Issuer tools</h2>
          <label class="label">Deposit income to distribute</label><input id="dep-amt" type="number" step="0.01" class="input mb-2" placeholder="e.g. 85000"><input id="dep-ref" class="input mb-3" placeholder="Period label e.g. 2026-11">
          <button id="dep-go" class="btn-gold w-full">Deposit yield</button></div>
      </div>
    </div>`;
    T.wireImages($('#hero'));
    wire();
  }

  async function wire() {
    const c = T.cfg;
    $('#signin')?.addEventListener('click', async () => { try { await T.signIn(); await load(); } catch (e) { T.toast(T.reason(e), 'error'); } });
    root.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await T.signIn();
        const n = Number(prompt(`How many shares? (max ${b.dataset.max})`, '10')); if (!n || n < 1) return;
        const price = BigInt(b.dataset.price), cost = price * BigInt(n);
        await T.ensureAllowance('stable', c.token.address, c.market_address, cost);
        await T.sendTx('Buy shares', () => T.contract('market', c.market_address).buy(b.dataset.buy, n));
        await T.api('/api/market/sync', { method: 'POST' }); await load();
      } catch (e) { T.toast(T.reason(e), 'error'); }
    }));
    root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      try { await T.sendTx('Cancel listing', () => T.contract('market', c.market_address).cancel(b.dataset.cancel)); await T.api('/api/market/sync', { method: 'POST' }); await load(); } catch (e) { T.toast(T.reason(e), 'error'); }
    }));
    if (!T.address) return;
    const asset = T.contract('asset', addr);
    const [bal, pend] = await Promise.all([asset.balanceOf(T.address), asset.pendingYield(T.address)]);
    $('#my-yield').innerHTML = `You hold <b class="text-white">${T.num(bal)}</b> shares · claimable <b class="text-teal">${T.money(pend)}</b> ${pend > 0n ? '<button id="claim" class="btn-gold ml-2 py-1">Claim</button>' : ''}`;
    $('#claim')?.addEventListener('click', async () => { try { await T.sendTx('Claim yield', () => asset.claim()); await T.api('/api/market/sync', { method: 'POST' }); await load(); } catch (e) { T.toast(T.reason(e), 'error'); } });
    if (bal > 0n) {
      $('#sell-card').classList.remove('hidden'); $('#holding').textContent = `You own ${T.num(bal)} shares.`;
      $('#sell-go').addEventListener('click', async () => {
        try {
          const n = BigInt($('#sell-n').value || 0), p = T.toUnits($('#sell-p').value || 0);
          if (n < 1n || p < 1n) return T.toast('Enter shares and a price.', 'error');
          if ((await asset.allowance(T.address, c.market_address)) < n) await T.sendTx('Approve marketplace', () => asset.approve(c.market_address, ethers.MaxUint256));
          await T.sendTx('List shares', () => T.contract('market', c.market_address).list(addr, n, p));
          await T.api('/api/market/sync', { method: 'POST' }); await load();
        } catch (e) { T.toast(T.reason(e), 'error'); }
      });
    }
    if ((await asset.issuer()).toLowerCase() === T.address) {
      $('#issuer-card').classList.remove('hidden');
      $('#dep-go').addEventListener('click', async () => {
        try {
          const amt = T.toUnits($('#dep-amt').value || 0); if (amt < 1n) return T.toast('Enter an amount.', 'error');
          await T.ensureAllowance('stable', c.token.address, addr, amt);
          await T.sendTx('Deposit yield', () => asset.depositYield(amt, ethers.id($('#dep-ref').value || 'period')));
          await T.api('/api/market/sync', { method: 'POST' }); await load();
        } catch (e) { T.toast(T.reason(e), 'error'); }
      });
    }
  }

  document.addEventListener('tessera:connected', () => load().catch((e) => T.toast(T.reason(e), 'error')));
  load().catch((e) => { root.innerHTML = `<div class="card text-red-300">${T.esc(e.message)}</div>`; });
})();
