import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'Views');
const cache = new Map();
const load = (n) => { if (!cache.has(n)) cache.set(n, fs.readFileSync(path.join(dir, `${n}.html`), 'utf8')); return cache.get(n); };

/** Minimal templating: {{head}} / {{header:active}} partials and {{var}} substitution (HTML-escaped). */
export const View = {
  render(name, vars = {}) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return load(name)
      .replace(/\{\{head\}\}/g, () => load('_head'))
      .replace(/\{\{header:(\w*)\}\}/g, (_m, active) => load('_header').replace(new RegExp(`data-nav="${active}"`), `data-nav="${active}" aria-current="page"`))
      .replace(/\{\{(\w+)\}\}/g, (_m, k) => esc(vars[k]));
  },
};
