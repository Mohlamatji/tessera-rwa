// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AssetToken} from "./AssetToken.sol";

/**
 * @title AssetFactory
 * @notice Tessera's curated issuance desk. Only the platform owner (after off-chain legal and
 *         valuation due diligence) can create an asset; the marketplace only trades tokens this
 *         factory made, so a look-alike scam token can never be listed.
 */
contract AssetFactory is Ownable {
    address public immutable registry;
    address public immutable payToken;

    address[] private _assets;
    mapping(address => bool) public isAsset;

    event AssetCreated(
        address indexed asset, address indexed issuer, uint8 assetClass, uint256 totalShares,
        uint8 minTier, bytes32 documentHash, string name, string symbol
    );

    error BadParams();

    constructor(address registry_, address payToken_, address owner_) Ownable(owner_) {
        registry = registry_;
        payToken = payToken_;
    }

    struct NewAsset {
        string name;
        string symbol;
        address issuer;
        uint256 totalShares;
        uint8 assetClass;
        uint8 minTier;
        uint16 maxHolderBps;
        bytes32 documentHash;
        string documentURI;
    }

    function createAsset(NewAsset calldata p) external onlyOwner returns (address asset) {
        if (p.issuer == address(0) || p.totalShares == 0 || p.minTier == 0 || p.minTier > 2 || p.maxHolderBps > 10_000) revert BadParams();
        asset = address(new AssetToken(AssetToken.Init({
            name: p.name, symbol: p.symbol, registry: registry, payToken: payToken, issuer: p.issuer,
            owner: owner(), totalShares: p.totalShares, assetClass: p.assetClass, minTier: p.minTier,
            maxHolderBps: p.maxHolderBps, documentHash: p.documentHash, documentURI: p.documentURI
        })));
        _assets.push(asset);
        isAsset[asset] = true;
        emit AssetCreated(asset, p.issuer, p.assetClass, p.totalShares, p.minTier, p.documentHash, p.name, p.symbol);
    }

    function assetCount() external view returns (uint256) { return _assets.length; }
    function assets(uint256 i) external view returns (address) { return _assets[i]; }
}
