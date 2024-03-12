// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {ICompoundV3} from "./interfaces/ICompoundV3.sol";
import {ICometRewards} from "./interfaces/ICometRewards.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {SwapLibrary} from "@ensuro/swaplibrary/contracts/SwapLibrary.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {IExposeStorage} from "./interfaces/IExposeStorage.sol";

/**
 * @title CompoundV3ERC4626
 * @dev Vault that invests/deinvests into CompoundV3 on each deposit/withdraw. Also, has a method to claim the rewards,
 *      swap them, and reinvests the result into CompoundV3.
 *      Entering or exiting the vault is permissioned, requires LP_ROLE
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract CompoundV3InvestStrategy is IInvestStrategy {
  using SwapLibrary for SwapLibrary.SwapConfig;

  bytes32 public constant HARVEST_ROLE = keccak256("HARVEST_ROLE");
  bytes32 public constant SWAP_ADMIN_ROLE = keccak256("SWAP_ADMIN_ROLE");

  address private immutable __self = address(this);
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  ICompoundV3 internal immutable _cToken;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  ICometRewards internal immutable _rewardsManager;
  address internal immutable _baseToken;

  event RewardsClaimed(address token, uint256 rewards, uint256 receivedInAsset);

  event SwapConfigChanged(SwapLibrary.SwapConfig oldConfig, SwapLibrary.SwapConfig newConfig);

  // From OZ v5
  error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
  error CanBeCalledOnlyThroughDelegateCall();
  error CannotDisconnectWithAssets();

  modifier onlyDelegCall() {
    if (address(this) != __self) revert CanBeCalledOnlyThroughDelegateCall();
    _;
  }

  modifier onlyRole(bytes32 role) {
    if (!IAccessControl(address(this)).hasRole(role, msg.sender))
      revert AccessControlUnauthorizedAccount(msg.sender, role);
    _;
  }

  constructor(ICompoundV3 cToken_, ICometRewards rewardsManager_) {
    _cToken = cToken_;
    _rewardsManager = rewardsManager_;
    _baseToken = cToken_.baseToken();
  }

  function connect(bytes32 storageSlot, bytes memory initData) external virtual override onlyDelegCall {
    SwapLibrary.SwapConfig memory swapConfig = abi.decode(initData, (SwapLibrary.SwapConfig));
    swapConfig.validate();
    StorageSlot.getBytesSlot(storageSlot).value = initData;
  }

  function disconnect(bytes32 /*storageSlot*/, bool force) external virtual override onlyDelegCall {
    if (!force && _cToken.balanceOf(address(this)) != 0) revert CannotDisconnectWithAssets();
  }

  function maxWithdraw(address contract_, bytes32 /*storageSlot*/) public view virtual override returns (uint256) {
    if (_cToken.isWithdrawPaused()) return 0;
    return _cToken.balanceOf(contract_);
  }

  function maxDeposit(address /*contract_*/, bytes32 /*storageSlot*/) public view virtual override returns (uint256) {
    if (_cToken.isSupplyPaused()) return 0;
    return type(uint256).max;
  }

  function totalAssets(
    address contract_,
    bytes32 /*storageSlot*/
  ) public view virtual override returns (uint256 assets) {
    return _cToken.balanceOf(contract_);
  }

  function withdraw(bytes32 /*storageSlot*/, uint256 assets) external virtual override onlyDelegCall {
    _cToken.withdraw(_baseToken, assets);
  }

  function deposit(bytes32 /*storageSlot*/, uint256 assets) external virtual override onlyDelegCall {
    _supply(assets);
  }

  function _supply(uint256 assets) internal {
    IERC20(_baseToken).approve(address(_cToken), assets);
    _cToken.supply(_baseToken, assets);
  }

  function harvestRewards(bytes32 storageSlot, uint256 price) external onlyDelegCall onlyRole(HARVEST_ROLE) {
    (address reward, , ) = _rewardsManager.rewardConfig(address(_cToken));
    if (reward == address(0)) return;
    _rewardsManager.claim(address(_cToken), address(this), true);

    SwapLibrary.SwapConfig memory swapConfig = abi.decode(
      StorageSlot.getBytesSlot(storageSlot).value,
      (SwapLibrary.SwapConfig)
    );

    uint256 earned = IERC20(reward).balanceOf(address(this));
    uint256 reinvestAmount = swapConfig.exactInput(reward, _baseToken, earned, price);
    _supply(reinvestAmount);
    emit RewardsClaimed(reward, earned, reinvestAmount);
  }

  function setSwapConfig(
    bytes32 storageSlot,
    SwapLibrary.SwapConfig calldata swapConfig_
  ) external onlyDelegCall onlyRole(SWAP_ADMIN_ROLE) {
    swapConfig_.validate();
    emit SwapConfigChanged(_getSwapConfig(address(this), storageSlot), swapConfig_);
    StorageSlot.getBytesSlot(storageSlot).value = abi.encode(swapConfig_);
  }

  function _getSwapConfig(
    address contract_,
    bytes32 storageSlot
  ) internal view returns (SwapLibrary.SwapConfig memory) {
    bytes memory swapConfigAsBytes = IExposeStorage(contract_).getBytesSlot(storageSlot);
    return abi.decode(swapConfigAsBytes, (SwapLibrary.SwapConfig));
  }

  function getSwapConfig(address contract_, bytes32 storageSlot) public view returns (SwapLibrary.SwapConfig memory) {
    return _getSwapConfig(contract_, storageSlot);
  }

  function forwardAllowed(bytes4 selector) external view returns (bool) {
    return (selector == CompoundV3InvestStrategy.harvestRewards.selector ||
      selector == CompoundV3InvestStrategy.setSwapConfig.selector);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[47] private __gap;
}
