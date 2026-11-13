// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title AuditAnchor
 * @notice Immutable, public timestamps for Tessera's compliance audit log.
 *
 * The off-chain audit log (KYC decisions, registrations, trades, yield, AML actions) is already
 * hash-chained, which proves tampering to anyone who trusts the operator's copy. Anchoring a Merkle
 * root of each batch on-chain removes that trust: even an operator who rewrites history AND
 * recomputes every hash cannot make the rewritten log match a root published earlier. Only roots are
 * stored - never log contents or personal data.
 *
 * Leaves are the audit entries' own SHA-256 hashes; interior nodes use sorted-pair keccak256
 * (OpenZeppelin's MerkleProof convention), so anyone can verify a leaf against an anchored root,
 * on-chain via `verify` or off-chain in a browser.
 */
contract AuditAnchor is Ownable {
    struct Anchor {
        uint64 timestamp;
        uint64 fromId;
        uint64 toId;
        uint32 count;
    }

    mapping(bytes32 => Anchor) public anchors;
    mapping(address => bool) public anchorers;

    event Anchored(bytes32 indexed root, uint64 fromId, uint64 toId, uint32 count, address indexed by);
    event AnchorerSet(address indexed account, bool allowed);

    error NotAnchorer();
    error EmptyRoot();
    error AlreadyAnchored();
    error BadRange();

    constructor(address owner_) Ownable(owner_) {
        anchorers[owner_] = true;
        emit AnchorerSet(owner_, true);
    }

    function setAnchorer(address account, bool allowed) external onlyOwner {
        anchorers[account] = allowed;
        emit AnchorerSet(account, allowed);
    }

    function anchor(bytes32 root, uint64 fromId, uint64 toId, uint32 count) external {
        if (!anchorers[msg.sender]) revert NotAnchorer();
        if (root == bytes32(0)) revert EmptyRoot();
        if (anchors[root].timestamp != 0) revert AlreadyAnchored();
        if (toId < fromId || count == 0) revert BadRange();
        anchors[root] = Anchor(uint64(block.timestamp), fromId, toId, count);
        emit Anchored(root, fromId, toId, count, msg.sender);
    }

    /// @return anchored whether `root` was anchored; timestamp when; ok whether `leaf` is in it.
    function verify(bytes32 root, bytes32 leaf, bytes32[] calldata proof) external view returns (bool anchored, uint64 timestamp, bool ok) {
        timestamp = anchors[root].timestamp;
        anchored = timestamp != 0;
        ok = anchored && MerkleProof.verify(proof, root, leaf);
    }
}
