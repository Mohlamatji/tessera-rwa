import { ethers } from 'ethers';

/** Thin, well-tested wrappers over ethers v6 so controllers/services never hand-roll crypto. */
export const Eth = {
  isAddress: (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && ethers.isAddress(a),
  /** Lower-case canonical form used as the DB key. Throws on anything that isn't an address. */
  norm(a) {
    if (!Eth.isAddress(a)) throw new Error('Invalid wallet address.');
    return a.toLowerCase();
  },
  checksum: (a) => ethers.getAddress(a),
  isBytes32: (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h),
  isTxHash: (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h),
  keccak: (hexOrBytes) => ethers.keccak256(hexOrBytes),
  id: (text) => ethers.id(text),

  /** Recover the signer of an EIP-191 personal_sign message; null if the signature is malformed. */
  recoverMessage(message, signature) {
    try { return ethers.verifyMessage(message, signature).toLowerCase(); } catch { return null; }
  },

  /** EIP-712 types/domain for the ComplianceRegistry claim - must match ComplianceRegistry.sol exactly. */
  CLAIM_TYPES: { KycClaim: [
    { name: 'decisionId', type: 'bytes32' }, { name: 'wallet', type: 'address' },
    { name: 'tier', type: 'uint8' }, { name: 'expiry', type: 'uint64' },
  ] },
  claimDomain: (chainId, verifyingContract) => ({ name: 'TesseraCompliance', version: '1', chainId, verifyingContract }),

  async signClaim(attestorKey, chainId, registryAddress, claim) {
    const wallet = new ethers.Wallet(attestorKey);
    return wallet.signTypedData(Eth.claimDomain(chainId, registryAddress), Eth.CLAIM_TYPES, claim);
  },
  /** EIP-712 types/domain for BackingOracle custodian attestations - must match BackingOracle.sol exactly. */
  ATTESTATION_TYPES: { Attestation: [
    { name: 'asset', type: 'address' }, { name: 'backedShares', type: 'uint256' }, { name: 'asOf', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' }, { name: 'evidenceHash', type: 'bytes32' }, { name: 'nonce', type: 'uint64' },
  ] },
  backingDomain: (chainId, verifyingContract) => ({ name: 'TesseraBacking', version: '1', chainId, verifyingContract }),
  signAttestation(custodianKey, chainId, oracleAddress, att) {
    return new ethers.Wallet(custodianKey).signTypedData(Eth.backingDomain(chainId, oracleAddress), Eth.ATTESTATION_TYPES, att);
  },
  attestorAddress: (key) => new ethers.Wallet(key).address,
  newDecisionId: () => ethers.hexlify(ethers.randomBytes(32)),
};
