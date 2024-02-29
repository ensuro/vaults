// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {ICompoundV3} from "./interfaces/ICompoundV3.sol";
import {ICometRewards} from "./interfaces/ICometRewards.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MathUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import {SwapLibrary} from "@ensuro/swaplibrary/contracts/SwapLibrary.sol";
import {PermissionedERC4626} from "./PermissionedERC4626.sol";

/**
 * @title SharedSmartVault
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract CompoundV3ERC4626 is PermissionedERC4626 {
  using SafeERC20 for IERC20Metadata;
  using SwapLibrary for SwapLibrary.SwapConfig;

  bytes32 public constant HARVEST_ROLE = keccak256("HARVEST_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  ICompoundV3 internal immutable _cToken;
  ICometRewards internal immutable _rewardsManager;

  SwapLibrary.SwapConfig _swapConfig;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(ICompoundV3 cToken_, ICometRewards rewardsManager_) {
    _cToken = cToken_;
    _rewardsManager = rewardsManager_;
    _disableInitializers();
  }

  /**
   * @dev Initializes the SharedSmartVault
   */
  function initialize(
    string memory name_,
    string memory symbol_,
    address admin_,
    SwapLibrary.SwapConfig calldata swapConfig_
  ) public virtual initializer {
    __CompoundV3ERC4626_init(name_, symbol_, admin_, swapConfig_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __CompoundV3ERC4626_init(
    string memory name_,
    string memory symbol_,
    address admin_,
    SwapLibrary.SwapConfig calldata swapConfig_
  ) internal onlyInitializing {
    __PermissionedERC4626_init(name_, symbol_, admin_, IERC20Upgradeable(_cToken.baseToken()));
    __CompoundV3ERC4626_init_unchained(swapConfig_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __CompoundV3ERC4626_init_unchained(SwapLibrary.SwapConfig calldata swapConfig_) internal onlyInitializing {
    swapConfig_.validate();
    _swapConfig = swapConfig_;
  }

  /**
   * @dev See {IERC4626-maxWithdraw}.
   */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    if (_cToken.isWithdrawPaused()) return 0;
    return super.maxWithdraw(owner);
  }

  /**
   * @dev See {IERC4626-maxRedeem}.
   */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    if (_cToken.isWithdrawPaused()) return 0;
    return super.maxRedeem(owner);
  }

  /**
   * @dev See {IERC4626-maxDeposit}.
   */
  function maxDeposit(address owner) public view virtual override returns (uint256) {
    if (_cToken.isSupplyPaused()) return 0;
    return super.maxDeposit(owner);
  }

  /**
   * @dev See {IERC4626-maxMint}.
   */
  function maxMint(address owner) public view virtual override returns (uint256) {
    if (_cToken.isSupplyPaused()) return 0;
    return super.maxMint(owner);
  }

  /**
   * @dev See {IERC4626-totalAssets}.
   */
  function totalAssets() public view virtual override returns (uint256 assets) {
    return _cToken.balanceOf(address(this));
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    _cToken.withdraw(address(asset()), assets);
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    // Transfers the assets from the caller and supplies to compound
    super._deposit(caller, receiver, assets, shares);
    _supply(assets);
  }

  function _supply(uint256 assets) internal {
    IERC20Metadata(asset()).approve(address(_cToken), assets);
    _cToken.supply(address(asset()), assets);
  }

  function harvestRewards(uint256 price) external onlyRole(HARVEST_ROLE) {
    (address reward, , ) = _rewardsManager.rewardConfig(address(_cToken));
    if (reward == address(0)) return;
    _rewardsManager.claim(address(_cToken), address(this), true);

    uint256 earned = IERC20Metadata(reward).balanceOf(address(this));
    uint256 reinvestAmount = _swapConfig.exactInput(reward, asset(), earned, price);
    _supply(reinvestAmount);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
