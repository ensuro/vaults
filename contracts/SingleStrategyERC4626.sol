// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MathUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import {PermissionedERC4626} from "./PermissionedERC4626.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {IExposeStorage} from "./interfaces/IExposeStorage.sol";

/**
 * @title SingleStrategyERC4626
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SingleStrategyERC4626 is PermissionedERC4626, IExposeStorage {
  using SafeERC20 for IERC20Metadata;
  using Address for address;

  bytes32 public constant SET_STRATEGY_ROLE = keccak256("SET_STRATEGY_ROLE");

  IInvestStrategy internal _strategy;

  event StrategyChanged(IInvestStrategy oldStrategy, IInvestStrategy newStrategy);
  event WithdrawFailed(bytes reason);

  error ForwardNotAllowed(address strategy, bytes4 method);

  /**
   * @dev Initializes the CompoundV3ERC4626
   */
  function initialize(
    string memory name_,
    string memory symbol_,
    address admin_,
    IERC20Upgradeable asset_,
    IInvestStrategy strategy_,
    bytes memory initStrategyData
  ) public virtual initializer {
    __SingleStrategyERC4626_init(name_, symbol_, admin_, asset_, strategy_, initStrategyData);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __SingleStrategyERC4626_init(
    string memory name_,
    string memory symbol_,
    address admin_,
    IERC20Upgradeable asset_,
    IInvestStrategy strategy_,
    bytes memory initStrategyData
  ) internal onlyInitializing {
    __PermissionedERC4626_init(name_, symbol_, admin_, asset_);
    __SingleStrategyERC4626_init_unchained(strategy_, initStrategyData);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __SingleStrategyERC4626_init_unchained(
    IInvestStrategy strategy_,
    bytes memory initStrategyData
  ) internal onlyInitializing {
    _strategy = strategy_;
    _connectStrategy(initStrategyData);
  }

  function strategyStorageSlot() public view returns (bytes32) {
    return keccak256(abi.encode("co.ensuro.SingleStrategyERC4626", _strategy));
  }

  function _connectStrategy(bytes memory initStrategyData) internal {
    address(_strategy).functionDelegateCall(
      abi.encodeWithSelector(IInvestStrategy.connect.selector, strategyStorageSlot(), initStrategyData)
    );
  }

  /**
   * @dev See {IERC4626-maxWithdraw}.
   */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    return MathUpgradeable.min(_strategy.maxWithdraw(address(this), strategyStorageSlot()), super.maxWithdraw(owner));
  }

  /**
   * @dev See {IERC4626-maxRedeem}.
   */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    uint256 maxAssets = _strategy.maxWithdraw(address(this), strategyStorageSlot());
    return MathUpgradeable.min(_convertToShares(maxAssets, MathUpgradeable.Rounding.Down), super.maxRedeem(owner));
  }

  /**
   * @dev See {IERC4626-maxDeposit}.
   */
  function maxDeposit(address owner) public view virtual override returns (uint256) {
    return MathUpgradeable.min(_strategy.maxDeposit(address(this), strategyStorageSlot()), super.maxDeposit(owner));
  }

  /**
   * @dev See {IERC4626-maxMint}.
   */
  function maxMint(address owner) public view virtual override returns (uint256) {
    uint256 maxAssets = _strategy.maxDeposit(address(this), strategyStorageSlot());
    return MathUpgradeable.min(_convertToShares(maxAssets, MathUpgradeable.Rounding.Down), super.maxMint(owner));
  }

  /**
   * @dev See {IERC4626-totalAssets}.
   */
  function totalAssets() public view virtual override returns (uint256 assets) {
    return _strategy.totalAssets(address(this), strategyStorageSlot());
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    _withdrawFromStrategy(assets, false);
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    // Transfers the assets from the caller and supplies to compound
    super._deposit(caller, receiver, assets, shares);
    address(_strategy).functionDelegateCall(
      abi.encodeWithSelector(IInvestStrategy.deposit.selector, strategyStorageSlot(), assets)
    );
  }

  function _withdrawFromStrategy(uint256 assets, bool ignoreError) internal {
    if (ignoreError) {
      // solhint-disable-next-line avoid-low-level-calls
      (bool success, bytes memory returndata) = address(_strategy).delegatecall(
        abi.encodeWithSelector(IInvestStrategy.withdraw.selector, strategyStorageSlot(), assets)
      );
      if (!success) emit WithdrawFailed(returndata);
    } else {
      address(_strategy).functionDelegateCall(
        abi.encodeWithSelector(IInvestStrategy.withdraw.selector, strategyStorageSlot(), assets)
      );
    }
  }

  // Functions to access the storage from Strategy view
  function getBytes32Slot(bytes32 slot) external view override returns (bytes32) {
    StorageSlot.Bytes32Slot storage r = StorageSlot.getBytes32Slot(slot);
    return r.value;
  }

  function getBytesSlot(bytes32 slot) external view override returns (bytes memory) {
    StorageSlot.BytesSlot storage r = StorageSlot.getBytesSlot(slot);
    return r.value;
  }

  function forwardToStrategy(bytes memory functionCall) external {
    if (!_strategy.forwardAllowed(bytes4(functionCall))) revert ForwardNotAllowed(_strategy, bytes4(functionCall));
    address(_strategy).functionDelegateCall(functionCall);
  }

  function setStrategy(
    IInvestStrategy newStrategy,
    bytes memory initStrategyData,
    bool force
  ) external onlyRole(SET_STRATEGY_ROLE) {
    // I explicitly don't check newStrategy != _strategy because in some cases might be usefull to disconnect and
    // connect a strategy
    _withdrawFromStrategy(_strategy.maxWithdraw(address(this), strategyStorageSlot()), force);
    address(_strategy).functionDelegateCall(
      abi.encodeWithSelector(IInvestStrategy.disconnect.selector, strategyStorageSlot(), force)
    );
    emit StrategyChanged(_strategy, newStrategy);
    _strategy = newStrategy;
    _connectStrategy(initStrategyData);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
