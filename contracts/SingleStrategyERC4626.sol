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
import {InvestStrategyClient} from "./InvestStrategyClient.sol";

/**
 * @title SingleStrategyERC4626
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
contract SingleStrategyERC4626 is PermissionedERC4626, IExposeStorage {
  using SafeERC20 for IERC20Metadata;
  using Address for address;
  using InvestStrategyClient for IInvestStrategy;

  bytes32 public constant SET_STRATEGY_ROLE = keccak256("SET_STRATEGY_ROLE");

  IInvestStrategy internal _strategy;

  // Events duplicated here from InvestStrategyClient library, so they go to the ABI
  event StrategyChanged(IInvestStrategy oldStrategy, IInvestStrategy newStrategy);
  event WithdrawFailed(bytes reason);
  event DepositFailed(bytes reason);
  event DisconnectFailed(bytes reason);

  error OnlyStrategyStorageExposed();

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
   * @param strategy_ The IInvestStrategy that will be used to manage the funds received.
   * @param initStrategyData Initialization data that will be sent to the IInvestStrategy
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
    strategy_.checkAsset(asset());
    _strategy.dcConnect(initStrategyData);
  }

  /**
   * @dev See {IERC4626-maxWithdraw}.
   */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    return MathUpgradeable.min(_strategy.maxWithdraw(), super.maxWithdraw(owner));
  }

  /**
   * @dev See {IERC4626-maxRedeem}.
   */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    uint256 maxAssets = _strategy.maxWithdraw();
    return MathUpgradeable.min(_convertToShares(maxAssets, MathUpgradeable.Rounding.Down), super.maxRedeem(owner));
  }

  /**
   * @dev See {IERC4626-maxDeposit}.
   */
  function maxDeposit(address owner) public view virtual override returns (uint256) {
    return MathUpgradeable.min(_strategy.maxDeposit(), super.maxDeposit(owner));
  }

  /**
   * @dev See {IERC4626-maxMint}.
   */
  function maxMint(address owner) public view virtual override returns (uint256) {
    uint256 maxAssets = _strategy.maxDeposit();
    return MathUpgradeable.min(_convertToShares(maxAssets, MathUpgradeable.Rounding.Down), super.maxMint(owner));
  }

  /**
   * @dev See {IERC4626-totalAssets}.
   */
  function totalAssets() public view virtual override returns (uint256 assets) {
    return _strategy.totalAssets();
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    _strategy.dcWithdraw(assets, false);
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    // Transfers the assets from the caller and supplies to compound
    super._deposit(caller, receiver, assets, shares);
    _strategy.dcDeposit(assets, false);
  }

  /**
   * @dev Exposes a given slot as a bytes array. To be used by the IInvestStrategy views to access their storage.
   *      Only the slot==strategyStorageSlot() can be accessed.
   */
  function getBytesSlot(bytes32 slot) external view override returns (bytes memory) {
    if (slot != _strategy.storageSlot()) revert OnlyStrategyStorageExposed();
    StorageSlot.BytesSlot storage r = StorageSlot.getBytesSlot(slot);
    return r.value;
  }

  /**
   * @dev Used to call specific methods on the strategies. Anyone can call this method, is responsability of the
   *      IInvestStrategy to check access permissions when needed.
   * @param method Id of the method to call. Is recommended that the strategy defines an enum with the methods that
   *               can be called externally and validates this value.
   * @param extraData Additional parameters sent to the method.
   * @return Returns the output received from the IInvestStrategy.
   */
  function forwardToStrategy(uint8 method, bytes memory extraData) external returns (bytes memory) {
    return _strategy.dcForward(method, extraData);
  }

  /**
   * @dev Changes the current investment strategy to a new one. When this happens, all funds are withdrawn from the
   *      old strategy and deposited on the new one. This reverts if any of this fails, unless the force parameter is
   *      true, in that case errors in withdrawal or deposit are silented.
   * @param newStrategy The new strategy to plug into the vault
   * @param initStrategyData Initialization parameters for this new strategy
   * @param force Boolean to indicate if errors on withdraw or deposit should be accepted. Normally you should send
   *              this value in `false`. Only use `true` if you know what you are doing and trying to replace a faulty
   *              strategy.
   */
  function setStrategy(
    IInvestStrategy newStrategy,
    bytes memory initStrategyData,
    bool force
  ) external onlyRole(SET_STRATEGY_ROLE) {
    InvestStrategyClient.strategyChange(_strategy, newStrategy, initStrategyData, IERC20Metadata(asset()), force);
    _strategy = newStrategy;
  }

  /**
   * @dev Returns the current strategy plugged into the contract
   */
  function strategy() external view returns (IInvestStrategy) {
    return _strategy;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
