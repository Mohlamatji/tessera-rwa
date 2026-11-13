import buildConfig from '../../config/app.js';
import buildSecurity from '../../config/security.js';

let cache = null;
let sec = null;

/** Tiny dot-path accessor over config/app.js: Config.get('kyc.approve_threshold'). */
export const Config = {
  all() { return (cache ??= buildConfig()); },
  get(path, def = null) {
    let node = this.all();
    for (const seg of path.split('.')) {
      if (node === null || typeof node !== 'object' || !(seg in node)) return def;
      node = node[seg];
    }
    return node;
  },
  security() { return (sec ??= buildSecurity()); },
  isProduction() { return Boolean(this.get('is_production', false)); },
  /** Test helper - forces config to be re-read after process.env changes. */
  reset() { cache = null; sec = null; },
};
