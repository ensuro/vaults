// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract SmartVaultMock {
  using SafeERC20 for IERC20;

  function collect(address sender, address token, uint256 amount) public virtual {
    IERC20(token).safeTransferFrom(sender, address(this), amount);
  }

  function withdraw(address receiver, address token, uint256 amount) public virtual {
    IERC20(token).safeTransferFrom(address(this), receiver, amount);
  }
}
