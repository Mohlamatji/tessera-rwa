// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET ONLY. A ZAR-denominated demo token (6 decimals) with a public faucet so judges
///         can try the marketplace without a real stablecoin. Never deploy this to a mainnet.
contract MockStablecoin is ERC20 {
    constructor() ERC20("Mock ZAR Stablecoin", "mZAR") {}

    function decimals() public pure override returns (uint8) { return 6; }

    /// @notice Mints 100,000 mZAR to the caller. Capped at 1,000,000 per address to keep the demo sane.
    function faucet() external {
        require(balanceOf(msg.sender) < 1_000_000 * 1e6, "faucet: balance already high");
        _mint(msg.sender, 100_000 * 1e6);
    }

    /// @notice Testnet convenience so scripts can seed balances.
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
