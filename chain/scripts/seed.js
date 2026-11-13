// Shared by demo.mjs and the e2e test: talk to a running Tessera server the way a real browser wallet would.
import { ethers } from 'ethers';
import { SaId } from '../../app/Support/SaId.js';
import { art } from './deploy.js';

export async function api(base, p, { method = 'GET', token, body, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

/** Sign-in with a wallet signature, exactly like the browser SDK. Returns the session token. */
export async function login(base, wallet) {
  const address = (await wallet.getAddress()).toLowerCase();
  const n = await api(base, '/api/auth/nonce', { method: 'POST', body: { address } });
  const signature = await wallet.signMessage(n.data.message);
  const v = await api(base, '/api/auth/verify', { method: 'POST', body: { address, signature } });
  if (v.status !== 200) throw new Error('login failed: ' + JSON.stringify(v.data));
  return v.data.token;
}

export const profile = (over = {}) => ({
  full_name: 'Alice Investor', dob: '1990-05-15', id_type: 'za_id', id_number: SaId.make('1990-05-15', 5009), country: 'ZA', investor_type: 'retail',
  intended_investment_cents: 5_000_000, source_of_funds: 'Salary', ...over,
});

/** consent -> KYC -> (if approved) register the signed claim on-chain from the investor's own wallet -> confirm. */
export async function onboard(base, wallet, registry, over = {}) {
  const token = await login(base, wallet);
  await api(base, '/api/consent/grant', { method: 'POST', token });
  const k = await api(base, '/api/kyc/submit', { method: 'POST', token, body: profile(over) });
  if (k.data.status === 'approved' && k.data.claim) {
    const c = k.data.claim;
    const rc = await (await registry.connect(wallet).register(c.claim, c.signature)).wait();
    await api(base, '/api/kyc/registered', { method: 'POST', token, body: { tx_hash: rc.hash } });
  }
  return { token, decision: k.data, status: k.status };
}

/** Operator flow: prepare dossier on the server, then deploy the share token from the factory owner's wallet. */
export async function createAsset(base, factory, spec, adminHeaders = {}) {
  const p = await api(base, '/api/admin/assets/prepare', { method: 'POST', body: spec, headers: adminHeaders });
  if (p.status !== 200) throw new Error('prepare failed: ' + JSON.stringify(p.data));
  const a = p.data.create_asset_args;
  const rc = await (await factory.createAsset(a)).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'AssetCreated');
  await api(base, '/api/market/sync', { method: 'POST' });
  return { address: ev.args.asset, hash: p.data.metadata_hash };
}

export const SAMPLE_ASSETS = [
  { name: 'Sandton Office Tower', symbol: 'SNDT', asset_class: 0, total_shares: 1_000_000, min_tier: 1, max_holder_bps: 2000, price: 10, valuation_cents: 1_000_000_000, target_yield_bps: 950,
    location: 'Sandton, Johannesburg', legal_structure: 'SPV (Pty) Ltd, title deed held in trust', description: 'Grade-A office tower, 92% let to blue-chip tenants on 5-year escalating leases.', issuer_name: 'Sandton Property Holdings' },
  { name: 'Karoo Solar Farm', symbol: 'KSOL', asset_class: 2, total_shares: 500_000, min_tier: 1, max_holder_bps: 2000, price: 20, valuation_cents: 1_000_000_000, target_yield_bps: 1100, payout_frequency: 'monthly',
    location: 'Northern Cape', legal_structure: '20-year PPA with a municipal off-taker', description: '75 MW photovoltaic plant selling power under a fixed-price offtake agreement.', issuer_name: 'Karoo Renewables' },
  { name: 'SME Receivables Note', symbol: 'SMEN', asset_class: 1, total_shares: 200_000, min_tier: 2, max_holder_bps: 3000, price: 50, valuation_cents: 1_000_000_000, target_yield_bps: 1350,
    location: 'Diversified', legal_structure: 'Senior secured note, 24 months, first-ranking cession of receivables', description: 'Short-duration loans against invoiced receivables of 40 vetted SMEs.', issuer_name: 'Ledger Credit' },
];

export { art };
