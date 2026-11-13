// Offline checks for the XRPL MPT rail (no network): metadata is XLS-89-shaped, fits the 1024-byte limit, flags mirror Tessera's controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Flags as F, decodeMPTokenMetadata, buildAssetMetadata, buildIssuanceTx, METADATA_MAX_BYTES } from '../chain/scripts/xrpl-mpt.js';
import { SAMPLE_ASSETS } from '../chain/scripts/seed.js';

const ISSUER = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';

test('every sample asset becomes a valid MPT issuance within the metadata limit', () => {
  for (const a of SAMPLE_ASSETS) {
    const tx = buildIssuanceTx(ISSUER, a);
    assert.ok(tx.MPTokenMetadata.length / 2 <= METADATA_MAX_BYTES, a.symbol);
    assert.equal(tx.MaximumAmount, String(a.total_shares));
    assert.equal(tx.AssetScale, 0);
    const m = decodeMPTokenMetadata(tx.MPTokenMetadata);
    assert.equal(m.ticker, a.symbol); assert.equal(m.asset_class, 'rwa'); assert.equal(m.name, a.name);
    assert.match(m.additional_info.document_hash, /^0x[0-9a-f]{64}$/);
  }
});

test('flags mirror Tessera\'s controls: authorised holders only, lockable, transferable, clawback for recovery', () => {
  const f = buildIssuanceTx(ISSUER, SAMPLE_ASSETS[0]).Flags;
  for (const flag of [F.tfMPTRequireAuth, F.tfMPTCanLock, F.tfMPTCanTransfer, F.tfMPTCanClawback]) assert.ok(f & flag);
  assert.equal(buildIssuanceTx(ISSUER, SAMPLE_ASSETS[0], { clawback: false }).Flags & F.tfMPTCanClawback, 0);
});

test('bad input is refused before anything could be submitted', () => {
  assert.throws(() => buildAssetMetadata({ ...SAMPLE_ASSETS[0], symbol: 'toolong1' }), /ticker/);
  assert.throws(() => buildAssetMetadata({ ...SAMPLE_ASSETS[0], symbol: 'bad-1' }), /ticker/);
  assert.throws(() => buildIssuanceTx(ISSUER, { ...SAMPLE_ASSETS[0], total_shares: 0 }), /total_shares/);
  assert.throws(() => buildAssetMetadata({ ...SAMPLE_ASSETS[0], description: 'x'.repeat(2000) }), /limit/);
});
