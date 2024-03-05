// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @dev Methods of the CompoundV3 interface we use
 *      Full interface in
 *  https://github.com/compound-finance/comet/blob/main/contracts/CometExtInterface.sol
 *  https://github.com/compound-finance/comet/blob/main/contracts/CometMainInterface.sol
 */
interface ICompoundV3 is IERC20Metadata {
  /**
   * @dev Executes the collector and withdrawer task
   */
  function baseToken() external view returns (address);

  function isSupplyPaused() external view returns (bool);
  function isWithdrawPaused() external view returns (bool);

  function withdraw(address asset, uint256 amount) external;
  function supply(address asset, uint256 amount) external;
}
