(async function () {
  const T = Tessera, $ = (s) => document.querySelector(s);
  let data, filter = -1;
  try { await T.config(); data = await T.api('/api/market/assets'); } catch (e) { $('#grid').innerHTML = `<div class="card text-red-300">${T.esc(e.message)}</div>`; return; }
  const s = data.stats;
  $('#stats').innerHTML = [['Assets', s.assets], ['Tokenised value', T.money(s.tokenized_value, 0)], ['Trading volume', T.money(s.volume, 0)], ['Yield paid out', T.money(s.yield_distributed, 0)]]
    .map(([k, v]) => `<div class="card py-3"><div class="text-xs uppercase tracking-wide text-slate-400">${k}</div><div class="mt-1 text-lg font-semibold text-white">${v}</div></div>`).join('');
  const names = ['Real estate', 'Private credit', 'Green energy', 'Luxury & collectibles', 'Other'];
  const present = [...new Set(data.assets.map((a) => a.asset_class))];
  $('#filters').innerHTML = [-1, ...present].map((c) => `<button data-c="${c}" class="pill ${c === filter ? 'border-gold text-gold' : 'border-line text-slate-300'}">${c < 0 ? 'All' : names[c]}</button>`).join('');
  $('#filters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { filter = Number(b.dataset.c); render(); } });
  const icon = ['🏢', '📄', '☀️', '💎', '📦'];
  function render() {
    document.querySelectorAll('#filters button').forEach((b) => { const on = Number(b.dataset.c) === filter; b.className = `pill ${on ? 'border-gold text-gold' : 'border-line text-slate-300'}`; });
    const list = data.assets.filter((a) => filter < 0 || a.asset_class === filter);
    if (!list.length) { $('#grid').innerHTML = '<div class="card text-slate-400">No assets yet. An operator can issue the first one from the Operator console.</div>'; return; }
    $('#grid').innerHTML = list.map((a) => {
      const px = a.best_ask || a.last_price, sold = 1 - Number(a.shares_for_sale) / Number(a.total_shares);
      return `<a href="/asset/${a.address}" class="card block transition hover:border-gold/60">
        <div class="mb-3">${T.assetImage(a, 112)}</div>
        <div class="flex items-start justify-between gap-2"><div><div class="font-semibold text-white">${T.esc(a.name)}</div><div class="text-xs text-slate-400">${T.esc(a.asset_class_name)}${a.location ? ' · ' + T.esc(a.location) : ''}</div></div>
          <span class="pill ${a.min_tier === 2 ? 'border-gold/50 text-gold' : 'border-teal/40 text-teal'}">${a.min_tier === 2 ? 'Accredited' : 'Retail'}</span></div>
        ${a.backing_state === 'backed' ? '<div class="mt-2"><span class="pill border-teal/40 text-teal">✓ Backing attested</span></div>' : a.backing_state === 'shortfall' ? '<div class="mt-2"><span class="pill border-danger/40 text-red-300">✗ Reserve shortfall - buying halted</span></div>' : a.backing_state === 'stale' ? '<div class="mt-2"><span class="pill border-gold/50 text-gold">! Attestation expired</span></div>' : ''}
        <div class="mt-4 grid grid-cols-3 gap-2 text-sm">
          <div><div class="text-xs text-slate-400">Price / share</div><div class="font-medium text-white">${px ? T.money(px) : '-'}</div></div>
          <div><div class="text-xs text-slate-400">Target yield</div><div class="font-medium text-teal">${a.target_yield_bps ? (a.target_yield_bps / 100).toFixed(1) + '%' : '-'}</div></div>
          <div><div class="text-xs text-slate-400">Holders</div><div class="font-medium text-white">${a.holders}</div></div></div>
        <div class="mt-3 h-1.5 overflow-hidden rounded bg-ink"><div class="h-full bg-gold" style="width:${Math.max(0, Math.min(100, sold * 100)).toFixed(1)}%"></div></div>
        <div class="mt-1 text-xs text-slate-400">${(sold * 100).toFixed(0)}% placed with investors · ${T.num(a.shares_for_sale)} shares for sale</div></a>`;
    }).join('');
    T.wireImages($('#grid'));
  }
  render();
})();
