// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title ComplianceRegistry
 * @notice The on-chain KYC/AML gate. A wallet becomes an eligible investor only by submitting a
 *         fresh EIP-712 claim signed by the Tessera attestor AFTER the off-chain service has
 *         verified the person (identity, sanctions/PEP screening, investor category).
 *
 * PRIVACY: the chain stores only { tier, expiry, decisionId } per wallet. decisionId is an opaque
 * hash. Names, ID numbers, dates of birth and countries never touch the chain; the wallet<->person
 * link lives in the off-chain database and is erasable on request.
 *
 * TIERS: 1 = retail (verified), 2 = accredited / qualified investor.
 *
 * SAFETY PROPERTIES (covered by tests):
 *  - Bound: the signature commits to wallet, tier, expiry and decisionId.
 *  - Wallet-only: only the attested wallet can submit its claim, so a leaked claim is useless.
 *  - Single-use: each decisionId registers once.
 *  - Short-lived: claims expire; eligibility lapses at `expiry` (re-verification required).
 *  - AML controls: attestor or owner can freeze a wallet at once (shares can't move in or out,
 *    yield can't be claimed); only the owner can unfreeze. Records can be revoked.
 *  - Rotatable attestor, pausable registration.
 */
contract ComplianceRegistry is EIP712, Ownable, Pausable {
    struct Claim {
        bytes32 decisionId;
        address wallet;
        uint8 tier;
        uint64 expiry;
    }

    struct Record {
        uint8 tier;
        uint64 expiry;
        bytes32 decisionId;
    }

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("KycClaim(bytes32 decisionId,address wallet,uint8 tier,uint64 expiry)");

    address public attestor;
    mapping(address => Record) public records;
    mapping(address => bool) public frozen;
    mapping(bytes32 => bool) public used;

    event Registered(address indexed wallet, uint8 tier, uint64 expiry, bytes32 indexed decisionId);
    event Revoked(address indexed wallet, address indexed by);
    event Frozen(address indexed wallet, address indexed by);
    event Unfrozen(address indexed wallet, address indexed by);
    event AttestorChanged(address indexed previousAttestor, address indexed newAttestor);

    error ZeroAddress();
    error NotWallet();
    error Expired();
    error BadTier();
    error AlreadyUsed();
    error BadSignature();
    error NotAuthorised();

    constructor(address attestor_, address owner_) EIP712("TesseraCompliance", "1") Ownable(owner_) {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        emit AttestorChanged(address(0), attestor_);
    }

    /// @notice Register (or upgrade/renew) the caller's KYC status with a signed claim.
    function register(Claim calldata c, bytes calldata signature) external whenNotPaused {
        if (msg.sender != c.wallet) revert NotWallet();
        if (block.timestamp > c.expiry) revert Expired();
        if (c.tier == 0 || c.tier > 2) revert BadTier();
        if (used[c.decisionId]) revert AlreadyUsed();
        if (ECDSA.recover(_hashTypedDataV4(_structHash(c)), signature) != attestor) revert BadSignature();

        used[c.decisionId] = true;
        records[c.wallet] = Record(c.tier, c.expiry, c.decisionId);
        emit Registered(c.wallet, c.tier, c.expiry, c.decisionId);
    }

    /// @return the wallet's effective tier right now: 0 if unknown, expired, revoked or frozen.
    function tierOf(address wallet) public view returns (uint8) {
        Record storage r = records[wallet];
        if (frozen[wallet] || r.tier == 0 || block.timestamp > r.expiry) return 0;
        return r.tier;
    }

    function isEligible(address wallet, uint8 minTier) external view returns (bool) {
        uint8 t = tierOf(wallet);
        return t != 0 && t >= minTier;
    }

    function isFrozen(address wallet) external view returns (bool) {
        return frozen[wallet];
    }

    /// @notice EIP-712 digest an attestor signs for `c` (exposed so off-chain code can cross-check).
    function digest(Claim calldata c) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(c));
    }

    // ---- AML / operations ----

    function freeze(address wallet) external {
        if (msg.sender != attestor && msg.sender != owner()) revert NotAuthorised();
        frozen[wallet] = true;
        emit Frozen(wallet, msg.sender);
    }

    function unfreeze(address wallet) external onlyOwner {
        frozen[wallet] = false;
        emit Unfrozen(wallet, msg.sender);
    }

    function revoke(address wallet) external {
        if (msg.sender != attestor && msg.sender != owner()) revert NotAuthorised();
        delete records[wallet];
        emit Revoked(wallet, msg.sender);
    }

    function setAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        emit AttestorChanged(attestor, newAttestor);
        attestor = newAttestor;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function _structHash(Claim calldata c) private pure returns (bytes32) {
        return keccak256(abi.encode(CLAIM_TYPEHASH, c.decisionId, c.wallet, c.tier, c.expiry));
    }
}
