// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {InvestStrategyClient} from "./InvestStrategyClient.sol";

/**
 * @title AaveV3InvestStrategy
 *
 * @dev Strategy that invests/deinvests into a 4626 vault
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ERC4626InvestStrategy is IInvestStrategy {
  address private immutable __self = address(this);
  bytes32 public immutable storageSlot = InvestStrategyClient.makeStorageSlot(this);

  IERC4626 internal immutable _vault;
  IERC20 internal immutable _asset;

  error CanBeCalledOnlyThroughDelegateCall();
  error CannotDisconnectWithAssets();
  error NoExtraDataAllowed();

  modifier onlyDelegCall() {
    if (address(this) == __self) revert CanBeCalledOnlyThroughDelegateCall();
    _;
  }

  constructor(IERC4626 vault_) {
    _vault = vault_;
    _asset = IERC20(vault_.asset());
  }

  /// @inheritdoc IInvestStrategy
  function connect(bytes memory initData) external virtual override onlyDelegCall {
    if (initData.length != 0) revert NoExtraDataAllowed();
  }

  /// @inheritdoc IInvestStrategy
  function disconnect(bool force) external virtual override onlyDelegCall {
    // Here I check _vault.balanceOf() instead of totalAssets(). In an extreme cases, when the vault lost all its
    // value these can differ, but on those cases I think it's safer to block the disconnection unless forced
    if (!force && _vault.balanceOf(address(this)) != 0) revert CannotDisconnectWithAssets();
  }

  /// @inheritdoc IInvestStrategy
  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    return _vault.maxWithdraw(contract_);
  }

  /// @inheritdoc IInvestStrategy
  function maxDeposit(address contract_) public view virtual override returns (uint256) {
    return _vault.maxDeposit(contract_);
  }

  /// @inheritdoc IInvestStrategy
  function asset(address) public view virtual override returns (address) {
    return address(_asset);
  }

  /**
   * @dev Returns the ERC4626 where this strategy invests the funds
   */
  function investVault() public view returns (IERC4626) {
    return _vault;
  }

  /// @inheritdoc IInvestStrategy
  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    return _vault.convertToAssets(_vault.balanceOf(contract_));
  }

  /// @inheritdoc IInvestStrategy
  function withdraw(uint256 assets) external virtual override onlyDelegCall {
    _vault.withdraw(assets, address(this), address(this));
  }

  /// @inheritdoc IInvestStrategy
  function deposit(uint256 assets) external virtual override onlyDelegCall {
    _asset.approve(address(_vault), assets);
    _vault.deposit(assets, address(this));
  }

  /// @inheritdoc IInvestStrategy
  function forwardEntryPoint(uint8, bytes memory) external view onlyDelegCall returns (bytes memory) {
    // solhint-disable-next-line gas-custom-errors,reason-string
    revert();
  }
}
