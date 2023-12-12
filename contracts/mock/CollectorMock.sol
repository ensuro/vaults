// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {ICallable} from "../interfaces/ICallable.sol";
import {SmartVaultMock} from "./SmartVaultMock.sol";

contract CollectorMock is ICallable {
  address internal _smartVault;
  bool _faulty;

  constructor(address smartVault_) {
    _smartVault = smartVault_;
  }

  function call(address token, uint256 amount) public virtual {
    if (!_faulty) SmartVaultMock(_smartVault).collect(msg.sender, token, amount);
  }

  function setFaulty(bool faulty) external {
    _faulty = faulty;
  }
}
