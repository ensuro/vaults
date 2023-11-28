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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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

  address internal immutable _smartVault;
  ICallable internal _collector;
  ICallable internal _withdrawer;
  IERC4626[] internal _investments;

  event InvestmentAdded(IERC4626 investment);
  event InvestmentRemoved(IERC4626 investment);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(address smartVault_) {
    require(smartVault_ != address(0), "SharedSmartVault: smartVault_ cannot be zero address");
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
    require(
      address(collector_) != address(0),
      "SharedSmartVault: collector_ cannot be zero address"
    );
    require(
      address(withdrawer_) != address(0),
      "SharedSmartVault: withdrawer_ cannot be zero address"
    );
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
    require(
      address(collector_) != address(0),
      "SharedSmartVault: collector_ cannot be zero address"
    );
    require(
      address(withdrawer_) != address(0),
      "SharedSmartVault: withdrawer_ cannot be zero address"
    );
    require(investments_.length != 0, "SharedSmartVault: investments_ cannot be empty.");
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());

    _collector = collector_;
    _withdrawer = withdrawer_;
    for (uint256 i = 0; i < investments_.length; i++) {
      this.addInvestment(investments_[i]);
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
    super._deposit(caller, receiver, assets, shares);
    _collector.call(asset(), assets);
    require(
      _balance() == 0,
      "SharedSmartVault: balance of the shared smart vault should be 0 after deposit"
    );
  }

  function maxDeposit(address owner) public view virtual override returns (uint256) {
    uint256 max = 0;
    for (uint256 i = 0; i < _investments.length; i++) {
      max += _investments[i].maxDeposit(owner);
      if (max == type(uint256).max) return max;
    }
    return max;
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

  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    uint256 max = 0;
    for (uint256 i = 0; i < _investments.length; i++) {
      max += _investments[i].maxWithdraw(owner);
    }
    return Math.min(super.maxWithdraw(owner), max);
  }

  function totalAssets() public view virtual override returns (uint256) {
    uint256 assets = IERC20Metadata(asset()).balanceOf(_smartVault);
    for (uint256 i = 0; i < _investments.length; i++) {
      assets += _investments[i].convertToAssets(_investments[i].balanceOf(_smartVault));
    }
    return assets;
  }

  function getInvestmentIndex(IERC4626 investment_) internal virtual returns (uint) {
    for (uint i = 0; i < _investments.length; i++) {
      if (_investments[i] == investment_) {
        return i;
      }
    }
    return type(uint).max;
  }

  function addInvestment(IERC4626 investment_) external onlyRole(ADD_INVESTMENT_ROLE) {
    require(
      address(investment_) != address(0),
      "SharedSmartVault: investment_ cannot be zero address."
    );
    require(
      getInvestmentIndex(investment_) == type(uint).max,
      "SharedSmartVault: investment_ already exists."
    );
    _investments.push(investment_);
    emit InvestmentAdded(investment_);
  }

  function removeInvestment(IERC4626 investment_) external onlyRole(REMOVE_INVESTMENT_ROLE) {
    require(
      address(investment_) != address(0),
      "SharedSmartVault: investment_ cannot be zero address."
    );
    require(
      investment_.balanceOf(_smartVault) == 0,
      "SharedSmartVault: cannot remove an investment_ with funds."
    );
    require(_investments.length != 1, "SharedSmartVault: cannot remove all the _investments.");
    uint256 index = getInvestmentIndex(investment_);
    require(index != type(uint).max, "SharedSmartVault: investment_ not found.");
    delete _investments[index];
    emit InvestmentRemoved(investment_);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
