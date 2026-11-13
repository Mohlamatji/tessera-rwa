(function () {
  const T = Tessera, $ = (s) => document.querySelector(s);
  // Same sorted-pair keccak256 as OpenZeppelin MerkleProof - verified entirely in the browser.
  const pair = (a, b) => { const [x, y] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a]; return ethers.keccak256(ethers.concat([x, y])); };
  const merkle = (leaf, proof, root) => { let h = '0x' + leaf.replace(/^0x/, ''); for (const p of proof || []) h = pair(h, p); return h.toLowerCase() === root.toLowerCase(); };
  const row = (ok, text) => `<div class="flex gap-2 text-sm"><span class="${ok === true ? 'text-teal' : ok === false ? 'text-red-300' : 'text-slate-500'}">${ok === true ? '✓' : ok === false ? '✗' : '–'}</span><span class="text-slate-300">${text}</span></div>`;

  $('#go').addEventListener('click', async () => {
    const out = $('#out'); out.innerHTML = '<div class="card text-slate-400">Checking…</div>';
    try {
      await T.config();
      const r = await T.api('/api/chain/verify-receipt', { method: 'POST', body: { receipt: $('#receipt').value.trim() } });
      if (!r.valid) { out.innerHTML = `<div class="card border-danger/40 text-red-300">✗ ${T.esc(r.message)}</div>`; return; }
      const rc = r.receipt, reg = r.registration;
      let html = `<div class="card border-teal/40"><div class="font-semibold text-teal">✓ Genuine receipt</div>
        <dl class="mt-3 grid grid-cols-2 gap-2 text-sm"><dt class="text-slate-400">Outcome</dt><dd>${T.esc(rc.decision)}</dd><dt class="text-slate-400">Tier</dt><dd>${rc.tier}</dd><dt class="text-slate-400">Score</dt><dd>${rc.score}</dd><dt class="text-slate-400">Engine</dt><dd>${T.esc(rc.engine)}</dd><dt class="text-slate-400">Issued</dt><dd>${new Date(rc.issued_at).toLocaleString()}</dd></dl></div>
        <div class="card space-y-1">${row(r.on_record.matches_receipt, 'Matches the operator\'s record')}${reg ? row(reg.status === 'registered', 'On-chain registration: ' + reg.status.replace(/_/g, ' ') + (reg.tier_on_chain != null ? ` (effective tier now: ${reg.tier_on_chain})` : '')) : row(null, 'On-chain check not applicable')}</div>`;
      html += `<div class="card"><h2 class="mb-2 font-semibold text-white">Audit trail</h2><div class="space-y-3">${r.audit_trail.map((e) => {
        const proofOk = e.anchored && e.proof ? merkle(e.leaf, e.proof, e.root) : null;
        return `<div class="rounded-lg border border-line p-3"><div class="text-sm text-white">${T.esc(e.action)} <span class="text-xs text-slate-500">${T.esc(e.time)} · #${e.audit_id}</span></div>
          ${row(e.anchored ? true : null, e.anchored ? 'Anchored on-chain' : 'Not anchored yet')}${e.anchored ? row(proofOk, 'Merkle proof checked in your browser') + row(e.root_on_chain, 'Root exists on the blockchain') + row(e.log_intact_since_anchor, 'Log unchanged since it was anchored') : ''}</div>`;
      }).join('') || '<p class="text-sm text-slate-400">No audit entries.</p>'}</div></div>`;
      out.innerHTML = html;
    } catch (e) { out.innerHTML = `<div class="card border-danger/40 text-red-300">${T.esc(e.message)}</div>`; }
  });
})();
