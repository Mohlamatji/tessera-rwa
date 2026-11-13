(async function () {
  const T = Tessera, $ = (s) => document.querySelector(s), root = $('#root');
  async function load({ interactive = false } = {}) {
    await T.config();
    if (!T.hasSession() && !interactive) {
      root.innerHTML = `<div class="card"><p class="text-slate-300">Wallet <span class="font-mono text-gold">${T.short(T.address)}</span> is connected. Sign in with a free message signature to see your holdings.</p><button id="signin" class="btn-gold mt-4">Sign in with wallet</button></div>`;
      $('#signin').addEventListener('click', async (ev) => { ev.currentTarget.disabled = true; try { await load({ interactive: true }); } catch (e) { T.toast(T.reason(e), 'error'); ev.currentTarget.disabled = false; } });
      return;
    }
    await T.signIn();
    const [p, k] = await Promise.all([T.api('/api/portfolio', { auth: true }), T.api('/api/kyc/status', { auth: true })]);
    const co = T.cfg.cashout && T.cfg.cashout.enabled ? await T.api('/api/payouts', { auth: true }).catch(() => null) : null;
    const total = p.positions.reduce((s, x) => s + BigInt(x.value || 0), 0n);
    root.innerHTML = `
      <div class="mb-6 grid gap-3 md:grid-cols-4">
        ${[['Portfolio value', T.money(total)], ['Claimable yield', T.money(p.total_pending_yield)], ['Cash balance', T.money(p.stable_balance || 0)], ['Verification', k.on_chain_tier ? 'Tier ' + k.on_chain_tier + ' ✓' : (k.status === 'none' ? 'Not verified' : k.status)]]
          .map(([a, b]) => `<div class="card py-3"><div class="text-xs uppercase tracking-wide text-slate-400">${a}</div><div class="mt-1 text-lg font-semibold text-white">${b}</div></div>`).join('')}</div>
      <div class="mb-4 flex gap-2">${T.cfg.token.symbol === 'mZAR' ? `<button id="faucet" class="btn-ghost">Get 100,000 test ${T.cfg.token.symbol}</button>` : ''}${BigInt(p.total_pending_yield) > 0n ? '<button id="claim-all" class="btn-gold">Claim all yield</button>' : ''}</div>
      <div class="card">${p.positions.length ? `<table class="w-full"><thead><tr><th class="th">Asset</th><th class="th">Shares</th><th class="th">Value</th><th class="th">Claimable</th><th class="th">Earned (claimed)</th></tr></thead><tbody>
        ${p.positions.map((x) => `<tr class="border-t border-line"><td class="td"><a class="text-gold hover:underline" href="/asset/${x.asset}">${T.esc(x.name)}</a> <span class="font-mono text-xs text-slate-400">${T.esc(x.symbol)}</span></td><td class="td">${T.num(x.shares)}</td><td class="td">${x.value ? T.money(x.value) : '-'}</td><td class="td text-teal">${T.money(x.pending_yield)}</td><td class="td">${T.money(x.claimed_yield)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="text-slate-400">No holdings yet. <a href="/" class="text-gold underline">Browse assets</a>.</p>'}</div>

      ${co ? `<div class="card mt-6" id="cashout"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-semibold text-white">Cash out to mobile money</h2>${co.simulated ? '<span class="pill border-gold/40 text-gold">payout partner is simulated</span>' : ''}</div>
        <p class="mt-1 text-sm text-slate-400">Turn your ${T.esc(T.cfg.token.symbol)} balance into cash in a phone wallet. You send the stablecoin to the off-ramp from your wallet; the payout follows. Fee ${(co.fee_bps / 100).toFixed(2)}%. Verified investors only.</p>
        <div class="mt-3 grid gap-3 md:grid-cols-4"><div><label class="label" for="co-amt">Amount (${T.esc(T.cfg.token.symbol)})</label><input id="co-amt" type="number" min="1" step="0.01" class="input" placeholder="e.g. 500"></div>
          <div><label class="label" for="co-tel">Mobile number</label><input id="co-tel" class="input" placeholder="+27821234567" inputmode="tel"></div>
          <div><label class="label" for="co-net">Network</label><select id="co-net" class="input">${co.networks.map((n) => `<option>${T.esc(n)}</option>`).join('')}</select></div>
          <div class="flex items-end"><button id="co-go" class="btn-gold w-full">Cash out</button></div></div>
        ${co.payouts.length ? `<table class="mt-4 w-full"><thead><tr><th class="th">When</th><th class="th">To</th><th class="th">Sent</th><th class="th">Paid out</th><th class="th">Status</th><th class="th">Reference</th></tr></thead><tbody>${co.payouts.map((x) => `<tr class="border-t border-line"><td class="td text-xs text-slate-400">${new Date(x.created_at * 1000).toLocaleString()}</td><td class="td text-xs">${T.esc(x.to)} · ${T.esc(x.network)}</td><td class="td">${T.money(x.amount)}</td><td class="td text-teal">${T.money(x.net)}</td><td class="td"><span class="pill ${x.status === 'paid' ? 'border-teal/40 text-teal' : 'border-gold/50 text-gold'}">${x.status}</span></td><td class="td font-mono text-xs text-slate-400">${T.esc(x.reference)}</td></tr>`).join('')}</tbody></table>` : ''}</div>` : ''}
      <div class="mt-8 flex flex-wrap gap-2"><button id="export" class="btn-ghost">Download my data</button><button id="erase" class="btn-danger">Erase my personal data</button></div>`;
    $('#faucet')?.addEventListener('click', async () => { try { await T.sendTx('Faucet', () => T.contract('stable', T.cfg.token.address).faucet()); load(); } catch (e) { T.toast(T.reason(e), 'error'); } });
    $('#claim-all')?.addEventListener('click', async () => {
      try { for (const x of p.positions.filter((y) => BigInt(y.pending_yield) > 0n)) await T.sendTx('Claim ' + x.symbol, () => T.contract('asset', x.asset).claim()); await T.api('/api/market/sync', { method: 'POST' }); load(); } catch (e) { T.toast(T.reason(e), 'error'); }
    });
    $('#co-go')?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget; b.disabled = true;
      try {
        const amt = T.toUnits($('#co-amt').value || 0), tel = $('#co-tel').value.trim().replace(/\s+/g, '');
        if (amt < 1n) return T.toast('Enter an amount.', 'error');
        if (!/^\+[1-9]\d{8,13}$/.test(tel)) return T.toast('Enter the mobile number in international format, e.g. +27821234567.', 'error');
        if (BigInt(p.stable_balance || 0) < amt) return T.toast('That is more than your cash balance.', 'error');
        const rc = await T.sendTx('Send to cash-out', () => T.contract('stable', T.cfg.token.address).transfer(T.cfg.offramp_address, amt));
        const r = await T.api('/api/payouts', { method: 'POST', auth: true, body: { tx_hash: rc.hash, msisdn: tel, network: $('#co-net').value } });
        T.toast(`Payout ${r.reference} is on its way to ${r.to}.`, 'ok');
        await load();
        setTimeout(() => load().catch(() => {}), ((T.cfg.cashout && T.cfg.cashout.settle_seconds) || 8) * 1000 + 1000);
      } catch (e) { T.toast(T.reason(e), 'error'); } finally { b.disabled = false; }
    });
    $('#export').addEventListener('click', async () => {
      try { const d = await T.api('/api/data-subject/export', { auth: true }); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = 'my-tessera-data.json'; a.click(); } catch (e) { T.toast(e.message, 'error'); }
    });
    $('#erase').addEventListener('click', async () => {
      if (!confirm('Erase your personal data? Your off-chain identity record is deleted and your wallet unlinked. On-chain records remain (pseudonymous).')) return;
      try { const r = await T.api('/api/data-subject/delete', { method: 'POST', auth: true }); T.toast('Erased. ' + r.on_chain_note, 'ok'); } catch (e) { T.toast(e.message, 'error'); }
    });
  }
  async function start() { try { await load(); } catch (e) { T.toast(T.reason(e), 'error'); } }
  document.addEventListener('tessera:connected', start);
})();
