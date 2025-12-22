// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {InvestStrategyClient} from "./InvestStrategyClient.sol";

/**
 * @title IdleInvestStrategy
 * @dev Strategy that keeps the funds idle, in vault's asset(), without generating any yield.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract IdleInvestStrategy is IInvestStrategy {
  address internal immutable __self = address(this);
  bytes32 public immutable storageSlot = InvestStrategyClient.makeStorageSlot(this);

  IERC20Metadata internal immutable _asset;

  error CanBeCalledOnlyThroughDelegateCall();
  error CannotDisconnectWithAssets();
  error NoExtraDataAllowed();

  modifier onlyDelegCall() {
    if (address(this) == __self) revert CanBeCalledOnlyThroughDelegateCall();
    _;
  }

  /**
   * @dev Constructor of the strategy
   *
   * @param asset_ The address of the underlying token used for accounting, depositing, and withdrawing.
   */
  constructor(IERC20Metadata asset_) {
    _asset = asset_;
  }

  /// @inheritdoc IInvestStrategy
  function connect(bytes memory initData) external virtual override onlyDelegCall {
    if (initData.length != 0) revert NoExtraDataAllowed();
  }

  /// @inheritdoc IInvestStrategy
  function disconnect(bool force) external virtual override onlyDelegCall {
    if (!force && totalAssets(address(this)) != 0) revert CannotDisconnectWithAssets();
  }

  /// @inheritdoc IInvestStrategy
  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    return totalAssets(contract_);
  }

  /// @inheritdoc IInvestStrategy
  function maxDeposit(address /*contract_*/) public view virtual override returns (uint256) {
    return type(uint256).max;
  }

  /// @inheritdoc IInvestStrategy
  function asset(address) public view virtual override returns (address) {
    return address(_asset);
  }

  /// @inheritdoc IInvestStrategy
  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    return _asset.balanceOf(contract_);
  }

  /// @inheritdoc IInvestStrategy
  // solhint-disable-next-line no-empty-blocks
  function withdraw(uint256 assets) public virtual override onlyDelegCall {}

  /// @inheritdoc IInvestStrategy
  // solhint-disable-next-line no-empty-blocks
  function deposit(uint256 assets) public virtual override onlyDelegCall {}

  /// @inheritdoc IInvestStrategy
  function forwardEntryPoint(uint8, bytes memory) external view onlyDelegCall returns (bytes memory) {
    // solhint-disable-next-line gas-custom-errors,reason-string
    revert();
  }
}
