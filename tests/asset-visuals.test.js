// The asset pages must always show *something* for an asset picture, never a broken image, and must say when the
// picture is an illustration rather than a photo. Real photos can be dropped into public/img/assets/<symbol>.jpg.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(root, 'public', 'js', 'tessera.js'), 'utf8');
const win = { ethereum: undefined };
vm.runInContext(code, vm.createContext({ window: win, ethers, document: { addEventListener() {}, getElementById: () => null }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, console, Date, JSON, Number, BigInt, String, Set, Math, Object, Error, Promise, location: {} }));
const T = win.Tessera;

test('assetImage lists real-photo formats first and ends on the bundled default', () => {
  const html = T.assetImage({ name: 'Sandton Office Tower', symbol: 'SNDT', image_hue: 200 });
  const srcs = /data-srcs="([^"]+)"/.exec(html)[1].split(',');
  assert.deepEqual(srcs, ['/img/assets/sndt.jpg', '/img/assets/sndt.webp', '/img/assets/sndt.png', '/img/assets/sndt.svg', '/img/assets/default.svg']);
  assert.match(html, /Illustrative image/);
});

test('assetImage escapes hostile asset names and symbols', () => {
  const html = T.assetImage({ name: '"><script>x</script>', symbol: '../../etc/passwd', image_hue: 1 });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /\.\.\//);
});

test('bundled illustrations exist for every sample asset and the default', () => {
  for (const f of ['sndt', 'ksol', 'smen', 'default']) assert.ok(fs.existsSync(path.join(root, 'public', 'img', 'assets', f + '.svg')), f);
});

test('the static file server knows photo MIME types', () => {
  const src = fs.readFileSync(path.join(root, 'public', 'index.js'), 'utf8');
  for (const t of ['.jpg', '.jpeg', '.webp', '.png', '.svg']) assert.ok(src.includes(`'${t}'`), t);
});
