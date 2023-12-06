// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract SmartVaultMock {
  using SafeERC20 for IERC20;

  function collect(address sender, address token, uint256 amount) public virtual {
    IERC20(token).safeTransferFrom(sender, address(this), amount);
  }

  function withdraw(address receiver, address token, uint256 amount) public virtual {
    IERC20(token).transfer(receiver, amount);
  }

  function invest(IERC4626 investment, address token, uint256 amount) public virtual {
    IERC20(token).approve(address(investment), amount);
    investment.deposit(amount, address(this));
  }

  function deinvest(IERC4626 investment, uint256 amount) public virtual {
    investment.withdraw(amount, address(this), address(this));
  }
}
