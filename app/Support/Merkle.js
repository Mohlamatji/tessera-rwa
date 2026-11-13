import { ethers } from 'ethers';

/**
 * Merkle tree compatible with OpenZeppelin MerkleProof.verify (sorted-pair keccak256).
 * Leaves are 32-byte hex strings (here: audit entries' SHA-256 hashes). An odd node at a level is
 * carried up unchanged. Deterministic, so a proof can be rebuilt later from the database - and a
 * tampered database yields a root that no longer matches the one anchored on-chain.
 */
const norm = (h) => {
  const x = String(h).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(x)) throw new Error('Merkle leaves must be 32-byte hex strings.');
  return x;
};
const pair = (a, b) => {
  const [lo, hi] = a <= b ? [a, b] : [b, a]; // lowercase hex compares like bytes
  return ethers.keccak256('0x' + lo + hi).slice(2);
};

export const Merkle = {
  /** @returns {{root:string, layers:string[][]}} root is 0x-prefixed hex */
  build(leaves) {
    if (!leaves.length) throw new Error('Cannot build a Merkle tree with no leaves.');
    let layer = leaves.map(norm);
    const layers = [layer];
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? pair(layer[i], layer[i + 1]) : layer[i]);
      layers.push(layer = next);
    }
    return { root: '0x' + layer[0], layers };
  },

  /** @returns {string[]} sibling hashes (0x hex) from leaf to root */
  proof(layers, index) {
    const proof = [];
    for (let level = 0; level < layers.length - 1; level++) {
      const sib = index ^ 1;
      if (layers[level][sib] !== undefined) proof.push('0x' + layers[level][sib]);
      index >>= 1;
    }
    return proof;
  },

  verify(proof, root, leaf) {
    let h = norm(leaf);
    for (const s of proof) h = pair(h, norm(s));
    return h === norm(root);
  },
};
