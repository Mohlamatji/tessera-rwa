// Compiles contracts/*.sol with solc-js (no network needed) into artifacts/<Name>.json {abi, bytecode}.
import solc from 'solc';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = {};
for (const f of fs.readdirSync(path.join(root, 'contracts'))) {
  if (f.endsWith('.sol')) sources[`contracts/${f}`] = { content: fs.readFileSync(path.join(root, 'contracts', f), 'utf8') };
}
const input = {
  language: 'Solidity', sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const findImport = (p) => {
  const file = path.join(root, 'node_modules', p);
  return fs.existsSync(file) ? { contents: fs.readFileSync(file, 'utf8') } : { error: 'not found: ' + p };
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) if (e.severity !== 'error') console.warn(e.formattedMessage.split('\n')[0]);
if (errors.length) { for (const e of errors) console.error(e.formattedMessage); process.exit(1); }

fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
for (const file of Object.keys(out.contracts)) {
  for (const [name, c] of Object.entries(out.contracts[file])) {
    if (!file.startsWith('contracts/')) continue;
    const size = c.evm.bytecode.object.length / 2;
    if (size > 24576) console.warn(`WARNING: ${name} runtime+init code is ${size} bytes (EIP-170 limit applies to deployed runtime code)`);
    fs.writeFileSync(path.join(root, 'artifacts', `${name}.json`), JSON.stringify({ contractName: name, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1));
    console.log('compiled', name, `(${size} bytes)`);
  }
}
