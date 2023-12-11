// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract InvestmentMock is ERC4626 {
  uint256 public notLiquidFunds;

  constructor(
    string memory name_,
    string memory symbol_,
    IERC20Metadata asset_
  ) ERC20(name_, symbol_) ERC4626(asset_) {} // solhint-disable-line no-empty-blocks

  /** @dev See {IERC4262-totalAssets}. */
  function totalAssets() public view virtual override returns (uint256) {
    return IERC20Metadata(asset()).balanceOf(address(this));
  }

  function setNotLiquidFunds(uint256 notLiquidFunds_) public {
    notLiquidFunds = notLiquidFunds_;
  }

  /**
   * @dev See {IERC4626-maxWithdraw}.
   * Is the minimum between the total assets of the user and the maximum amount withdrawable from the smart vault
   */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    uint256 max = totalAssets() - notLiquidFunds;
    uint256 userAssets = super.maxWithdraw(owner);
    return Math.min(max, userAssets);
  }

  /**
   * @dev See {IERC4626-maxRedeem}.
   */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    uint256 maxW = maxWithdraw(owner);
    if (maxW == super.maxWithdraw(owner)) return super.maxRedeem(owner);
    return _convertToShares(maxW, Math.Rounding.Down);
  }
}
