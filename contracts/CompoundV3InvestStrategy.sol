// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ICompoundV3} from "./dependencies/compound-v3/ICompoundV3.sol";
import {ICometRewards} from "./dependencies/compound-v3/ICometRewards.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SwapLibrary} from "@ensuro/swaplibrary/contracts/SwapLibrary.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {IExposeStorage} from "./interfaces/IExposeStorage.sol";
import {InvestStrategyClient} from "./InvestStrategyClient.sol";

/**
 * @title CompoundV3InvestStrategy
 * @dev Strategy that invests/deinvests into CompoundV3 on each deposit/withdraw. Also, has a method to claim the rewards,
 *      swap them, and reinvests the result into CompoundV3.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract CompoundV3InvestStrategy is IInvestStrategy {
  using SwapLibrary for SwapLibrary.SwapConfig;

  bytes32 public constant HARVEST_ROLE = keccak256("HARVEST_ROLE");
  bytes32 public constant SWAP_ADMIN_ROLE = keccak256("SWAP_ADMIN_ROLE");

  address private immutable __self = address(this);
  bytes32 public immutable storageSlot = InvestStrategyClient.makeStorageSlot(this);

  ICompoundV3 internal immutable _cToken;
  ICometRewards internal immutable _rewardsManager;
  address internal immutable _baseToken;

  event RewardsClaimed(address token, uint256 rewards, uint256 receivedInAsset);

  event SwapConfigChanged(SwapLibrary.SwapConfig oldConfig, SwapLibrary.SwapConfig newConfig);

  error CanBeCalledOnlyThroughDelegateCall();
  error CannotDisconnectWithAssets();
  error NoExtraDataAllowed();

  enum ForwardMethods {
    harvestRewards,
    setSwapConfig
  }

  modifier onlyDelegCall() {
    if (address(this) == __self) revert CanBeCalledOnlyThroughDelegateCall();
    _;
  }

  constructor(ICompoundV3 cToken_, ICometRewards rewardsManager_) {
    _cToken = cToken_;
    _rewardsManager = rewardsManager_;
    _baseToken = cToken_.baseToken();
  }

  function connect(bytes memory initData) external virtual override onlyDelegCall {
    _setSwapConfig(SwapLibrary.SwapConfig(SwapLibrary.SwapProtocol.undefined, 0, bytes("")), initData);
  }

  function disconnect(bool force) external virtual override onlyDelegCall {
    if (!force && _cToken.balanceOf(address(this)) != 0) revert CannotDisconnectWithAssets();
  }

  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    if (_cToken.isWithdrawPaused()) return 0;
    return _cToken.balanceOf(contract_);
  }

  function maxDeposit(address /*contract_*/) public view virtual override returns (uint256) {
    if (_cToken.isSupplyPaused()) return 0;
    return type(uint256).max;
  }

  function asset(address) public view virtual override returns (address) {
    return _baseToken;
  }

  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    return _cToken.balanceOf(contract_);
  }

  function withdraw(uint256 assets) external virtual override onlyDelegCall {
    _cToken.withdraw(_baseToken, assets);
  }

  function deposit(uint256 assets) external virtual override onlyDelegCall {
    _supply(assets);
  }

  function _supply(uint256 assets) internal {
    IERC20(_baseToken).approve(address(_cToken), assets);
    _cToken.supply(_baseToken, assets);
  }

  function _harvestRewards(uint256 price) internal {
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

  function _setSwapConfig(SwapLibrary.SwapConfig memory oldSwapConfig, bytes memory newSwapConfigAsBytes) internal {
    SwapLibrary.SwapConfig memory swapConfig = abi.decode(newSwapConfigAsBytes, (SwapLibrary.SwapConfig));
    swapConfig.validate();
    if (abi.encode(swapConfig).length != newSwapConfigAsBytes.length) revert NoExtraDataAllowed();
    emit SwapConfigChanged(oldSwapConfig, swapConfig);
    StorageSlot.getBytesSlot(storageSlot).value = newSwapConfigAsBytes;
  }

  function forwardEntryPoint(uint8 method, bytes memory params) external onlyDelegCall returns (bytes memory) {
    ForwardMethods checkedMethod = ForwardMethods(method);
    if (checkedMethod == ForwardMethods.harvestRewards) {
      uint256 price = abi.decode(params, (uint256));
      _harvestRewards(price);
    } else if (checkedMethod == ForwardMethods.setSwapConfig) {
      _setSwapConfig(_getSwapConfig(address(this)), params);
    }
    // Show never reach to this revert, since method should be one of the enum values but leave it in case
    // we add new values in the enum and we forgot to add them here
    // solhint-disable-next-line gas-custom-errors,reason-string
    else revert();

    return bytes("");
  }

  function _getSwapConfig(address contract_) internal view returns (SwapLibrary.SwapConfig memory) {
    bytes memory swapConfigAsBytes = IExposeStorage(contract_).getBytesSlot(storageSlot);
    return abi.decode(swapConfigAsBytes, (SwapLibrary.SwapConfig));
  }

  function getSwapConfig(address contract_) public view returns (SwapLibrary.SwapConfig memory) {
    return _getSwapConfig(contract_);
  }
}
