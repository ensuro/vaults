// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {ICallable} from "../interfaces/ICallable.sol";
import {SmartVaultMock} from "./SmartVaultMock.sol";

contract CollectorMock is ICallable {
  address internal _smartVault;

  constructor(address smartVault_) {
    _smartVault = smartVault_;
  }

  function call(address token, uint256 amount) public virtual {
    SmartVaultMock(_smartVault).collect(msg.sender, token, amount);
  }
}
