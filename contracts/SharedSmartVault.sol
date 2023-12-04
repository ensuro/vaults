// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ICallable} from "./interfaces/ICallable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {MathUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

/**
 * @title SharedSmartVault
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SharedSmartVault is AccessControlUpgradeable, UUPSUpgradeable, ERC4626Upgradeable {
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant LP_ROLE = keccak256("LP_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
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
  error InvalidAsset(address asset);
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
    ICallable collector_,
    ICallable withdrawer_,
    IERC4626[] calldata investments_,
    IERC20Upgradeable asset_
  ) public virtual initializer {
    __SharedSmartVault_init(name_, symbol_, collector_, withdrawer_, investments_, asset_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __SharedSmartVault_init(
    string memory name_,
    string memory symbol_,
    ICallable collector_,
    ICallable withdrawer_,
    IERC4626[] calldata investments_,
    IERC20Upgradeable asset_
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    if (address(asset_) == address(0)) revert InvalidAsset(address(0));
    __ERC4626_init(asset_);
    __ERC20_init(name_, symbol_);
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
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    _collector = collector_;
    _withdrawer = withdrawer_;
    for (uint256 i = 0; i < investments_.length; i++) {
      _addInvestment(investments_[i]);
    }
    // Infinite approval to the SmartVault
    IERC20Metadata(asset()).approve(_smartVault, type(uint256).max);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override onlyRole(GUARDIAN_ROLE) {}

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

  /**
   * @dev See {IERC4626-deposit}.
   */
  function deposit(
    uint256 assets,
    address receiver
  ) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.deposit(assets, receiver);
  }

  function _deposit(
    address caller,
    address receiver,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    uint256 prevBalance = _balance();
    super._deposit(caller, receiver, assets, shares);
    _collector.call(asset(), assets);
    uint256 balance = _balance();
    if (balance != prevBalance) revert DifferentBalance(balance, prevBalance);
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    _withdrawer.call(asset(), assets);
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  /**
   * @dev See {IERC4626-deposit}.
   */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    uint256 max = 0;
    uint256 userAssets = super.maxWithdraw(owner);
    for (uint256 i = 0; i < _investments.length; i++) {
      max += _investments[i].maxWithdraw(owner);
      if (userAssets <= max) return userAssets;
    }
    return max;
  }

  /**
   * @dev See {IERC4626-deposit}.
   */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    uint256 maxW = maxWithdraw(owner);
    if (maxW == super.maxWithdraw(owner)) return super.maxRedeem(owner);
    return _convertToShares(maxW, MathUpgradeable.Rounding.Down);
  }

  /**
   * @dev See {IERC4626-deposit}.
   */
  function totalAssets() public view virtual override returns (uint256 assets) {
    assets = IERC20Metadata(asset()).balanceOf(_smartVault);
    for (uint256 i = 0; i < _investments.length; i++) {
      assets += _investments[i].convertToAssets(_investments[i].balanceOf(_smartVault));
    }
    return assets;
  }

  function getInvestmentIndex(IERC4626 investment_) internal virtual returns (uint256) {
    for (uint256 i = 0; i < _investments.length; i++) {
      if (_investments[i] == investment_) {
        return i;
      }
    }
    return type(uint256).max;
  }

  function _addInvestment(IERC4626 investment_) internal {
    if (address(investment_) == address(0)) revert InvalidInvestment(address(0));
    if (getInvestmentIndex(investment_) != type(uint256).max)
      revert InvestmentAlreadyExists(address(investment_));
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
    for (uint256 i = index; i < _investments.length - 1; i++) {
      _investments[i] = _investments[i + 1];
    }
    _investments.pop();
    emit InvestmentRemoved(investment_);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
