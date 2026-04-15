//SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TestERC4626} from "@ensuro/utils/contracts/TestERC4626.sol";

contract VaultV2Mock is TestERC4626 {
  uint128 public _totalAssets;
  uint64 public lastUpdate;

  constructor(string memory name_, string memory symbol_, IERC20Metadata asset_) TestERC4626(name_, symbol_, asset_) {}

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    super._deposit(caller, receiver, assets, shares);
    updateCachedTotalAssets();
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    super._withdraw(caller, receiver, owner, assets, shares);
    updateCachedTotalAssets();
  }

  function updateCachedTotalAssets() public {
    _totalAssets = uint128(totalAssets());
    lastUpdate = uint64(block.timestamp);
  }
}
