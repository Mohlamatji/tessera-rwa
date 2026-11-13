(async function () {
  const T = Tessera, $ = (s) => document.querySelector(s), csrf = document.querySelector('meta[name=csrf]').content;
  const A = (p, o = {}) => T.api(p, { ...o, csrf });
  const kycBadge = (s) => `<span class="pill ${s === 'approved' ? 'border-teal/40 text-teal' : s === 'review' ? 'border-gold/50 text-gold' : 'border-danger/40 text-red-300'}">${s}</span>`;

  async function load() {
    await T.config();
    const s = await A('/api/admin/stats');
    $('#stats').innerHTML = [['Assets', s.market.assets], ['Trades', s.market.trades], ['Verified people', s.users], ['Open AML alerts', s.open_aml_alerts], ['KYC approved', s.kyc.approved || 0], ['In review', s.kyc.review || 0], ['Audit entries', s.audit.entries], ['Anchored up to #', s.anchored_up_to]]
      .map(([k, v]) => `<div class="card py-3"><div class="text-xs uppercase tracking-wide text-slate-400">${k}</div><div class="mt-1 text-xl font-semibold text-white">${v}</div></div>`).join('');
    const k = (await A('/api/admin/kyc')).decisions;
    $('#kyc').innerHTML = k.length ? `<table class="w-full"><thead><tr><th class="th">#</th><th class="th">Status</th><th class="th">Tier</th><th class="th">Score</th><th class="th">Why</th><th class="th"></th></tr></thead><tbody>
      ${k.map((d) => `<tr class="border-t border-line align-top"><td class="td">${d.id}</td><td class="td">${kycBadge(d.status)}${d.registered ? ' <span class="pill border-line text-slate-400">on-chain</span>' : ''}</td><td class="td">${d.tier}</td><td class="td">${d.score}</td>
      <td class="td text-xs text-slate-400">${d.gates.filter((g) => !g.passed).map((g) => '✗ ' + T.esc(g.code)).join(', ')} ${(d.raw_required_action ? '→ ' + T.esc(d.raw_required_action) : '')}</td>
      <td class="td text-right">${d.status === 'review' ? `<button data-r="${d.id}" data-a="approve" class="btn-gold py-1">Approve</button> <button data-r="${d.id}" data-a="reject" class="btn-ghost py-1">Reject</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="text-sm text-slate-400">No applications yet.</p>';
    const al = (await A('/api/admin/aml/alerts')).alerts;
    $('#aml').innerHTML = al.length ? `<table class="w-full"><thead><tr><th class="th">Rule</th><th class="th">Severity</th><th class="th">Wallet</th><th class="th">Detail</th><th class="th">Status</th><th class="th"></th></tr></thead><tbody>
      ${al.map((a) => `<tr class="border-t border-line"><td class="td">${T.esc(a.rule)}</td><td class="td">${a.severity}</td><td class="td font-mono text-xs">${T.short(a.wallet)}</td><td class="td text-xs text-slate-400">${T.esc(JSON.stringify(a.detail))}</td><td class="td">${a.status}</td>
      <td class="td text-right">${a.status === 'open' ? `<button data-freeze="${a.wallet}" class="btn-danger py-1">Freeze</button> <button data-dismiss="${a.id}" class="btn-ghost py-1">Dismiss</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="text-sm text-slate-400">No alerts. Monitoring rules: large trade, velocity, fast flip, wash trade.</p>';
    const log = (await A('/api/admin/audit-log')).entries;
    $('#audit').innerHTML = `<table class="w-full"><tbody>${log.map((e) => `<tr class="border-t border-line"><td class="td text-xs text-slate-500">#${e.id}</td><td class="td text-xs">${T.esc(e.action)}</td><td class="td text-xs text-slate-400">${T.esc(e.actor)}</td><td class="td font-mono text-xs text-slate-500">${e.entry_hash.slice(0, 12)}…</td><td class="td text-xs text-slate-500">${T.esc(e.created_at)}</td></tr>`).join('')}</tbody></table>`;
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.r) { await A(`/api/admin/kyc/${b.dataset.r}/resolve`, { method: 'POST', body: { action: b.dataset.a } }); await load(); }
      if (b.dataset.dismiss) { await A(`/api/admin/aml/alerts/${b.dataset.dismiss}/dismiss`, { method: 'POST' }); await load(); }
      if (b.dataset.freeze) {
        if (!T.address) await T.connect();
        await T.sendTx('Freeze wallet', () => T.contract('registry', T.cfg.registry_address).freeze(b.dataset.freeze));
        await A('/api/admin/sync', { method: 'POST' }); await load();
      }
    } catch (er) { T.toast(T.reason(er), 'error'); }
  });

  $('#asset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (!T.address) await T.connect();
      const dec = T.cfg.token.decimals;
      const p = await A('/api/admin/assets/prepare', { method: 'POST', body: { name: f.name, symbol: f.symbol, asset_class: Number(f.asset_class), issuer: f.issuer, total_shares: Number(f.total_shares), min_tier: Number(f.min_tier),
        max_holder_bps: Math.round(Number(f.cap) * 100), valuation_cents: Math.round(Number(f.valuation) * 100), target_yield_bps: Math.round(Number(f.yield) * 100), location: f.location, legal_structure: f.legal_structure, description: f.description, payout_frequency: 'monthly' } });
      const a = p.create_asset_args;
      await T.sendTx('Create asset', () => T.contract('factory', T.cfg.factory_address).createAsset([a.name, a.symbol, a.issuer, a.totalShares, a.assetClass, a.minTier, a.maxHolderBps, a.documentHash, a.documentURI]));
      await A('/api/admin/sync', { method: 'POST' }); T.toast('Asset live on the marketplace.', 'ok'); await load();
    } catch (er) { T.toast(T.reason(er), 'error'); }
  });

  $('#verify-chain').addEventListener('click', async () => { const r = await A('/api/admin/audit/verify'); $('#audit-status').textContent = r.intact ? `✓ Hash chain intact (${r.entries} entries).` : `✗ Tampering detected at entry #${r.first_bad_id}.`; });
  $('#anchor').addEventListener('click', async () => {
    try {
      const p = await A('/api/admin/chain/anchor/prepare');
      if (!p.pending) return T.toast('Nothing new to anchor.');
      if (!T.address) await T.connect();
      const rc = await T.sendTx('Anchor audit root', () => T.contract('anchor', p.anchor_address).anchor(p.root, p.from_id, p.to_id, p.count));
      await A('/api/admin/chain/anchor/record', { method: 'POST', body: { root: p.root, tx_hash: rc.hash } });
      T.toast(`Anchored entries #${p.from_id}-#${p.to_id}.`, 'ok'); await load();
    } catch (er) { T.toast(T.reason(er), 'error'); }
  });

  // ---- proof of backing + recovery
  let assetList = [];
  async function loadAssets() {
    try { assetList = (await T.api('/api/market/assets')).assets; } catch { assetList = []; }
    const opts = assetList.map((a) => `<option value="${a.address}">${T.esc(a.name)} (${T.esc(a.symbol)})</option>`).join('') || '<option value="">No assets yet</option>';
    for (const id of ['bk-asset', 'rc-asset']) { const el = $('#' + id); if (el) { const keep = el.value; el.innerHTML = opts; if (keep) el.value = keep; } }
    showBacking();
  }
  async function showBacking() {
    const a = $('#bk-asset').value; if (!a) return;
    const d = await T.api('/api/market/assets/' + a).catch(() => null);
    const b = d && d.backing;
    $('#bk-status').innerHTML = !b || !b.enabled ? 'Proof of backing is not configured on this server.' : b.state === 'unattested' ? 'No attestation published yet.'
      : `Status: <b class="${b.state === 'backed' ? 'text-teal' : b.state === 'shortfall' ? 'text-red-300' : 'text-gold'}">${b.state}</b> · ${T.num(b.backed_shares)} of ${T.num(b.supply)} shares backed (${(b.coverage_bps / 100).toFixed(1)}%)`;
  }
  async function attest(mode) {
    const asset = $('#bk-asset').value; if (!asset) return T.toast('Pick an asset.', 'error');
    try {
      const p = await A('/api/admin/backing/prepare', { method: 'POST', body: { asset, mode } });
      if (!T.address) await T.connect();
      const a = p.attestation;
      await T.sendTx(mode === 'full' ? 'Publish full-backing attestation' : 'Publish shortfall attestation', () => T.contract('backing', p.oracle_address).submit([a.asset, a.backedShares, a.asOf, a.validUntil, a.evidenceHash, a.nonce], p.signature));
      await showBacking();
      T.toast(mode === 'full' ? 'Backing restored - buying is open.' : 'Shortfall recorded - buying of this asset is now halted.', mode === 'full' ? 'ok' : 'info');
    } catch (er) { T.toast(T.reason(er), 'error'); }
  }
  $('#bk-full').addEventListener('click', () => attest('full'));
  $('#bk-short').addEventListener('click', () => attest('shortfall'));
  $('#bk-asset').addEventListener('change', showBacking);
  $('#recover-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target)), asset = $('#rc-asset').value;
    try {
      if (!ethers.isAddress(f.lost) || !ethers.isAddress(f.replacement)) return T.toast('Enter two valid wallet addresses.', 'error');
      if (!T.address) await T.connect();
      await T.sendTx('Recover wallet', () => T.contract('recovery', asset).recoverWallet(f.lost, f.replacement, ethers.id(f.ref)));
      await A('/api/admin/sync', { method: 'POST' }); T.toast('Shares and unclaimed yield moved to the new wallet.', 'ok');
    } catch (er) { T.toast(T.reason(er), 'error'); }
  });
  loadAssets();

  load().catch((e) => T.toast(e.message, 'error'));
})();
