// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {SwapAssetInvestStrategy} from "./SwapAssetInvestStrategy.sol";

/**
 * @title SwapStableInvestStrategy
 * @dev Strategy that invests/deinvests by swapping into another token that has a stable price compared to the asset.
 *      Useful for yield bearing rebasing tokens like Lido o USDM
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SwapStableInvestStrategy is SwapAssetInvestStrategy {
  uint256 internal immutable _price; // One unit of _investAsset in _asset  (in Wad), units: (asset/investAsset)

  /**
   * @dev Constructor of the strategy
   *
   * @param asset_ The address of the underlying token used for accounting, depositing, and withdrawing.
   * @param investAsset_ The address of the tokens hold by the strategy. Typically a rebasing yield bearing token
   * @param price_ Approximate amount of units of _asset required to acquire a unit of _investAsset
   */
  constructor(
    IERC20Metadata asset_,
    IERC20Metadata investAsset_,
    uint256 price_
  ) SwapAssetInvestStrategy(asset_, investAsset_) {
    _price = price_;
  }

  function investAssetPrice() public view virtual override returns (uint256) {
    return _price;
  }
}
