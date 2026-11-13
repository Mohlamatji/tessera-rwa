import { ethers } from 'ethers';
import { Config } from '../Support/Config.js';
import { getDb } from '../../config/database.js';
import { Asset, AmlAlert, ChainState, Holding, Listing, Trade, YieldEvent } from '../Models/Asset.js';
import { AuditLog } from '../Models/AuditLog.js';
import { KycDecision } from '../Models/KycDecision.js';
import { ChainService, abi } from './ChainService.js';
import { AmlService } from './AmlService.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const lc = (a) => String(a).toLowerCase();
let inflight = null, lastSyncAt = 0, timer = null;

/**
 * Turns on-chain events into a fast SQLite read model (assets, listings, trades, yield, holdings) and
 * drives the compliance side effects (learn that a claim was registered, run AML rules on trades, mark
 * freezes). The chain is the source of truth; this table set can be rebuilt from scratch at any time by
 * clearing chain_state. Every log is applied at most once (processed_logs), so a retried sync is safe.
 */
export const IndexerService = {
  /** Sync once; concurrent callers share one run. */
  sync() {
    if (!ChainService.enabled()) return Promise.resolve({ enabled: false });
    if (inflight) return inflight;
    inflight = IndexerService._sync().finally(() => { inflight = null; lastSyncAt = Date.now(); });
    return inflight;
  },

  /** Cheap guard for read endpoints: sync only if the last one is older than `ms`. */
  async syncIfStale(ms = 1500) {
    if (Date.now() - lastSyncAt < ms) return;
    try { await IndexerService.sync(); } catch (e) { console.error('[tessera] index sync failed:', e.message); }
  },

  start() {
    if (timer || !ChainService.enabled()) return;
    timer = setInterval(() => { IndexerService.syncIfStale(0).catch(() => {}); }, Config.get('chain.index_interval_ms'));
    timer.unref?.();
  },
  stop() { if (timer) clearInterval(timer); timer = null; },
  reset() { inflight = null; lastSyncAt = 0; },

  status() {
    return { last_block: Number(ChainState.get('last_block', -1)), last_sync_at: lastSyncAt ? new Date(lastSyncAt).toISOString() : null };
  },

  async _sync() {
    const c = Config.get('chain');
    const provider = ChainService.provider();
    const head = (await provider.getBlockNumber()) - c.confirmations;
    let from = ChainState.get('last_block') === null ? c.start_block : Number(ChainState.get('last_block')) + 1;
    let indexed = 0;
    while (from <= head) {
      const to = Math.min(head, from + c.max_logs_range - 1);
      indexed += await IndexerService._range(provider, from, to);
      ChainState.set('last_block', to);
      from = to + 1;
    }
    return { enabled: true, indexed, head };
  },

  async _range(provider, from, to) {
    const c = Config.get('chain');
    const ifaces = {
      factory: new ethers.Interface(abi('AssetFactory')), market: new ethers.Interface(abi('RWAMarketplace')),
      registry: new ethers.Interface(abi('ComplianceRegistry')), token: new ethers.Interface(abi('AssetToken')),
    };
    const blockTime = new Map();
    const tsOf = async (n) => { if (!blockTime.has(n)) blockTime.set(n, (await provider.getBlock(n)).timestamp); return blockTime.get(n); };

    // 1) new assets first, so their own logs in the same range are picked up in step 2
    const factoryLogs = await provider.getLogs({ address: c.factory_address, fromBlock: from, toBlock: to });
    for (const l of factoryLogs) await IndexerService._apply(l, 'factory', ifaces, tsOf);

    // 2) everything else
    const addresses = [c.market_address, c.registry_address, ...Asset.all().map((a) => a.address)];
    const logs = await provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    let n = factoryLogs.length;
    for (const l of logs) {
      const a = lc(l.address);
      const kind = a === lc(c.market_address) ? 'market' : a === lc(c.registry_address) ? 'registry' : 'token';
      if (await IndexerService._apply(l, kind, ifaces, tsOf)) n++;
    }
    return n;
  },

  async _apply(log, kind, ifaces, tsOf) {
    const db = getDb();
    if (db.prepare('SELECT 1 FROM processed_logs WHERE tx_hash = ? AND log_index = ?').get(log.transactionHash, log.index)) return false;
    let ev = null;
    try { ev = ifaces[kind].parseLog({ topics: [...log.topics], data: log.data }); } catch { /* not one of ours */ }
    db.prepare('INSERT INTO processed_logs (tx_hash, log_index) VALUES (?,?)').run(log.transactionHash, log.index);
    if (!ev) return false;
    const A = ev.args, asset = lc(log.address), time = await tsOf(log.blockNumber);

    switch (`${kind}:${ev.name}`) {
      case 'factory:AssetCreated': {
        Asset.upsert({ address: lc(A.asset), issuer: lc(A.issuer), name: A.name, symbol: A.symbol, asset_class: Number(A.assetClass), total_shares: A.totalShares, min_tier: Number(A.minTier),
          document_hash: lc(A.documentHash), created_block: log.blockNumber, created_tx: log.transactionHash });
        AuditLog.append('chain', 'asset.created', 'assets', lc(A.asset));
        break;
      }
      case 'token:Transfer': {
        if (lc(A.from) !== ZERO) Holding.adjust(asset, lc(A.from), -A.value);
        if (lc(A.to) !== ZERO) Holding.adjust(asset, lc(A.to), A.value);
        break;
      }
      case 'token:DocumentUpdated': {
        Asset.updateDocumentHash(asset, lc(A.documentHash));
        AuditLog.append('chain', 'asset.document_updated', 'assets', asset);
        break;
      }
      case 'token:YieldDeposited': {
        YieldEvent.insert({ tx_hash: log.transactionHash, log_index: log.index, asset, kind: 'deposit', amount: A.amount, ref: A.ref, block_time: time });
        AuditLog.append('chain', 'yield.deposited', 'assets', asset);
        break;
      }
      case 'token:YieldClaimed': {
        YieldEvent.insert({ tx_hash: log.transactionHash, log_index: log.index, asset, kind: 'claim', holder: lc(A.holder), amount: A.amount, block_time: time });
        break;
      }
      case 'market:Listed': {
        Listing.upsert({ id: Number(A.id), asset: lc(A.asset), seller: lc(A.seller), remaining: A.amount, price_per_share: A.pricePerShare, created_tx: log.transactionHash, created_at: time });
        AuditLog.append('chain', 'market.listed', 'listings', Number(A.id));
        break;
      }
      case 'market:Sold': {
        const row = { tx_hash: log.transactionHash, log_index: log.index, listing_id: Number(A.id), asset: lc(A.asset), buyer: lc(A.buyer), seller: lc(A.seller), amount: A.amount, price_per_share: A.pricePerShare, fee: A.fee, block_time: time };
        const id = Trade.insert(row);
        Listing.reduce(Number(A.id), A.amount);
        if (id) {
          AuditLog.append('chain', 'market.sold', 'trades', id);
          AmlService.evaluateTrade({ ...row, id }, Asset.find(row.asset)?.issuer ?? null);
        }
        break;
      }
      case 'market:Cancelled': {
        Listing.deactivate(Number(A.id));
        AuditLog.append('chain', 'market.cancelled', 'listings', Number(A.id));
        break;
      }
      case 'registry:Registered': {
        const d = KycDecision.findByDecisionId(lc(A.decisionId));
        if (d) {
          if (!d.registered_tx) KycDecision.markRegistered(d.id, log.transactionHash);
          AuditLog.append('chain', 'compliance.registered', 'kyc_decisions', d.id);
        } else AuditLog.append('chain', 'compliance.registered', 'wallets', lc(A.wallet));
        break;
      }
      case 'registry:Frozen': {
        for (const al of AmlAlert.list('open').filter((x) => x.wallet === lc(A.wallet))) AmlAlert.resolve(al.id, 'frozen', log.transactionHash);
        AuditLog.append('chain', 'aml.frozen', 'wallets', lc(A.wallet));
        break;
      }
      case 'registry:Unfrozen': AuditLog.append('chain', 'aml.unfrozen', 'wallets', lc(A.wallet)); break;
      case 'registry:Revoked': AuditLog.append('chain', 'compliance.revoked', 'wallets', lc(A.wallet)); break;
      default: break;
    }
    return true;
  },
};
