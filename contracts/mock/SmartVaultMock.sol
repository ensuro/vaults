// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract SmartVaultMock {
  using SafeERC20 for IERC20;
  IERC4626[] internal _investments;

  function setInvestments(IERC4626[] calldata investments_) public {
    for (uint256 i = 0; i < investments_.length; i++) {
      _investments.push(investments_[i]);
    }
  }

  function collect(address sender, address token, uint256 amount) public virtual {
    IERC20(token).safeTransferFrom(sender, address(this), amount);
  }

  function withdraw(address receiver, address token, uint256 amount) public virtual {
    uint256 amountLeft = amount;
    uint256 myBalance = IERC20(token).balanceOf(address(this));
    uint256 transfer = Math.min(myBalance, amount);
    IERC20(token).transfer(receiver, transfer);
    amountLeft -= transfer;
    for (uint256 i = 0; amountLeft > 0 && i < _investments.length; i++) {
      transfer = Math.min(_investments[i].maxWithdraw(address(this)), amountLeft);
      _investments[i].withdraw(transfer, receiver, address(this)); //shares de address(this) y receiver
      amountLeft -= transfer;
    }
    if (amountLeft > 0) revert("Amount left should be 0");
  }

  function invest(IERC4626 investment, address token, uint256 amount) public virtual {
    IERC20(token).approve(address(investment), amount);
    investment.deposit(amount, address(this));
  }

  function deinvest(IERC4626 investment, uint256 amount) public virtual {
    investment.withdraw(amount, address(this), address(this));
  }
}
