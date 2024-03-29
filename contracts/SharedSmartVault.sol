// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {ICallable} from "./interfaces/ICallable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MathUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import {PermissionedERC4626} from "./PermissionedERC4626.sol";

/**
 * @title SharedSmartVault
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SharedSmartVault is PermissionedERC4626 {
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant ADD_INVESTMENT_ROLE = keccak256("ADD_INVESTMENT_ROLE");
  bytes32 public constant REMOVE_INVESTMENT_ROLE = keccak256("REMOVE_INVESTMENT_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  address internal immutable _smartVault;
  ICallable internal _collector;
  ICallable internal _withdrawer;
  IERC4626[] internal _investments;

  event InvestmentAdded(IERC4626 investment);
  event InvestmentRemoved(IERC4626 investment);

  error InvalidSmartVault(address smartVault);
  error InvalidCollector(address collector);
  error InvalidWithdrawer(address withdrawer);
  error InvalidInvestment(address investment);
  error InvestmentNotFound(address investment);
  error InvestmentAlreadyExists(address investment);
  error DifferentAsset(address investmentAsset, address asset);
  error InvestmentWithFunds(address investment, uint256 balance);
  error EmptyInvestments(uint256 length);
  error DifferentBalance(uint256 currentBalance, uint256 prevBalance);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(address smartVault_) {
    if (smartVault_ == address(0)) revert InvalidSmartVault(address(0));
    _disableInitializers();
    _smartVault = smartVault_;
  }

  /**
   * @dev Initializes the SharedSmartVault
   */
  function initialize(
    string memory name_,
    string memory symbol_,
    address admin_,
    ICallable collector_,
    ICallable withdrawer_,
    IERC4626[] calldata investments_,
    IERC20Upgradeable asset_
  ) public virtual initializer {
    __SharedSmartVault_init(name_, symbol_, admin_, collector_, withdrawer_, investments_, asset_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __SharedSmartVault_init(
    string memory name_,
    string memory symbol_,
    address admin_,
    ICallable collector_,
    ICallable withdrawer_,
    IERC4626[] calldata investments_,
    IERC20Upgradeable asset_
  ) internal onlyInitializing {
    __PermissionedERC4626_init(name_, symbol_, admin_, asset_);
    __SharedSmartVault_init_unchained(collector_, withdrawer_, investments_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __SharedSmartVault_init_unchained(
    ICallable collector_,
    ICallable withdrawer_,
    IERC4626[] calldata investments_
  ) internal onlyInitializing {
    if (address(collector_) == address(0)) revert InvalidCollector(address(0));
    if (address(withdrawer_) == address(0)) revert InvalidWithdrawer(address(0));
    if (investments_.length == 0) revert EmptyInvestments(_investments.length);
    _collector = collector_;
    _withdrawer = withdrawer_;
    for (uint256 i = 0; i < investments_.length; i++) {
      _addInvestment(investments_[i]);
    }
    // Infinite approval to the SmartVault
    IERC20Metadata(asset()).approve(_smartVault, type(uint256).max);
  }

  function _balance() internal view returns (uint256) {
    return IERC20Metadata(asset()).balanceOf(address(this));
  }

  /**
   * @dev Returns the address of the Collector
   */
  function collector() public view virtual returns (ICallable) {
    return _collector;
  }

  /**
   * @dev Returns the address of the Withdrawer
   */
  function withdrawer() public view virtual returns (ICallable) {
    return _withdrawer;
  }

  /**
   * @dev Returns the address of the SmartVault
   */
  function smartVault() public view virtual returns (address) {
    return _smartVault;
  }

  function getInvestmentByIndex(uint256 index) public view virtual returns (IERC4626) {
    return _investments[index];
  }

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    uint256 prevBalance = _balance();
    // Transfers the assets from the caller and mints the shares
    super._deposit(caller, receiver, assets, shares);
    // solhint-disable-next-line avoid-low-level-calls
    _collector.call(asset(), assets);
    uint256 balance = _balance();
    // Checks the collector took all the received assets from this contract
    if (balance != prevBalance) revert DifferentBalance(balance, prevBalance);
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    // solhint-disable-next-line avoid-low-level-calls
    _withdrawer.call(asset(), assets);
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  /**
   * @dev See {IERC4626-maxWithdraw}.
   * Is the minimum between the total assets of the user and the maximum amount withdrawable from the smart vault
   */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    uint256 userAssets = super.maxWithdraw(owner);
    if (userAssets == 0) return 0;
    uint256 max = IERC20Metadata(asset()).balanceOf(_smartVault);
    for (uint256 i = 0; i < _investments.length; i++) {
      max += _investments[i].maxWithdraw(_smartVault);
      if (userAssets <= max) return userAssets;
    }
    return max;
  }

  /**
   * @dev See {IERC4626-maxRedeem}.
   */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    uint256 maxW = maxWithdraw(owner);
    if (maxW == super.maxWithdraw(owner)) return super.maxRedeem(owner);
    return _convertToShares(maxW, MathUpgradeable.Rounding.Down);
  }

  /**
   * @dev See {IERC4626-totalAssets}.
   */
  function totalAssets() public view virtual override returns (uint256 assets) {
    assets = IERC20Metadata(asset()).balanceOf(_smartVault);
    for (uint256 i = 0; i < _investments.length; i++) {
      assets += _investments[i].convertToAssets(_investments[i].balanceOf(_smartVault));
    }
    return assets;
  }

  function getInvestmentIndex(IERC4626 investment_) public view virtual returns (uint256) {
    for (uint256 i = 0; i < _investments.length; i++) {
      if (_investments[i] == investment_) {
        return i;
      }
    }
    return type(uint256).max;
  }

  function _addInvestment(IERC4626 investment_) internal {
    if (address(investment_) == address(0)) revert InvalidInvestment(address(0));
    if (getInvestmentIndex(investment_) != type(uint256).max) revert InvestmentAlreadyExists(address(investment_));
    if (investment_.asset() != asset()) revert DifferentAsset(investment_.asset(), asset());

    _investments.push(investment_);
    emit InvestmentAdded(investment_);
  }

  function addInvestment(IERC4626 investment_) external onlyRole(ADD_INVESTMENT_ROLE) {
    _addInvestment(investment_);
  }

  function removeInvestment(IERC4626 investment_) external onlyRole(REMOVE_INVESTMENT_ROLE) {
    if (address(investment_) == address(0)) revert InvalidInvestment(address(0));
    uint256 balance = investment_.balanceOf(_smartVault);
    if (balance != 0) revert InvestmentWithFunds(address(investment_), balance);
    if (_investments.length == 1) revert EmptyInvestments(_investments.length);
    uint256 index = getInvestmentIndex(investment_);
    if (index == type(uint256).max) revert InvestmentNotFound(address(investment_));
    if (index != _investments.length - 1) _investments[index] = _investments[_investments.length - 1];
    _investments.pop();
    emit InvestmentRemoved(investment_);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[47] private __gap;
}
