// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {SwapAssetInvestStrategy} from "./SwapAssetInvestStrategy.sol";
import {AggregatorV3Interface} from "./dependencies/chainlink/AggregatorV3Interface.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ChainlinkSwapAssetInvestStrategy
 * @dev Strategy that invests/deinvests by swapping into another token, where the price of both tokens is obtained
 *      from chainlink oracles.
 *
 *      The oracles should express the prices in the same base. For example if asset=USDC and investAsset=WPOL,
 *      then `assetOracle()` is an oracle that returns the price of USDC in USD (or other base) and
 *      `investAssetOracle()` is an oracle that returns the price of WPOL in USD (or other base, but the same as
 *      `assetOracle()`).
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ChainlinkSwapAssetInvestStrategy is SwapAssetInvestStrategy {
  AggregatorV3Interface public immutable assetOracle;
  AggregatorV3Interface public immutable investAssetOracle;
  uint256 public immutable priceTolerance;

  error PriceTooOld(uint256 updatedAt);
  error InvalidPrice(int256 chainlinkAnswer);

  /**
   * @dev Constructor of the strategy
   *
   * @param asset_ The address of the underlying token used for accounting, depositing, and withdrawing.
   * @param investAsset_ The address of the tokens hold by the strategy. Typically a rebasing yield bearing token
   * @param assetOracle_ The chainlink oracle to obtain the price of the asset. If address(0) the price is 1.
   * @param investAssetOracle_ The chainlink oracle to obtain the price of the invest asset. If address(0) => 1
   */
  constructor(
    IERC20Metadata asset_,
    IERC20Metadata investAsset_,
    AggregatorV3Interface assetOracle_,
    AggregatorV3Interface investAssetOracle_,
    uint256 priceTolerance_
  ) SwapAssetInvestStrategy(asset_, investAsset_) {
    investAssetOracle = investAssetOracle_;
    assetOracle = assetOracle_;
    priceTolerance = priceTolerance_;
  }

  function investAssetPrice() public view virtual override returns (uint256) {
    return Math.mulDiv(_getOraclePrice(investAssetOracle), WAD, _getOraclePrice(assetOracle));
  }

  function _getOraclePrice(AggregatorV3Interface oracle) internal view returns (uint256) {
    if (address(oracle) == address(0)) return WAD;
    (, int256 answer, , uint256 updatedAt, ) = oracle.latestRoundData();
    require(updatedAt > block.timestamp - priceTolerance, PriceTooOld(updatedAt));
    require(answer > 0, InvalidPrice(answer));
    return uint256(answer) * 10 ** (18 - oracle.decimals());
  }
}
