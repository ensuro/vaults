// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

interface ICallable {
  /**
   * @dev Executes the collector and withdrawer task
   */
  function call(address token, uint256 amount) external;
}
