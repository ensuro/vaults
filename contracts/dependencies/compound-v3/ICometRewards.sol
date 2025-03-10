// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @dev Methods of the CometRewards interface we use
 *      Full interface in
 *  https://github.com/compound-finance/comet/blob/main/contracts/CometRewards.sol
 */
interface ICometRewards {
      struct RewardOwed {
        address token;
        uint owed;
    }

  function rewardConfig(address cToken) external returns (address token, uint64 rescaleFactor, bool shouldUpscale);

  function claim(address comet, address src, bool shouldAccrue) external;

  function getRewardOwed(address comet, address account) external returns (RewardOwed memory);
}
