(function () {
  const E = [
    ['POST', '/api/auth/nonce', 'public', 'Get a single-use sign-in message for a wallet'], ['POST', '/api/auth/verify', 'public', 'Exchange the signed message for a session token'],
    ['POST', '/api/consent/grant', 'wallet', 'Record consent to KYC processing'], ['POST', '/api/kyc/submit', 'wallet', 'Submit identity details → explainable decision + signed on-chain claim'],
    ['GET', '/api/kyc/status', 'wallet', 'Current KYC state and on-chain tier'], ['POST', '/api/kyc/registered', 'wallet', 'Confirm the on-chain registration tx (verified server-side)'],
    ['GET', '/api/data-subject/export', 'wallet', 'Export all personal data held'], ['POST', '/api/data-subject/delete', 'wallet', 'Erase personal data (unless under regulatory hold)'],
    ['GET', '/api/chain/config', 'public', 'Chain id, contract addresses, settlement token'], ['POST', '/api/chain/verify-receipt', 'public', 'Verify a KYC receipt + audit proofs (no PII)'],
    ['GET', '/api/market/assets', 'public', 'All assets with prices, yield and liquidity stats'], ['GET', '/api/market/assets/{address}', 'public', 'Asset detail: order book, trades, yield history'],
    ['GET', '/api/portfolio', 'wallet', 'Your positions and claimable yield (read live from chain)'], ['POST', '/api/market/sync', 'public', 'Index new chain events now'],
    ['GET', '/api/admin/stats', 'admin', 'Operator statistics'], ['GET', '/api/admin/kyc', 'admin', 'KYC decisions with factors and gates'], ['POST', '/api/admin/kyc/{id}/resolve', 'admin', 'Approve/reject a decision under review'],
    ['GET', '/api/admin/aml/alerts', 'admin', 'AML monitoring alerts'], ['POST', '/api/admin/assets/prepare', 'admin', 'Hash an asset dossier → factory call arguments'],
    ['GET', '/api/admin/audit/verify', 'admin', 'Verify the hash-chained audit log'], ['GET', '/api/admin/chain/anchor/prepare', 'admin', 'Next Merkle root to anchor'], ['POST', '/api/admin/chain/anchor/record', 'admin', 'Record an anchor after verifying the on-chain event'],
  ];
  const c = { public: 'text-teal', wallet: 'text-gold', admin: 'text-red-300' };
  document.getElementById('eps').innerHTML = E.map(([m, p, s, d]) => `<div class="card flex flex-wrap items-center gap-3 py-3"><span class="w-14 font-mono text-xs font-bold ${m === 'GET' ? 'text-teal' : 'text-gold'}">${m}</span><code class="font-mono text-sm text-white">${p}</code><span class="pill border-line ${c[s]}">${s}</span><span class="text-sm text-slate-400">${d}</span></div>`).join('');
})();
