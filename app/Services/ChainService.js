import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../Support/Config.js';
import { Eth } from '../Support/Eth.js';
import { Merkle } from '../Support/Merkle.js';
import { getDb } from '../../config/database.js';
import { AuditLog } from '../Models/AuditLog.js';
import { KycDecision } from '../Models/KycDecision.js';
import { ReceiptService } from './ReceiptService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const abiCache = new Map();
export const abi = (name) => {
  if (!abiCache.has(name)) abiCache.set(name, JSON.parse(fs.readFileSync(path.join(root, 'chain', 'artifacts', `${name}.json`), 'utf8')).abi);
  return abiCache.get(name);
};

let rpc = null, rpcKey = '';
const at = (name, address) => new ethers.Contract(address, abi(name), ChainService.provider());

/** Everything the server does with the blockchain. The server never holds a funded key: the attestor key only signs. */
export const ChainService = {
  enabled() {
    const c = Config.get('chain');
    return Boolean(c.enabled && c.rpc_url && c.registry_address && c.factory_address && c.market_address && c.anchor_address && c.token_address && c.attestor_private_key);
  },

  /** Safe to expose to browsers: no RPC URL credentials beyond what the operator chooses, no keys. */
  status() {
    const c = Config.get('chain');
    const on = ChainService.enabled();
    return {
      enabled: on, name: c.name, chain_id: c.id,
      registry_address: c.registry_address || null, factory_address: c.factory_address || null, market_address: c.market_address || null,
      anchor_address: c.anchor_address || null, backing_address: c.backing_address || null, offramp_address: c.offramp_address || null, explorer_url: c.explorer_url || null, rpc_url: c.rpc_url || null,
      token: { address: c.token_address || null, symbol: c.token_symbol, decimals: c.token_decimals },
      attestor_address: on ? Eth.attestorAddress(c.attestor_private_key) : null,
      currency: Config.get('currency'),
      backing: { enabled: on && Boolean(c.backing_address), mock_custodian: Boolean(c.custodian_private_key) },
      cashout: { enabled: on && Boolean(c.offramp_address), fee_bps: Config.get('payouts.fee_bps'), min_cents: Config.get('payouts.min_cents'), max_cents: Config.get('payouts.max_cents'), settle_seconds: Config.get('payouts.settle_seconds'), simulated: Config.get('payouts.provider') === 'mock' },
    };
  },

  provider() {
    const c = Config.get('chain');
    const key = `${c.rpc_url}|${c.id}`;
    if (!rpc || rpcKey !== key) { rpc = new ethers.JsonRpcProvider(c.rpc_url, c.id, { staticNetwork: true, batchMaxCount: 1 }); rpcKey = key; }
    return rpc;
  },
  reset() { try { rpc?.destroy(); } catch { /* ignore */ } rpc = null; rpcKey = ''; },

  contract: at,
  registry() { return at('ComplianceRegistry', Config.get('chain.registry_address')); },
  factory() { return at('AssetFactory', Config.get('chain.factory_address')); },
  market() { return at('RWAMarketplace', Config.get('chain.market_address')); },
  anchorContract() { return at('AuditAnchor', Config.get('chain.anchor_address')); },
  backingOracle() { return at('BackingOracle', Config.get('chain.backing_address')); },
  stable() { return at('MockStablecoin', Config.get('chain.token_address')); },
  asset(address) { return at('AssetToken', address); },
  explorerTx(h) { const u = Config.get('chain.explorer_url'); return u && h ? `${u}/tx/${h}` : null; },

  // ------------------------------------------------------------------ KYC claims

  /** Signs the EIP-712 claim the investor's wallet submits to ComplianceRegistry.register. Only for live, approved decisions. */
  async issueClaim(d) {
    if (!ChainService.enabled() || !d || d.decision !== 'approved' || !d.claim_expiry || d.claim_expiry <= Math.floor(Date.now() / 1000)) return null;
    const c = Config.get('chain');
    const claim = { decisionId: d.decision_id, wallet: Eth.checksum(d.wallet), tier: d.tier, expiry: d.claim_expiry };
    const signature = await Eth.signClaim(c.attestor_private_key, c.id, c.registry_address, claim);
    return { claim, signature, registry_address: c.registry_address, chain_id: c.id };
  },

  async tierOf(wallet) {
    if (!ChainService.enabled()) return null;
    return Number(await ChainService.registry().tierOf(wallet));
  },

  /** Reads the receipt of the investor's register() tx and returns the on-chain Registered event, or throws. */
  async verifyRegistration(txHash, wallet) {
    if (!Eth.isTxHash(txHash)) throw new Error('Invalid transaction hash.');
    const rc = await ChainService.provider().getTransactionReceipt(txHash);
    if (!rc || rc.status !== 1) throw new Error('Transaction not found or failed.');
    const reg = ChainService.registry();
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== Config.get('chain.registry_address').toLowerCase()) continue;
      const ev = (() => { try { return reg.interface.parseLog(l); } catch { return null; } })();
      if (ev?.name === 'Registered' && ev.args.wallet.toLowerCase() === wallet) {
        return { tier: Number(ev.args.tier), expiry: Number(ev.args.expiry), decision_id: ev.args.decisionId, block: rc.blockNumber };
      }
    }
    throw new Error('That transaction did not register this wallet.');
  },

  // ------------------------------------------------------------------ audit anchoring

  lastAnchoredId() { return getDb().prepare('SELECT COALESCE(MAX(to_id), 0) v FROM audit_anchors').get().v; },

  /** The next un-anchored batch of the audit log as a Merkle root, ready for the operator's wallet to publish. */
  anchorPrepare() {
    const rows = AuditLog.since(ChainService.lastAnchoredId());
    if (!rows.length) return null;
    const { root: r } = Merkle.build(rows.map((x) => x.entry_hash));
    return { root: r, from_id: rows[0].id, to_id: rows[rows.length - 1].id, count: rows.length, anchor_address: Config.get('chain.anchor_address') };
  },

  /** Records an anchor ONLY if the on-chain event matches a root recomputed from our own log. */
  async anchorRecord(root, txHash) {
    if (!Eth.isTxHash(txHash)) throw new Error('Invalid transaction hash.');
    const rc = await ChainService.provider().getTransactionReceipt(txHash);
    if (!rc || rc.status !== 1) throw new Error('Transaction not found or failed.');
    const anc = ChainService.anchorContract();
    let ev = null;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== Config.get('chain.anchor_address').toLowerCase()) continue;
      try { const p = anc.interface.parseLog(l); if (p?.name === 'Anchored') ev = p; } catch { /* skip */ }
    }
    if (!ev) throw new Error('That transaction did not anchor an audit root.');
    const onChainRoot = String(ev.args.root).toLowerCase();
    if (root && String(root).toLowerCase() !== onChainRoot) throw new Error('Root does not match the transaction.');
    const from = Number(ev.args.fromId), to = Number(ev.args.toId);
    const rows = AuditLog.range(from, to);
    if (!rows.length || rows.length !== Number(ev.args.count)) throw new Error('Anchored range does not match the audit log.');
    if (Merkle.build(rows.map((x) => x.entry_hash)).root.toLowerCase() !== onChainRoot) throw new Error('Anchored root does not match the audit log - the log may have been altered.');
    getDb().prepare('INSERT OR IGNORE INTO audit_anchors (root, from_id, to_id, count, tx_hash) VALUES (?,?,?,?,?)').run(onChainRoot, from, to, rows.length, txHash);
    AuditLog.append('admin', 'audit.anchored', 'audit_anchors', onChainRoot.slice(0, 18));
    return { status: 'ok', root: onChainRoot, from_id: from, to_id: to, count: rows.length, explorer_url: ChainService.explorerTx(txHash) };
  },

  anchors() {
    return getDb().prepare('SELECT * FROM audit_anchors ORDER BY id DESC LIMIT 50').all().map((a) => ({ ...a, explorer_url: ChainService.explorerTx(a.tx_hash) }));
  },

  /** Merkle proof for one audit entry against the anchored root, computed from the CURRENT database. */
  async proofForAudit(auditId) {
    const entry = AuditLog.find(auditId);
    if (!entry) return { found: false };
    const a = getDb().prepare('SELECT * FROM audit_anchors WHERE from_id <= ? AND to_id >= ? ORDER BY id DESC LIMIT 1').get(auditId, auditId);
    if (!a) return { found: true, audit_id: auditId, anchored: false };
    const rows = AuditLog.range(a.from_id, a.to_id);
    const intact = rows.length === a.count && Merkle.build(rows.map((r) => r.entry_hash)).root.toLowerCase() === a.root.toLowerCase();
    let proof = null;
    if (rows.length) {
      const idx = rows.findIndex((r) => r.id === auditId);
      if (idx >= 0) proof = Merkle.proof(Merkle.build(rows.map((r) => r.entry_hash)).layers, idx);
    }
    let onChain = null;
    if (ChainService.enabled()) { try { onChain = Number((await ChainService.anchorContract().anchors(a.root)).timestamp) > 0; } catch { onChain = null; } }
    return {
      found: true, audit_id: auditId, anchored: true, leaf: '0x' + entry.entry_hash, root: a.root, proof, root_on_chain: onChain,
      log_intact_since_anchor: intact, explorer_url: ChainService.explorerTx(a.tx_hash),
    };
  },

  // ------------------------------------------------------------------ public receipt verification

  /** PUBLIC. Authenticity + on-chain evidence + audit proofs for a KYC receipt. Returns no personal data. */
  async verifyReceipt(token) {
    const r = ReceiptService.verify(token);
    if (!r) return { valid: false, message: 'This receipt is not genuine, has expired, or has been altered.' };
    const d = KycDecision.findByDecisionId(r.did);
    const out = {
      valid: true,
      receipt: { decision_id: r.did, decision: r.dec, tier: r.tier, score: r.score, engine: r.eng, issued_at: new Date(r.iat * 1000).toISOString() },
      on_record: { found: Boolean(d), matches_receipt: Boolean(d && d.decision === r.dec && d.tier === r.tier && d.score === r.score) },
      registration: null, audit_trail: [],
    };
    if (!d) return out;

    if (ChainService.enabled() && d.decision === 'approved') {
      try {
        const rec = await ChainService.registry().records(Eth.checksum(d.wallet));
        const reg = rec.decisionId.toLowerCase() === r.did.toLowerCase();
        out.registration = {
          status: reg ? 'registered' : (d.registered_tx ? 'superseded' : 'not_registered'),
          tier_on_chain: Number(await ChainService.registry().tierOf(Eth.checksum(d.wallet))),
          explorer_url: ChainService.explorerTx(d.registered_tx),
        };
      } catch { out.registration = { status: 'chain_unreachable' }; }
    }
    for (const e of AuditLog.forSubject('kyc_decisions', d.id)) {
      const p = await ChainService.proofForAudit(e.id);
      out.audit_trail.push({ audit_id: e.id, action: e.action, time: e.created_at, anchored: Boolean(p.anchored), root: p.root ?? null, leaf: p.leaf ?? null, proof: p.proof ?? null,
        root_on_chain: p.root_on_chain ?? null, log_intact_since_anchor: p.log_intact_since_anchor ?? null, explorer_url: p.explorer_url ?? null });
    }
    return out;
  },

  // ------------------------------------------------------------------ proof of backing

  /** What the custodian has attested for an asset, read live from BackingOracle. state: unattested | backed | stale | shortfall */
  async backingStatus(asset) {
    const c = Config.get('chain');
    if (!ChainService.enabled() || !c.backing_address) return { enabled: false, state: 'unattested' };
    const STATES = ['unattested', 'backed', 'stale', 'shortfall'];
    try {
      const o = ChainService.backingOracle();
      const [st, custodian] = await Promise.all([o.status(Eth.checksum(asset)), o.custodian()]);
      const backed = BigInt(st.backed), supply = BigInt(st.supply);
      return {
        enabled: true, state: STATES[Number(st.state)], backed_shares: backed.toString(), supply: supply.toString(),
        coverage_bps: supply === 0n ? null : Number((backed * 10_000n) / supply),
        as_of: Number(st.asOf) || null, valid_until: Number(st.validUntil) || null,
        evidence_hash: Number(st.state) === 0 ? null : st.evidenceHash, oracle_address: c.backing_address, custodian,
      };
    } catch { return { enabled: true, state: 'unknown' }; }
  },

  /** MOCK custodian: signs an attestation for an asset. Real custodians sign on their own infrastructure. */
  async prepareAttestation({ asset, mode, backedShares = null, evidence = '' }) {
    const c = Config.get('chain');
    if (!ChainService.backingStatusEnabled()) throw new Error('Proof of backing is not configured (BACKING_ADDRESS).');
    if (!c.custodian_private_key) throw new Error('No mock custodian key configured: the real custodian must sign this attestation.');
    if (!Eth.isAddress(asset)) throw new Error('Invalid asset address.');
    const a = Eth.checksum(asset), o = ChainService.backingOracle();
    const supply = BigInt(await ChainService.asset(a).totalSupply());
    let backed = supply;
    if (mode === 'shortfall') backed = backedShares !== null && backedShares !== '' ? BigInt(backedShares) : (supply * 90n) / 100n;
    if (backed < 0n || (mode === 'full' && backed !== supply)) throw new Error('Invalid backed share count.');
    const nonce = BigInt((await o.latest(a)).nonce) + 1n;
    const block = await ChainService.provider().getBlock('latest');
    const asOf = block.timestamp, validUntil = asOf + 30 * 86400;
    const text = (evidence || '').trim() || `MOCK custodian statement - asset ${a} - ${backed} of ${supply} shares backed - ${new Date(asOf * 1000).toISOString()}`;
    const att = { asset: a, backedShares: backed, asOf, validUntil, evidenceHash: Eth.id(text), nonce };
    const signature = await Eth.signAttestation(c.custodian_private_key, c.id, c.backing_address, att);
    return { oracle_address: c.backing_address, attestation: { ...att, backedShares: backed.toString(), nonce: nonce.toString() }, signature, evidence_text: text, mock_custodian: true };
  },
  backingStatusEnabled() { return ChainService.enabled() && Boolean(Config.get('chain.backing_address')); },

  // ------------------------------------------------------------------ cash-out verification

  /** Reads a mined stablecoin transfer from `wallet` to the off-ramp address. The amount comes from the chain, never from the client. */
  async verifyStablecoinTransfer(txHash, wallet) {
    if (!Eth.isTxHash(txHash)) throw new Error('Invalid transaction hash.');
    const c = Config.get('chain');
    const rc = await ChainService.provider().getTransactionReceipt(txHash);
    if (!rc || rc.status !== 1) throw new Error('Transaction not found, not mined yet, or failed.');
    const token = ChainService.stable();
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== c.token_address.toLowerCase()) continue;
      let ev = null; try { ev = token.interface.parseLog(l); } catch { /* skip */ }
      if (ev?.name === 'Transfer' && ev.args.from.toLowerCase() === wallet && ev.args.to.toLowerCase() === c.offramp_address.toLowerCase()) return { amount: BigInt(ev.args.value), block: rc.blockNumber };
    }
    throw new Error('That transaction did not send stablecoin from your wallet to the cash-out address.');
  },

  // ------------------------------------------------------------------ live reads used by the portfolio

  async positions(wallet, assetAddresses) {
    const addr = Eth.checksum(wallet);
    return Promise.all(assetAddresses.map(async (a) => {
      const t = ChainService.asset(a);
      const [shares, pending, claimed] = await Promise.all([t.balanceOf(addr), t.pendingYield(addr), t.claimed(addr)]);
      return { asset: a.toLowerCase(), shares: shares.toString(), pending_yield: pending.toString(), claimed_yield: claimed.toString() };
    }));
  },
  async stableBalance(wallet) { return (await ChainService.stable().balanceOf(Eth.checksum(wallet))).toString(); },
  async feeBps() { return Number(await ChainService.market().feeBps()); },
};
