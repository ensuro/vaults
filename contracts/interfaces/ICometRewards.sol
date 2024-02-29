// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @dev Methods of the CometRewards interface we use
 *      Full interface in
 *  https://github.com/compound-finance/comet/blob/main/contracts/CometRewards.sol
 */
interface ICometRewards {
  function rewardConfig(address cToken) external returns (address token, uint64 rescaleFactor, bool shouldUpscale);

  function claim(address comet, address src, bool shouldAccrue) external;
}
