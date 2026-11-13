// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BackingOracle
 * @notice On-chain evidence that a tokenised asset is really there. The asset's CUSTODIAN (a bank, registry, warehouse
 *         or auditor) signs an EIP-712 attestation: "as of time T, I hold enough of asset X to back N shares, and here is
 *         the hash of my evidence (statement, deed, receipt)". Anyone may relay it; the contract checks the signature.
 *
 *         The marketplace asks `isShortfall(asset)` before every purchase: if the latest attestation covers fewer
 *         shares than exist, buying is halted until the custodian attests full backing again (proof-of-reserve pattern).
 *
 *         HACKATHON SCOPE: the custodian is a mock key held by the demo server. In production it is a regulated
 *         custodian / auditor, or a Chainlink Proof-of-Reserve feed wired in behind the same `isShortfall` interface.
 */
contract BackingOracle is EIP712, Ownable {
    struct Attestation {
        address asset;
        uint256 backedShares; // how many shares the custodian says are fully backed
        uint64 asOf;          // when the custodian looked
        uint64 validUntil;    // after this the attestation is stale (UI warns; trading is not halted by staleness alone)
        bytes32 evidenceHash; // keccak256 of the custodian statement / deed / receipt (file kept on IPFS or with the custodian)
        uint64 nonce;         // strictly increasing per asset: an old, rosier attestation can never be replayed
    }

    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(address asset,uint256 backedShares,uint64 asOf,uint64 validUntil,bytes32 evidenceHash,uint64 nonce)");

    address public custodian;
    mapping(address => Attestation) public latest;

    event Attested(address indexed asset, uint256 backedShares, uint256 supply, uint64 asOf, uint64 validUntil, bytes32 indexed evidenceHash, uint64 nonce, bool shortfall);
    event CustodianChanged(address indexed previousCustodian, address indexed newCustodian);

    error ZeroAddress();
    error BadSignature();
    error StaleNonce();
    error FromTheFuture();
    error AlreadyExpired();

    constructor(address custodian_, address owner_) EIP712("TesseraBacking", "1") Ownable(owner_) {
        if (custodian_ == address(0)) revert ZeroAddress();
        custodian = custodian_;
        emit CustodianChanged(address(0), custodian_);
    }

    /// @notice Publish a custodian-signed attestation. Anyone can relay it; only the custodian's signature matters.
    function submit(Attestation calldata a, bytes calldata signature) external {
        if (a.nonce <= latest[a.asset].nonce) revert StaleNonce();
        if (a.asOf > block.timestamp + 5 minutes) revert FromTheFuture();
        if (a.validUntil < block.timestamp) revert AlreadyExpired();
        if (ECDSA.recover(_hashTypedDataV4(_structHash(a)), signature) != custodian) revert BadSignature();
        latest[a.asset] = a;
        uint256 supply = IERC20(a.asset).totalSupply();
        emit Attested(a.asset, a.backedShares, supply, a.asOf, a.validUntil, a.evidenceHash, a.nonce, a.backedShares < supply);
    }

    /// @return state 0 = unattested, 1 = backed, 2 = stale (attestation expired), 3 = shortfall (fewer shares backed than exist)
    function status(address asset) public view returns (uint8 state, uint256 backed, uint256 supply, uint64 asOf, uint64 validUntil, bytes32 evidenceHash) {
        Attestation storage a = latest[asset];
        supply = IERC20(asset).totalSupply();
        if (a.nonce == 0) return (0, 0, supply, 0, 0, bytes32(0));
        backed = a.backedShares; asOf = a.asOf; validUntil = a.validUntil; evidenceHash = a.evidenceHash;
        state = backed < supply ? 3 : (block.timestamp > validUntil ? 2 : 1);
    }

    /// @notice True when the custodian has attested that the reserve does NOT cover every share.
    function isShortfall(address asset) external view returns (bool) {
        Attestation storage a = latest[asset];
        return a.nonce != 0 && a.backedShares < IERC20(asset).totalSupply();
    }

    function digest(Attestation calldata a) external view returns (bytes32) { return _hashTypedDataV4(_structHash(a)); }

    function setCustodian(address newCustodian) external onlyOwner {
        if (newCustodian == address(0)) revert ZeroAddress();
        emit CustodianChanged(custodian, newCustodian);
        custodian = newCustodian;
    }

    function _structHash(Attestation calldata a) private pure returns (bytes32) {
        return keccak256(abi.encode(ATTESTATION_TYPEHASH, a.asset, a.backedShares, a.asOf, a.validUntil, a.evidenceHash, a.nonce));
    }
}
