// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPool} from "./dependencies/aave-v3/IPool.sol";
import {DataTypes} from "./dependencies/aave-v3/DataTypes.sol";
import {ReserveConfiguration} from "./dependencies/aave-v3/ReserveConfiguration.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {InvestStrategyClient} from "./InvestStrategyClient.sol";

/**
 * @title AaveV3InvestStrategy
 * @dev Strategy that invests/deinvests into AaveV3 on each deposit/withdraw.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract AaveV3InvestStrategy is IInvestStrategy {
  using ReserveConfiguration for DataTypes.ReserveConfigurationMap;

  address private immutable __self = address(this);
  bytes32 public immutable storageSlot = InvestStrategyClient.makeStorageSlot(this);

  IPool internal immutable _aave;
  IERC20 internal immutable _asset;

  // From OZ v5
  error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
  error CanBeCalledOnlyThroughDelegateCall();
  error CannotDisconnectWithAssets();
  error NoExtraDataAllowed();
  error ReserveNotFoundInAave();

  modifier onlyDelegCall() {
    if (address(this) == __self) revert CanBeCalledOnlyThroughDelegateCall();
    _;
  }

  constructor(IERC20 asset_, IPool aave_) {
    if (aave_.getReserveData(address(asset_)).aTokenAddress == address(0)) revert ReserveNotFoundInAave();
    _aave = aave_;
    _asset = asset_;
  }

  function _reserveData() internal view returns (DataTypes.ReserveData memory) {
    return _aave.getReserveData(address(_asset));
  }

  function connect(bytes memory initData) external virtual override onlyDelegCall {
    if (initData.length != 0) revert NoExtraDataAllowed();
  }

  function disconnect(bool force) external virtual override onlyDelegCall {
    IERC20 aToken = IERC20(_reserveData().aTokenAddress);
    if (!force && aToken.balanceOf(address(this)) != 0) revert CannotDisconnectWithAssets();
  }

  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    DataTypes.ReserveData memory reserve = _reserveData();
    if (!reserve.configuration.getActive() || reserve.configuration.getPaused()) return 0;
    return IERC20(reserve.aTokenAddress).balanceOf(contract_);
  }

  function maxDeposit(address /*contract_*/) public view virtual override returns (uint256) {
    DataTypes.ReserveData memory reserve = _reserveData();
    if (!reserve.configuration.getActive() || reserve.configuration.getPaused() || reserve.configuration.getFrozen())
      return 0;
    // Supply cap ignored
    return type(uint256).max;
  }

  function asset(address) public view virtual override returns (address) {
    return address(_asset);
  }

  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    return IERC20(_reserveData().aTokenAddress).balanceOf(contract_);
  }

  function withdraw(uint256 assets) external virtual override onlyDelegCall {
    if (assets != 0) _aave.withdraw(address(_asset), assets, address(this));
  }

  function deposit(uint256 assets) external virtual override onlyDelegCall {
    if (assets != 0) _supply(assets);
  }

  function _supply(uint256 assets) internal {
    IERC20(_asset).approve(address(_aave), assets);
    _aave.supply(address(_asset), assets, address(this), 0);
  }

  function forwardEntryPoint(uint8, bytes memory) external view onlyDelegCall returns (bytes memory) {
    // solhint-disable-next-line gas-custom-errors,reason-string
    revert();
  }
}
