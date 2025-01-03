// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PermissionedERC4626} from "./PermissionedERC4626.sol";
import {MSVBase} from "./MSVBase.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";

/**
 * @title MultiStrategyERC4626
 *
 * @dev Vault that invests/deinvests using a pluggable IInvestStrategy on each deposit/withdraw.
 *      The vault is permissioned to deposit/withdraw (not transfer). The owner of the shares must have LP_ROLE.
 *      Investment strategy can be changed. Also, custom messages can be sent to the IInvestStrategy contract.
 *
 *      The code of the IInvestStrategy is called using delegatecall, so it has full control over the assets and
 *      storage of this contract, so you must be very careful the kind of IInvestStrategy is plugged.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract MultiStrategyERC4626 is MSVBase, PermissionedERC4626 {
  bytes32 public constant STRATEGY_ADMIN_ROLE = keccak256("STRATEGY_ADMIN_ROLE");
  bytes32 public constant QUEUE_ADMIN_ROLE = keccak256("QUEUE_ADMIN_ROLE");
  bytes32 public constant REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
  bytes32 public constant FORWARD_TO_STRATEGY_ROLE = keccak256("FORWARD_TO_STRATEGY_ROLE");

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @dev Initializes the SingleStrategyERC4626
   *
   * @param name_ Name of the ERC20/ERC4626 token
   * @param symbol_ Symbol of the ERC20/ERC4626 token
   * @param admin_ User that will receive the DEFAULT_ADMIN_ROLE and later can assign other permissions.
   * @param asset_ The asset() of the ERC4626
   * @param strategies_ The IInvestStrategys that will be used to manage the funds received.
   * @param initStrategyDatas Initialization data that will be sent to the strategies
   * @param depositQueue_ The order in which the funds will be deposited in the strategies
   * @param withdrawQueue_ The order in which the funds will be withdrawn from the strategies
   */
  function initialize(
    string memory name_,
    string memory symbol_,
    address admin_,
    IERC20 asset_,
    IInvestStrategy[] memory strategies_,
    bytes[] memory initStrategyDatas,
    uint8[] memory depositQueue_,
    uint8[] memory withdrawQueue_
  ) public virtual initializer {
    __MultiStrategyERC4626_init(
      name_,
      symbol_,
      admin_,
      asset_,
      strategies_,
      initStrategyDatas,
      depositQueue_,
      withdrawQueue_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __MultiStrategyERC4626_init(
    string memory name_,
    string memory symbol_,
    address admin_,
    IERC20 asset_,
    IInvestStrategy[] memory strategies_,
    bytes[] memory initStrategyDatas,
    uint8[] memory depositQueue_,
    uint8[] memory withdrawQueue_
  ) internal onlyInitializing {
    __PermissionedERC4626_init(name_, symbol_, admin_, asset_);
    __MSVBase_init_unchained(strategies_, initStrategyDatas, depositQueue_, withdrawQueue_);
  }

  function _asset() internal view override returns (address) {
    return asset();
  }

  /// @inheritdoc IERC4626
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    uint256 ownerAssets = super.maxWithdraw(owner);
    return _maxWithdrawable(ownerAssets);
  }

  /// @inheritdoc IERC4626
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    uint256 shares = super.maxRedeem(owner);
    uint256 ownerAssets = _convertToAssets(shares, Math.Rounding.Floor);
    uint256 maxAssets = _maxWithdrawable(ownerAssets);
    return (maxAssets == ownerAssets) ? shares : _convertToShares(maxAssets, Math.Rounding.Floor);
  }

  /// @inheritdoc IERC4626
  function maxDeposit(address owner) public view virtual override returns (uint256 ret) {
    if (super.maxDeposit(owner) == 0) return 0;
    return _maxDepositable();
  }

  /// @inheritdoc IERC4626
  function maxMint(address owner) public view virtual override returns (uint256) {
    if (super.maxMint(owner) == 0) return 0;
    uint256 maxDep = _maxDepositable();
    return maxDep == type(uint256).max ? type(uint256).max : _convertToShares(maxDep, Math.Rounding.Floor);
  }

  /// @inheritdoc IERC4626
  function totalAssets() public view virtual override returns (uint256 assets) {
    return _totalAssets();
  }

  /// @inheritdoc ERC4626Upgradeable
  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    _withdrawFromStrategies(assets);
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  /// @inheritdoc ERC4626Upgradeable
  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    // Transfers the assets from the caller and supplies to compound
    super._deposit(caller, receiver, assets, shares);
    _depositToStrategies(assets);
  }

  /// @inheritdoc MSVBase
  function replaceStrategy(
    uint8 strategyIndex,
    IInvestStrategy newStrategy,
    bytes memory initStrategyData,
    bool force
  ) public override onlyRole(STRATEGY_ADMIN_ROLE) {
    super.replaceStrategy(strategyIndex, newStrategy, initStrategyData, force);
  }

  /// @inheritdoc MSVBase
  function addStrategy(
    IInvestStrategy newStrategy,
    bytes memory initStrategyData
  ) public override onlyRole(STRATEGY_ADMIN_ROLE) {
    super.addStrategy(newStrategy, initStrategyData);
  }

  /// @inheritdoc MSVBase
  function removeStrategy(uint8 strategyIndex, bool force) public override onlyRole(STRATEGY_ADMIN_ROLE) {
    super.removeStrategy(strategyIndex, force);
  }

  /// @inheritdoc MSVBase
  function changeDepositQueue(uint8[] memory newDepositQueue_) public override onlyRole(QUEUE_ADMIN_ROLE) {
    super.changeDepositQueue(newDepositQueue_);
  }

  /// @inheritdoc MSVBase
  function changeWithdrawQueue(uint8[] memory newWithdrawQueue_) public override onlyRole(QUEUE_ADMIN_ROLE) {
    super.changeWithdrawQueue(newWithdrawQueue_);
  }

  /// @inheritdoc MSVBase
  function rebalance(
    uint8 strategyFromIdx,
    uint8 strategyToIdx,
    uint256 amount
  ) public override onlyRole(REBALANCER_ROLE) returns (uint256) {
    return super.rebalance(strategyFromIdx, strategyToIdx, amount);
  }

  /**
   * @dev Returns the AccessControl role required to call forwardToStrategy on a given strategy and method
   *
   * @param strategyIndex The index of the strategy in the _strategies array
   * @param method Id of the method to call. Is recommended that the strategy defines an enum with the methods that
   *               can be called externally and validates this value.
   * @return role The bytes32 role required to execute the call
   */
  function getForwardToStrategyRole(uint8 strategyIndex, uint8 method) public view returns (bytes32 role) {
    address strategy = address(_strategies[strategyIndex]);
    return
      bytes32(bytes20(strategy)) ^
      (bytes32(bytes1(method)) >> 160) ^
      (bytes32(bytes1(strategyIndex)) >> 168) ^
      FORWARD_TO_STRATEGY_ROLE;
  }

  /// @inheritdoc MSVBase
  // solhint-disable no-empty-blocks
  function _checkForwardToStrategy(
    uint8 strategyIndex,
    uint8 method,
    bytes memory
  ) internal view override onlyRole(getForwardToStrategyRole(strategyIndex, method)) {}

  /// @inheritdoc MSVBase
  function forwardToStrategy(
    uint8 strategyIndex,
    uint8 method,
    bytes memory extraData
  ) public override onlyRole(FORWARD_TO_STRATEGY_ROLE) returns (bytes memory) {
    return super.forwardToStrategy(strategyIndex, method, extraData);
  }
}
