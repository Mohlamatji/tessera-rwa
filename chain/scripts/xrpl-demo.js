// End-to-end demo of Tessera on the XRP Ledger (TESTNET by default): issue an asset as an MPT, gate holders, freeze, recover, halt.
//
//   node chain/scripts/xrpl-demo.js                 # XRPL Testnet (the track brief allows any public testnet)
//   XRPL_WS=wss://s.devnet.rippletest.net:51233 node chain/scripts/xrpl-demo.js
//   node chain/scripts/xrpl-demo.js --asset=1       # which SAMPLE_ASSETS entry
//
// Uses brand-new throw-away wallets funded from the faucet - never a wallet that holds real money. Needs internet access.
// Each failure case prints the result code the ledger actually returned; "rejected" means the ledger refused it.
import { Client, decodeMPTokenMetadata } from 'xrpl';
import { SAMPLE_ASSETS } from './seed.js';
import { buildIssuanceTx } from './xrpl-mpt.js';
import { XrplRail, mptokenState } from './xrpl-rail.js';

const url = process.env.XRPL_WS || 'wss://s.altnet.rippletest.net:51233';
const spec = SAMPLE_ASSETS[Number((process.argv.find((a) => a.startsWith('--asset=')) ?? '--asset=0').split('=')[1])];
const client = new Client(url);
const say = (m = '') => console.log(m);

/** Submit and report. expectFail=true means the LEDGER is supposed to refuse it. Returns the transaction result code. */
async function run(label, tx, wallet, { expectFail = false } = {}) {
  let code, msg = '';
  try { code = (await client.submitAndWait(tx, { wallet, autofill: true })).result.meta.TransactionResult; }
  catch (e) { code = 'error'; msg = ' ' + (e.data?.error_message || e.message || '').slice(0, 100); }
  const passed = expectFail ? code !== 'tesSUCCESS' : code === 'tesSUCCESS';
  say(`  ${passed ? '✔' : '✘'} ${label}  →  ${code}${msg}${expectFail ? (passed ? '   (rejected by the ledger, as intended)' : '   (UNEXPECTEDLY ACCEPTED)') : ''}`);
  if (!passed) process.exitCode = 1;
  return code;
}
async function state(id, holder) {
  try { return mptokenState((await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: id, account: holder.address }, ledger_index: 'validated' })).result.node); }
  catch { return { balance: '0 (no entry)', locked: false, authorized: false }; }
}
const show = async (id, name, w) => { const s = await state(id, w); say(`     ${name}: ${s.balance} shares${s.authorized ? ', authorised' : ''}${s.locked ? ', LOCKED' : ''}`); };

try {
  await client.connect();
  say(`Tessera on the XRP Ledger - ${url}\nAsset: ${spec.name} (${spec.symbol}), ${spec.total_shares} shares\n`);
  say('Creating and funding throw-away test wallets from the faucet…');
  const wallets = [];
  for (let i = 0; i < 4; i++) wallets.push((await client.fundWallet()).wallet); // one at a time: the faucet rate-limits bursts
  const [issuer, alice, mallory, aliceNew] = wallets;
  say(`  issuer ${issuer.address}\n  alice (verified investor) ${alice.address}\n  mallory (never verified) ${mallory.address}\n  alice's replacement wallet ${aliceNew.address}\n`);

  say('1. Issue the asset as an MPT (authorised holders only, lockable, clawback for recovery)');
  const issuance = buildIssuanceTx(issuer.address, spec);
  const res = await client.submitAndWait(issuance, { wallet: issuer, autofill: true });
  if (res.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Issuance failed: ' + res.result.meta.TransactionResult);
  const id = res.result.meta.mpt_issuance_id;
  say(`  ✔ issued  →  MPT issuance id ${id}\n     metadata: ${decodeMPTokenMetadata(issuance.MPTokenMetadata).name}, document hash ${decodeMPTokenMetadata(issuance.MPTokenMetadata).additional_info.document_hash}\n`);

  say('2. Identity gate: Alice passed KYC, Mallory did not');
  await run('Alice opts in to hold the asset', XrplRail.optIn(alice.address, id), alice);
  await run('Mallory opts in too (anyone can ask)', XrplRail.optIn(mallory.address, id), mallory);
  await run('Tessera authorises Alice (KYC approved)', XrplRail.authorize(issuer.address, id, alice.address), issuer);
  await run('sell 100 shares to Alice', XrplRail.send(issuer.address, id, alice.address, 100), issuer);
  await run('sell 100 shares to Mallory (not authorised)', XrplRail.send(issuer.address, id, mallory.address, 100), issuer, { expectFail: true });
  await show(id, 'Alice', alice); await show(id, 'Mallory', mallory);

  say('\n3. Freeze: Alice is frozen, then cannot move her shares');
  await run('freeze Alice', XrplRail.lockHolder(issuer.address, id, alice.address), issuer);
  await run('Alice sends 10 shares onward while frozen', XrplRail.send(alice.address, id, issuer.address, 10), alice, { expectFail: true });

  say('\n4. Recover: Alice lost her keys - claw back and re-issue to her new, verified wallet');
  await run('Alice\'s new wallet opts in', XrplRail.optIn(aliceNew.address, id), aliceNew);
  await run('Tessera authorises the new wallet (re-verified)', XrplRail.authorize(issuer.address, id, aliceNew.address), issuer);
  await run('claw back 100 shares from the old wallet', XrplRail.clawback(issuer.address, id, alice.address, 100), issuer);
  await run('send 100 shares to the new wallet', XrplRail.send(issuer.address, id, aliceNew.address, 100), issuer);
  await show(id, 'Alice (old)', alice); await show(id, 'Alice (new)', aliceNew);

  say('\n5. Halt: the custodian reports a reserve shortfall - lock the whole issuance, then restore');
  await run('lock the whole issuance', XrplRail.lockAll(issuer.address, id), issuer);
  await run('sell 5 shares while halted', XrplRail.send(issuer.address, id, aliceNew.address, 5), issuer, { expectFail: true });
  await run('unlock after full backing is re-attested', XrplRail.unlockAll(issuer.address, id), issuer);
  await run('sell 5 shares after restore', XrplRail.send(issuer.address, id, aliceNew.address, 5), issuer);

  say(`\nExplorer: ${url.includes('devnet') ? 'https://devnet.xrpl.org' : 'https://testnet.xrpl.org'}/mpt/${id}`);
  say(process.exitCode ? '\nSome steps did not behave as expected - see ✘ above.' : '\nAll steps behaved as expected.');
} catch (e) { console.error('\nFailed:', e.message); process.exitCode = 1; }
finally { await client.disconnect().catch(() => {}); }
