// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract InvestmentMock is ERC4626 {
  constructor(
    string memory name_,
    string memory symbol_,
    IERC20Metadata asset_
  ) ERC20(name_, symbol_) ERC4626(asset_) {}

  /** @dev See {IERC4262-totalAssets}. */
  function totalAssets() public view virtual override returns (uint256) {
    return IERC20Metadata(asset()).balanceOf(address(this));
  }
}
