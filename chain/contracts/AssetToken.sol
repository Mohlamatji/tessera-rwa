// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IComplianceRegistry {
    function isEligible(address wallet, uint8 minTier) external view returns (bool);
    function isFrozen(address wallet) external view returns (bool);
}

/**
 * @title AssetToken
 * @notice Fractional ownership of ONE real-world asset (a building, a loan book, a solar farm...)
 *         as a compliance-gated ERC-20, with built-in pro-rata yield distribution.
 *
 * COMPLIANCE ON EVERY MOVE: a share can only be transferred to a wallet that the
 * ComplianceRegistry currently deems eligible (valid KYC, tier >= minTier, not frozen), and
 * frozen wallets can't send either. This is enforced in the token itself (`_update`), so it holds
 * on every venue - Tessera's marketplace, a DEX pool, a direct transfer - not just in our UI.
 *
 * YIELD: the issuer (property manager / borrower / operator) deposits stablecoin income with
 * `depositYield`. Distribution is O(1) in gas regardless of holder count, using the standard
 * "accumulated yield per share" accounting (as in ERC-2222): every holder's entitlement is exact
 * to the share-second, survives transfers (a buyer never receives income earned before they
 * bought; a seller keeps what they accrued), and can be pulled with `claim` or pushed to anyone
 * by anyone with `claimFor` (so a keeper bot can pay holders automatically).
 *
 * `decimals()` is 0: one token is one indivisible share. The legal wrapper (SPV / trust deed,
 * valuation report) is committed to by `documentHash`; the issuer can publish updates, which
 * emit an event so the history is auditable.
 */
contract AssetToken is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant MAG = 2 ** 128;

    IComplianceRegistry public immutable registry;
    IERC20 public immutable payToken;
    address public immutable issuer;
    uint8 public immutable minTier;
    /// @notice max share of supply one non-issuer wallet may hold, in basis points (0 = no cap).
    uint16 public immutable maxHolderBps;
    uint8 public immutable assetClass; // 0 real estate, 1 private credit, 2 green energy, 3 luxury/collectible, 4 other

    bytes32 public documentHash;
    string public documentURI;

    uint256 public accPerShare;                 // magnified by MAG
    mapping(address => int256) private _corr;   // per-holder correction (ERC-2222)
    mapping(address => uint256) public claimed;
    uint256 public totalDeposited;
    uint256 public totalClaimed;
    bool private _forced; // true only inside forcedTransfer / recoverWallet

    event YieldDeposited(address indexed by, uint256 amount, bytes32 indexed ref, uint256 accPerShare);
    event YieldClaimed(address indexed holder, uint256 amount, address indexed triggeredBy);
    event DocumentUpdated(bytes32 indexed documentHash, string uri);
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount, bytes32 indexed reasonRef, address by);
    event WalletRecovered(address indexed lost, address indexed replacement, uint256 shares, uint256 yieldMoved, bytes32 indexed reasonRef, address by);

    error NotEligible(address wallet);
    error WalletFrozen(address wallet);
    error HolderCapExceeded(address wallet);
    error NotIssuer();
    error NoShares();
    error ZeroAmount();

    struct Init {
        string name;
        string symbol;
        address registry;
        address payToken;
        address issuer;
        address owner;
        uint256 totalShares;
        uint8 assetClass;
        uint8 minTier;
        uint16 maxHolderBps;
        bytes32 documentHash;
        string documentURI;
    }

    constructor(Init memory p) ERC20(p.name, p.symbol) Ownable(p.owner) {
        registry = IComplianceRegistry(p.registry);
        payToken = IERC20(p.payToken);
        issuer = p.issuer;
        assetClass = p.assetClass;
        minTier = p.minTier;
        maxHolderBps = p.maxHolderBps;
        documentHash = p.documentHash;
        documentURI = p.documentURI;
        _mint(p.issuer, p.totalShares);
    }

    function decimals() public pure override returns (uint8) { return 0; }

    // ---------------------------------------------------------------- compliance + accounting

    function _update(address from, address to, uint256 value) internal override {
        // A court-ordered / lost-key recovery (owner only) may move shares OUT of a frozen wallet or while paused;
        // the receiving wallet must still be KYC-eligible, so recovery can never route shares around compliance.
        if (from != address(0) && to != address(0) && !_forced) {
            _requireNotPaused();
            if (registry.isFrozen(from)) revert WalletFrozen(from);
        }
        if (to != address(0) && from != address(0)) {
            if (!registry.isEligible(to, minTier)) revert NotEligible(to);
            if (to != issuer && maxHolderBps != 0 && balanceOf(to) + value > (totalSupply() * maxHolderBps) / 10_000) {
                revert HolderCapExceeded(to);
            }
        }
        // ERC-2222 bookkeeping: move the yield "already accounted" with the shares.
        int256 delta = int256(accPerShare * value);
        if (from != address(0)) _corr[from] += delta;
        if (to != address(0)) _corr[to] -= delta;
        super._update(from, to, value);
    }

    // ---------------------------------------------------------------- yield

    /// @notice Issuer deposits income (rent, interest, energy revenue) for pro-rata distribution.
    ///         `ref` labels the period, e.g. keccak256("2026-10").
    function depositYield(uint256 amount, bytes32 ref) external nonReentrant {
        if (msg.sender != issuer) revert NotIssuer();
        if (amount == 0) revert ZeroAmount();
        uint256 supply = totalSupply();
        if (supply == 0) revert NoShares();
        accPerShare += (amount * MAG) / supply;
        totalDeposited += amount;
        payToken.safeTransferFrom(msg.sender, address(this), amount);
        emit YieldDeposited(msg.sender, amount, ref, accPerShare);
    }

    /// @notice Total yield ever earned by `holder` (claimed or not).
    function accumulativeOf(address holder) public view returns (uint256) {
        int256 v = int256(accPerShare * balanceOf(holder)) + _corr[holder];
        return v <= 0 ? 0 : uint256(v) / MAG;
    }

    function pendingYield(address holder) public view returns (uint256) {
        uint256 a = accumulativeOf(holder);
        uint256 c = claimed[holder];
        return a > c ? a - c : 0;
    }

    function claim() external nonReentrant returns (uint256) {
        return _claim(msg.sender);
    }

    /// @notice Anyone may trigger payout to `holder` - the money only ever goes to the holder.
    function claimFor(address holder) external nonReentrant returns (uint256) {
        return _claim(holder);
    }

    function _claim(address holder) private returns (uint256 amount) {
        if (registry.isFrozen(holder)) revert WalletFrozen(holder);
        amount = pendingYield(holder);
        if (amount == 0) return 0;
        claimed[holder] += amount;
        totalClaimed += amount;
        payToken.safeTransfer(holder, amount);
        emit YieldClaimed(holder, amount, msg.sender);
    }

    // ---------------------------------------------------------------- admin

    function updateDocument(bytes32 hash, string calldata uri) external {
        if (msg.sender != issuer) revert NotIssuer();
        documentHash = hash;
        documentURI = uri;
        emit DocumentUpdated(hash, uri);
    }

    // ---------------------------------------------------------------- freeze, recover (ERC-3643 style)

    /// @notice Owner-only move of shares after a court order, sanctions action or similar. `reasonRef` is a hash of the
    ///         order / case file kept off-chain. The receiver must be KYC-eligible; the event is the audit trail.
    function forcedTransfer(address from, address to, uint256 amount, bytes32 reasonRef) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _forced = true;
        _transfer(from, to, amount);
        _forced = false;
        emit ForcedTransfer(from, to, amount, reasonRef, msg.sender);
    }

    /// @notice Lost-key recovery: after the operator has re-verified the same person on `replacement` (a new KYC claim),
    ///         move ALL shares and any unclaimed yield from `lost` to `replacement`.
    function recoverWallet(address lost, address replacement, bytes32 reasonRef) external onlyOwner nonReentrant {
        uint256 shares = balanceOf(lost);
        uint256 pending = pendingYield(lost);
        if (shares == 0 && pending == 0) revert NoShares();
        if (shares != 0) {
            _forced = true;
            _transfer(lost, replacement, shares);
            _forced = false;
        }
        if (pending != 0) {
            claimed[lost] += pending;
            totalClaimed += pending;
            payToken.safeTransfer(replacement, pending);
        }
        emit WalletRecovered(lost, replacement, shares, pending, reasonRef, msg.sender);
    }

    /// @notice Emergency stop of share transfers for this asset (e.g. court order, valuation dispute).
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
