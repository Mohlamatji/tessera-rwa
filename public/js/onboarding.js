(async function () {
  const T = Tessera, $ = (s) => document.querySelector(s), root = $('#root');
  const STEPS = ['Connect wallet', 'Consent', 'Verify identity', 'Register on-chain'];
  let step = 0, status = null;
  const bar = (i) => { $('#steps').innerHTML = STEPS.map((s, n) => `<li class="pill ${n < i ? 'border-teal/40 text-teal' : n === i ? 'border-gold text-gold' : 'border-line text-slate-500'}">${n + 1}. ${s}</li>`).join(''); };

  let busy = false;
  async function refresh({ interactive = false } = {}) {
    if (busy && !interactive) return; busy = true;
    try { await refreshInner(interactive); } finally { busy = false; }
  }
  async function refreshInner(interactive) {
    await T.config();
    if (!T.address) { step = 0; return draw(); }
    // A wallet that reconnected silently has not signed in yet: wait for an explicit click instead of surprising the user with a popup.
    if (!T.hasSession() && !interactive) { step = 0; return draw(); }
    await T.signIn();
    status = await T.api('/api/kyc/status', { auth: true });
    if (status.on_chain_tier > 0) step = 4;
    else if (status.status === 'approved') step = 3;
    else if (!status.consent) step = 1;
    else step = 2;
    draw();
  }

  function draw() {
    bar(step);
    if (step === 0) root.innerHTML = '<div class="card"><p class="text-slate-300">Connect a browser wallet to begin. Signing in is a free message signature - no gas, no spending permission.</p><button id="c" class="btn-gold mt-4">Connect wallet</button></div>';
    if (step === 1) root.innerHTML = `<div class="card"><h2 class="font-semibold text-white">Consent to identity processing</h2>
      <p class="mt-2 text-sm text-slate-400">We verify your identity and screen against sanctions and PEP lists, as the law requires of investment platforms. Your details are encrypted and stored off-chain; the blockchain only sees an opaque approval. You can export or erase your data at any time from your portfolio page, and revoke consent.</p>
      <button id="consent" class="btn-gold mt-4">I agree</button></div>`;
    if (step === 2) root.innerHTML = form();
    if (step === 3) root.innerHTML = approved();
    if (step === 4) root.innerHTML = `<div class="card border-teal/40"><h2 class="font-semibold text-teal">✓ You're verified on-chain</h2><p class="mt-2 text-sm text-slate-300">Tier ${status.on_chain_tier} until ${status.valid_until ? new Date(status.valid_until).toLocaleDateString() : '-'}. You can now buy shares.</p>
      <div class="mt-4 flex gap-2"><a href="/" class="btn-gold">Browse assets</a><button id="copy" class="btn-ghost">Copy my receipt</button></div></div>`;
    if (step === 2 && status && status.status && status.status !== 'none') root.insertAdjacentHTML('afterbegin', outcome());
    wire();
  }

  const field = (n, l, extra = '') => `<div><label class="label" for="${n}">${l}</label><input id="${n}" name="${n}" class="input" ${extra}></div>`;
  function form() {
    return `<form id="kyc" class="card grid gap-3 md:grid-cols-2">
      ${field('full_name', 'Full legal name', 'required value="Alice Investor"')}${field('dob', 'Date of birth', 'type="date" required value="1990-05-15"')}
      <div><label class="label" for="id_type">ID type</label><select id="id_type" class="input"><option value="za_id">South African ID</option><option value="passport">Passport</option></select></div>
      ${field('id_number', 'ID / passport number', 'required')}
      ${field('country', 'Country (ISO code)', 'maxlength="2" required value="ZA"')}
      <div><label class="label" for="investor_type">Investor category</label><select id="investor_type" class="input"><option value="retail">Retail</option><option value="accredited">Accredited / qualified</option></select></div>
      ${field('intended', 'Intended investment (whole currency)', 'type="number" min="0" value="50000"')}
      ${field('sof', 'Source of funds', 'placeholder="Salary, savings, business income…"')}
      <div id="acc" class="hidden md:col-span-2 grid gap-3 md:grid-cols-3">${field('net_worth', 'Net worth (excl. home)', 'type="number"')}${field('income', 'Annual income', 'type="number"')}${field('evidence', 'Accreditation evidence ref', 'placeholder="evd_… (demo: any evd_ value)"')}</div>
      <div id="sofev" class="md:col-span-2">${field('sof_ev', 'Source-of-funds evidence ref (needed for larger amounts)', 'placeholder="evd_… (demo: any evd_ value)"')}</div>
      <div class="md:col-span-2"><button class="btn-gold">Submit for verification</button> <span class="ml-2 text-xs text-slate-500">Demo: ID numbers are validated by the mock provider (the form pre-fills a valid test ID on request).</span></div></form>`;
  }
  function outcome() {
    const s = status, cls = s.status === 'rejected' ? 'border-danger/40' : 'border-gold/40';
    return `<div class="card ${cls}"><div class="font-semibold text-white">Status: ${T.esc(s.status)}</div><p class="mt-1 text-sm text-slate-300">${T.esc(s.message || '')}</p>
      ${(s.fixable_issues || []).map((i) => `<p class="mt-1 text-sm text-red-300">• ${T.esc(i)}</p>`).join('')}${s.required_action ? `<p class="mt-1 text-sm text-gold">Next: ${T.esc(s.required_action.replace(/_/g, ' '))}</p>` : ''}</div>`;
  }
  function approved() {
    const c = status.claim;
    return `<div class="card border-teal/40"><h2 class="font-semibold text-teal">✓ Approved (tier ${status.tier})</h2>
      <p class="mt-2 text-sm text-slate-300">Last step: submit your signed approval to the compliance registry from your wallet (you pay a tiny gas fee). It's bound to your wallet, so nobody else can use it.</p>
      ${c ? '<button id="reg" class="btn-gold mt-4">Register on-chain</button>' : '<p class="mt-3 text-sm text-red-300">On-chain mode is not configured on this server.</p>'}</div>`;
  }

  function wire() {
    $('#c')?.addEventListener('click', async (ev) => { const b = ev.currentTarget; b.disabled = true; try { await T.connect(); step = 0; draw(); await refresh({ interactive: true }); } catch (e) { T.toast(T.reason(e), 'error'); step = 0; draw(); } finally { b.disabled = false; } });
    $('#consent')?.addEventListener('click', async () => { try { await T.api('/api/consent/grant', { method: 'POST', auth: true }); await refresh({ interactive: true }); } catch (e) { T.toast(T.reason(e), 'error'); } });
    const it = $('#investor_type'); if (it) { it.addEventListener('change', () => $('#acc').classList.toggle('hidden', it.value !== 'accredited')); }
    $('#kyc')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (id) => $('#' + id).value.trim(), cents = (id) => Math.round(Number(v(id) || 0) * 100);
      try {
        status = await T.api('/api/kyc/submit', { method: 'POST', auth: true, body: { full_name: v('full_name'), dob: v('dob'), id_type: v('id_type'), id_number: v('id_number'), country: v('country'), investor_type: v('investor_type'),
          intended_investment_cents: cents('intended'), source_of_funds: v('sof'), source_of_funds_evidence_ref: v('sof_ev'), accreditation: { net_worth_cents: cents('net_worth'), annual_income_cents: cents('income'), evidence_ref: v('evidence') } } });
        await refresh({ interactive: true });
      } catch (er) { T.toast(T.reason(er), 'error'); }
    });
    $('#reg')?.addEventListener('click', async () => {
      try {
        const c = status.claim, rc = await T.sendTx('Register', () => T.contract('registry', c.registry_address).register(c.claim, c.signature));
        await T.api('/api/kyc/registered', { method: 'POST', auth: true, body: { tx_hash: rc.hash } });
        await refresh({ interactive: true });
      } catch (er) { T.toast(T.reason(er), 'error'); }
    });
    $('#copy')?.addEventListener('click', () => { navigator.clipboard.writeText(status.receipt); T.toast('Receipt copied - verify it on the Verify page.', 'ok'); });
  }

  bar(0); draw();
  document.addEventListener('tessera:connected', () => refresh().catch((e) => T.toast(T.reason(e), 'error')));
})();
