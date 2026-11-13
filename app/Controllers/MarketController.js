import { Eth } from '../Support/Eth.js';
import { MarketService } from '../Services/MarketService.js';
import { IndexerService } from '../Services/IndexerService.js';
import { ChainService } from '../Services/ChainService.js';
import { Config } from '../Support/Config.js';

/** Public market data (read model) + the signed-in investor's portfolio. */
export class MarketController {
  async assets() {
    await IndexerService.syncIfStale();
    const assets = await Promise.all(MarketService.assets().map(async (a) => ({ ...a, backing_state: (await ChainService.backingStatus(a.address)).state })));
    return [200, { chain: ChainService.status(), assets, stats: MarketService.stats() }];
  }

  async asset({ match }) {
    await IndexerService.syncIfStale();
    if (!Eth.isAddress(match[1])) return [422, { status: 'error', message: 'Invalid asset address.' }];
    const d = MarketService.detail(match[1]);
    return d ? [200, { ...d, backing: await ChainService.backingStatus(d.address) }] : [404, { status: 'error', message: 'Unknown asset.' }];
  }

  async portfolio({ auth }) {
    await IndexerService.syncIfStale(0);
    return [200, await MarketService.portfolio(auth.wallet)];
  }

  /** Forces an index run - lets a browser show a just-mined trade immediately. */
  async sync() { const r = await IndexerService.sync(); return [200, { status: 'ok', ...r }]; }

  /** Dev/demo helper: the faucet token lives on-chain; this only tells the UI whether it's a mock. */
  faucetInfo() { return [200, { mock: Config.get('chain.token_symbol') === 'mZAR' }]; }
}
