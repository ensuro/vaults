// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPool} from "./dependencies/aave-v3/IPool.sol";
import {DataTypes} from "./dependencies/aave-v3/DataTypes.sol";
import {ReserveConfiguration} from "./dependencies/aave-v3/ReserveConfiguration.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {SwapStableInvestStrategy} from "./SwapStableInvestStrategy.sol";

/**
 * @title SwapStableAaveV3InvestStrategy
 * @dev Strategy that invests/deinvests by swapping into another token that has a stable price compared to the asset.
 *      And then invests the resulting token in AAVE. Useful when equivalent assets like Bridged USDC and Native USDC
 *      have different returns on AAVE.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SwapStableAaveV3InvestStrategy is SwapStableInvestStrategy {
  using ReserveConfiguration for DataTypes.ReserveConfigurationMap;

  event ResupplyFailed(uint256 assets);

  IPool internal immutable _aave;
  /**
   * @dev Constructor of the strategy
   *
   * @param asset_ The address of the underlying token used for accounting, depositing, and withdrawing.
   * @param investAsset_ The address of the tokens that are later supplied to AAVE
   * @param price_ Approximate amount of units of _asset required to acquire a unit of _investAsset
   * @param aave_ Address of AAVE Pool contract
   */
  constructor(
    IERC20Metadata asset_,
    IERC20Metadata investAsset_,
    uint256 price_,
    IPool aave_
  ) SwapStableInvestStrategy(asset_, investAsset_, price_) {
    _aave = aave_;
  }

  function _reserveData() internal view returns (DataTypes.ReserveData memory) {
    return _aave.getReserveData(address(_investAsset));
  }

  function disconnect(bool force) external virtual override onlyDelegCall {
    IERC20Metadata aToken = IERC20Metadata(_reserveData().aTokenAddress);
    if (!force && aToken.balanceOf(address(this)) != 0) revert CannotDisconnectWithAssets();
  }

  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    DataTypes.ReserveData memory reserve = _reserveData();
    if (!reserve.configuration.getActive() || reserve.configuration.getPaused()) return 0;
    return totalAssets(contract_); // TODO: check how much can be swapped without breaking the slippage
  }

  function maxDeposit(address /*contract_*/) public view virtual override returns (uint256) {
    DataTypes.ReserveData memory reserve = _reserveData();
    if (!reserve.configuration.getActive() || reserve.configuration.getPaused() || reserve.configuration.getFrozen())
      return 0;
    // Supply cap ignored
    return type(uint256).max;
  }

  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    return _convertAssets(IERC20Metadata(_reserveData().aTokenAddress).balanceOf(contract_), contract_);
  }

  function withdraw(uint256 assets) public virtual override onlyDelegCall {
    if (assets == 0) return;
    // Withdraw everything then deposit the remainder
    _aave.withdraw(address(_investAsset), type(uint256).max, address(this));
    // This call will convert investAssets to assets
    super.withdraw(assets);
    // Supply the remaining balance again to AAVE - Ignore errors to avoid reverting in case this deposit fails
    // In the worst case we will have some funds not invested
    _supply(_investAsset.balanceOf(address(this)), true);
  }

  function deposit(uint256 assets) public virtual override onlyDelegCall {
    super.deposit(assets); // Converts assets to investAssets
    _supply(_investAsset.balanceOf(address(this)), false);
  }

  function _supply(uint256 assets, bool failSafe) internal {
    if (assets == 0) return;
    _investAsset.approve(address(_aave), assets);
    if (failSafe) {
      try _aave.supply(address(_investAsset), assets, address(this), 0) {
        return;
      } catch {
        emit ResupplyFailed(assets);
      }
    } else _aave.supply(address(_investAsset), assets, address(this), 0);
  }
}
