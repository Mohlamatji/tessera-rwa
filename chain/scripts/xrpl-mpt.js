// Second rail: issue a Tessera asset as an XRP Ledger Multi-Purpose Token (MPT) - no smart contract needed.
//
//   node chain/scripts/xrpl-mpt.js                 DRY RUN (default): prints the transaction + decoded metadata, no network
//   node chain/scripts/xrpl-mpt.js --submit        funds a throw-away TESTNET issuer from the faucet and submits it
//   XRPL_WS=wss://...  to pick the network (default: Devnet, as in the XRPL "Issue a Multi-Purpose Token" tutorial)
//   --asset=1          index into SAMPLE_ASSETS (0 = Sandton Office Tower, 1 = Karoo Solar Farm, 2 = SME note)
//
// Mapping of Tessera's controls onto MPT flags (XRPL docs: MPTokenIssuanceCreate):
//   identity gate   -> tfMPTRequireAuth   (issuer must authorise each holder - only verified wallets can hold)
//   freeze          -> tfMPTCanLock       (issuer can lock one holder's balance or the whole issuance)
//   recover         -> tfMPTCanClawback   (issuer can claw back, e.g. court order / lost keys)
//   transfers       -> tfMPTCanTransfer
// Fixed for life: AssetScale and MaximumAmount (and anything in ImmutableFlags). Review before submitting.
// Never use a wallet that holds real money. Testnet/Devnet only.
import { MPTokenIssuanceCreateFlags as F, encodeMPTokenMetadata, decodeMPTokenMetadata, validate } from 'xrpl';
import { fileURLToPath } from 'node:url';
import { SAMPLE_ASSETS } from './seed.js';
import { ethers } from 'ethers';

const CLASS = ['real_estate', 'private_credit', 'green_energy', 'collectible', 'other'];
export { F as Flags, decodeMPTokenMetadata };
export const METADATA_MAX_BYTES = 1024; // MPTokenMetadata limit

/** Tessera asset spec -> XLS-89 metadata (long names; the SDK compacts them). Throws if it would not be valid/compatible. */
export function buildAssetMetadata(a, { documentHash = null, uris = [], icon = null } = {}) {
  const ticker = String(a.symbol ?? '').toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(ticker)) throw new Error(`MPT ticker must be 1-6 characters A-Z/0-9 (got "${a.symbol}").`);
  if (!a.name) throw new Error('MPT metadata needs a name.');
  const info = {
    location: a.location, legal_structure: a.legal_structure, payout_frequency: a.payout_frequency ?? 'monthly',
    target_yield: a.target_yield_bps ? `${(a.target_yield_bps / 100).toFixed(2)}%` : undefined,
    valuation_zar: a.valuation_cents ? String(Math.round(a.valuation_cents / 100)) : undefined,
    document_hash: documentHash ?? undefined, // keccak256 of the dossier: same commitment the EVM token makes
    min_investor_tier: a.min_tier === 2 ? 'accredited' : 'retail',
  };
  for (const k of Object.keys(info)) if (info[k] === undefined) delete info[k];
  const meta = { ticker, name: a.name, desc: a.description, icon: icon ?? `https://example.org/tessera/${ticker.toLowerCase()}.png`, // PLACEHOLDER (as in the XRPL tutorial): host a real icon before launch
    asset_class: 'rwa', asset_subclass: CLASS[a.asset_class] ?? 'other', issuer_name: a.issuer_name, additional_info: info };
  if (uris.length) meta.uris = uris;
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
  const hex = encodeMPTokenMetadata(meta);
  if (hex.length / 2 > METADATA_MAX_BYTES) throw new Error(`Encoded metadata is ${hex.length / 2} bytes; the limit is ${METADATA_MAX_BYTES}. Shorten the description or fields.`);
  return { meta, hex };
}

/** The MPTokenIssuanceCreate transaction for an asset. One MPT unit = one share (AssetScale 0), supply capped at totalShares. */
export function buildIssuanceTx(issuerAddress, a, opts = {}) {
  if (!Number.isInteger(a.total_shares) || a.total_shares < 1) throw new Error('total_shares must be a positive integer.');
  const { hex } = buildAssetMetadata(a, { documentHash: opts.documentHash ?? ethers.id(JSON.stringify([a.name, a.symbol, a.location, a.legal_structure])), uris: opts.uris, icon: opts.icon });
  const tx = {
    TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress,
    AssetScale: 0, MaximumAmount: String(a.total_shares), TransferFee: 0,
    Flags: F.tfMPTCanTransfer | F.tfMPTCanLock | F.tfMPTRequireAuth | (opts.clawback === false ? 0 : F.tfMPTCanClawback),
    MPTokenMetadata: hex,
  };
  validate(tx);
  return tx;
}

async function main() {
  const idx = Number((process.argv.find((x) => x.startsWith('--asset=')) ?? '--asset=0').split('=')[1]);
  const spec = SAMPLE_ASSETS[idx]; if (!spec) throw new Error('Unknown --asset index.');
  const submit = process.argv.includes('--submit');
  const placeholder = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'; // dry-run only, never submitted
  if (!submit) {
    const tx = buildIssuanceTx(placeholder, spec);
    console.log('DRY RUN - nothing is sent. Pass --submit to issue on a test network.\n');
    console.log(JSON.stringify({ ...tx, MPTokenMetadata: tx.MPTokenMetadata.slice(0, 40) + `… (${tx.MPTokenMetadata.length / 2} bytes)` }, null, 2));
    console.log('\nDecoded metadata:\n', decodeMPTokenMetadata(tx.MPTokenMetadata));
    return;
  }
  const { Client } = await import('xrpl');
  const url = process.env.XRPL_WS || 'wss://s.devnet.rippletest.net:51233';
  const client = new Client(url); await client.connect();
  try {
    console.log('Funding a new TEST issuer from the faucet on', url);
    const { wallet: issuer } = await client.fundWallet(); // the issuance object reserves 0.2 XRP
    const tx = buildIssuanceTx(issuer.address, spec);
    const res = await client.submitAndWait(tx, { wallet: issuer, autofill: true });
    if (res.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Transaction failed: ' + res.result.meta.TransactionResult);
    const id = res.result.meta.mpt_issuance_id;
    const entry = await client.request({ command: 'ledger_entry', mpt_issuance: id, ledger_index: 'validated' });
    console.log('MPT issued:', id, '\nIssuer:', issuer.address, '\nDecoded:', decodeMPTokenMetadata(entry.result.node.MPTokenMetadata));
  } finally { await client.disconnect(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
