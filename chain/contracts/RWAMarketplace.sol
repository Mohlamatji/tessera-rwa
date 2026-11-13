// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAssetFactory { function isAsset(address) external view returns (bool); }
interface IAsset is IERC20 { function minTier() external view returns (uint8); }
interface IRegistry { function isEligible(address, uint8) external view returns (bool); }
interface IBackingOracle { function isShortfall(address asset) external view returns (bool); }

/**
 * @title RWAMarketplace
 * @notice Non-custodial, atomic order book for fractional asset shares - both the primary sale
 *         (the issuer lists new shares) and the secondary market (investors resell) use the same
 *         flow, which is what gives instant liquidity.
 *
 *  - NON-CUSTODIAL: listed shares stay in the seller's wallet (the seller approves this contract),
 *    so a seller keeps earning yield on them until the moment they sell. Nothing is escrowed.
 *  - ATOMIC: in one transaction the buyer pays stablecoin to the seller and receives the shares.
 *    Both legs succeed or neither does.
 *  - COMPLIANT BY CONSTRUCTION: the share token itself rejects a transfer to an ineligible or
 *    frozen wallet, so this contract can't be used to bypass KYC/AML - we don't re-implement the
 *    rules here, we rely on the token's.
 *  - STALE-PROOF: if a seller has since moved the shares or revoked approval, `buy` simply reverts;
 *    a listing never lets anyone pay for shares that can't be delivered.
 *  - Only assets made by the AssetFactory can be listed. Protocol fee is capped at 5%.
 */
contract RWAMarketplace is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Listing {
        address seller;
        address asset;
        uint128 remaining;
        uint128 pricePerShare; // in payToken base units
        bool active;
    }

    IAssetFactory public immutable factory;
    IERC20 public immutable payToken;
    IRegistry public immutable registry;
    uint16 public feeBps;
    address public feeRecipient;
    /// @notice Optional proof-of-backing oracle. While it reports a shortfall for an asset, nobody can BUY that asset.
    IBackingOracle public backing;
    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    event Listed(uint256 indexed id, address indexed asset, address indexed seller, uint256 amount, uint256 pricePerShare);
    event Sold(uint256 indexed id, address indexed asset, address indexed buyer, address seller, uint256 amount, uint256 pricePerShare, uint256 fee);
    event Cancelled(uint256 indexed id, address indexed by);
    event FeeChanged(uint16 feeBps, address feeRecipient);
    event BackingOracleChanged(address indexed oracle);

    error NotAnAsset();
    error NotEligible();
    error BadAmount();
    error NotActive();
    error NotAuthorised();
    error SelfTrade();
    error FeeTooHigh();
    error InsufficientShares();
    error BackingShortfall(address asset);

    constructor(address factory_, address payToken_, address registry_, address owner_, uint16 feeBps_, address feeRecipient_) Ownable(owner_) {
        if (feeBps_ > 500) revert FeeTooHigh();
        factory = IAssetFactory(factory_);
        payToken = IERC20(payToken_);
        registry = IRegistry(registry_);
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    function list(address asset, uint256 amount, uint256 pricePerShare) external whenNotPaused returns (uint256 id) {
        if (!factory.isAsset(asset)) revert NotAnAsset();
        if (amount == 0 || pricePerShare == 0 || amount > type(uint128).max || pricePerShare > type(uint128).max) revert BadAmount();
        if (!registry.isEligible(msg.sender, IAsset(asset).minTier()) && msg.sender != _issuer(asset)) revert NotEligible();
        if (IAsset(asset).balanceOf(msg.sender) < amount) revert InsufficientShares();
        id = nextListingId++;
        listings[id] = Listing(msg.sender, asset, uint128(amount), uint128(pricePerShare), true);
        emit Listed(id, asset, msg.sender, amount, pricePerShare);
    }

    function buy(uint256 id, uint256 amount) external whenNotPaused nonReentrant {
        Listing storage l = listings[id];
        if (!l.active) revert NotActive();
        if (amount == 0 || amount > l.remaining) revert BadAmount();
        if (msg.sender == l.seller) revert SelfTrade();
        if (address(backing) != address(0) && backing.isShortfall(l.asset)) revert BackingShortfall(l.asset);

        l.remaining -= uint128(amount);
        if (l.remaining == 0) l.active = false;

        uint256 cost = amount * l.pricePerShare;
        uint256 fee = (cost * feeBps) / 10_000;
        payToken.safeTransferFrom(msg.sender, l.seller, cost - fee);
        if (fee != 0) payToken.safeTransferFrom(msg.sender, feeRecipient, fee);
        // The share token enforces KYC/AML for buyer and seller; it reverts the whole trade otherwise.
        IERC20(l.asset).safeTransferFrom(l.seller, msg.sender, amount);
        emit Sold(id, l.asset, msg.sender, l.seller, amount, l.pricePerShare, fee);
    }

    function cancel(uint256 id) external {
        Listing storage l = listings[id];
        if (!l.active) revert NotActive();
        if (msg.sender != l.seller && msg.sender != owner()) revert NotAuthorised();
        l.active = false;
        emit Cancelled(id, msg.sender);
    }

    function setFee(uint16 feeBps_, address recipient) external onlyOwner {
        if (feeBps_ > 500) revert FeeTooHigh();
        feeBps = feeBps_;
        feeRecipient = recipient;
        emit FeeChanged(feeBps_, recipient);
    }

    function setBackingOracle(address oracle) external onlyOwner {
        backing = IBackingOracle(oracle);
        emit BackingOracleChanged(oracle);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function _issuer(address asset) private view returns (address) {
        (bool ok, bytes memory data) = asset.staticcall(abi.encodeWithSignature("issuer()"));
        return ok && data.length == 32 ? abi.decode(data, (address)) : address(0);
    }
}
