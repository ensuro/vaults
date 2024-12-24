// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MSVBase} from "./MSVBase.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";

/**
 * @title AccessManagedMSV
 *
 * @dev Vault that invests/deinvests using a pluggable IInvestStrategy on each deposit/withdraw.
 *      The vault MUST be deployed behind an AccessManagedProxy that controls the access to the critical methods
 *      Since this contract DOESN'T DO ANY ACCESS CONTROL.
 *
 *      The code of the IInvestStrategy is called using delegatecall, so it has full control over the assets and
 *      storage of this contract, so you must be very careful the kind of IInvestStrategy is plugged.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract AccessManagedMSV is MSVBase, UUPSUpgradeable, ERC4626Upgradeable {
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @dev Initializes the SingleStrategyERC4626
   *
   * @param name_ Name of the ERC20/ERC4626 token
   * @param symbol_ Symbol of the ERC20/ERC4626 token
   * @param asset_ The asset() of the ERC4626
   * @param strategies_ The IInvestStrategys that will be used to manage the funds received.
   * @param initStrategyDatas Initialization data that will be sent to the strategies
   * @param depositQueue_ The order in which the funds will be deposited in the strategies
   * @param withdrawQueue_ The order in which the funds will be withdrawn from the strategies
   */
  function initialize(
    string memory name_,
    string memory symbol_,
    IERC20 asset_,
    IInvestStrategy[] memory strategies_,
    bytes[] memory initStrategyDatas,
    uint8[] memory depositQueue_,
    uint8[] memory withdrawQueue_
  ) public virtual initializer {
    __AccessManagedMSV_init(name_, symbol_, asset_, strategies_, initStrategyDatas, depositQueue_, withdrawQueue_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __AccessManagedMSV_init(
    string memory name_,
    string memory symbol_,
    IERC20 asset_,
    IInvestStrategy[] memory strategies_,
    bytes[] memory initStrategyDatas,
    uint8[] memory depositQueue_,
    uint8[] memory withdrawQueue_
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __ERC4626_init(asset_);
    __ERC20_init(name_, symbol_);
    __MSVBase_init_unchained(strategies_, initStrategyDatas, depositQueue_, withdrawQueue_);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override {}

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
  function maxDeposit(address) public view virtual override returns (uint256 ret) {
    return _maxDepositable();
  }

  /// @inheritdoc IERC4626
  function maxMint(address) public view virtual override returns (uint256) {
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
}
