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
 * @dev Strategy that invests/deinvests into CompoundV3 on each deposit/withdraw. Also, has a method to claim the
 *      rewards, swap them, and reinvests the result into CompoundV3.
 *
 *      The rewards are not accounted in the totalAssets() until they are claimed. It's advised to claim the rewards
 *      frequently, to avoid discrete variations on the returns.
 *
 *      This strategy as the other IInvestStrategy are supposed to be called with delegateCall by a vault, managing
 *      the assets on behalf of the vault.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract CompoundV3InvestStrategy is IInvestStrategy {
  using SwapLibrary for SwapLibrary.SwapConfig;

  address private immutable __self = address(this);
  bytes32 public immutable storageSlot = InvestStrategyClient.makeStorageSlot(this);

  ICompoundV3 internal immutable _cToken;
  ICometRewards internal immutable _rewardsManager;
  address internal immutable _baseToken;

  /**
   * @dev Emitted when the rewards are claimed
   *
   * @param token The token in which the rewards are denominated
   * @param rewards Amount of rewards received (in units of token)
   * @param receivedInAsset Amount of `asset()` received in exchange of the rewards sold
   */
  event RewardsClaimed(address token, uint256 rewards, uint256 receivedInAsset);

  /**
   * @dev Emitted when the swap config is changed. This swap config is used to swap the rewards for assets``
   *
   * @param oldConfig The swap configuration before the change
   * @param newConfig The swap configuration after the change
   */
  event SwapConfigChanged(SwapLibrary.SwapConfig oldConfig, SwapLibrary.SwapConfig newConfig);

  error CanBeCalledOnlyThroughDelegateCall();
  error CannotDisconnectWithAssets();
  error NoExtraDataAllowed();

  /**
   * @dev "Methods" called from the vault to execute different operations on the strategy
   *
   * @enum harvestRewards Used to trigger the claim of rewards and the swap of them for `asset`
   * @enum setSwapConfig Used to change the swap configuration, used for selling the rewards
   */
  enum ForwardMethods {
    harvestRewards,
    setSwapConfig
  }

  modifier onlyDelegCall() {
    if (address(this) == __self) revert CanBeCalledOnlyThroughDelegateCall();
    _;
  }

  /**
   * @dev Constructor of the strategy.
   *
   * @param cToken_ The address of the cToken (compound pool) where funds will be supplied. The strategy asset()
   *                will be `cToken_.baseToken()`.
   * @param rewardsManager_ The address of the rewards manager contract that will be used to claim the rewards
   */
  constructor(ICompoundV3 cToken_, ICometRewards rewardsManager_) {
    _cToken = cToken_;
    _rewardsManager = rewardsManager_;
    _baseToken = cToken_.baseToken();
  }

  /// @inheritdoc IInvestStrategy
  function connect(bytes memory initData) external virtual override onlyDelegCall {
    _setSwapConfig(SwapLibrary.SwapConfig(SwapLibrary.SwapProtocol.undefined, 0, bytes("")), initData);
  }

  /// @inheritdoc IInvestStrategy
  function disconnect(bool force) external virtual override onlyDelegCall {
    if (!force) {
      if (_cToken.balanceOf(address(this)) != 0) revert CannotDisconnectWithAssets();
      ICometRewards.RewardOwed memory owed = _rewardsManager.getRewardOwed(address(_cToken), address(this));
      if (owed.token != address(0) && owed.owed != 0) revert CannotDisconnectWithAssets();
    }
  }

  /// @inheritdoc IInvestStrategy
  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    if (_cToken.isWithdrawPaused()) return 0;
    return _cToken.balanceOf(contract_);
  }

  /// @inheritdoc IInvestStrategy
  function maxDeposit(address /*contract_*/) public view virtual override returns (uint256) {
    if (_cToken.isSupplyPaused()) return 0;
    return type(uint256).max;
  }

  /// @inheritdoc IInvestStrategy
  function asset(address) public view virtual override returns (address) {
    return _baseToken;
  }

  /// @inheritdoc IInvestStrategy
  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    return _cToken.balanceOf(contract_);
  }

  /// @inheritdoc IInvestStrategy
  function withdraw(uint256 assets) external virtual override onlyDelegCall {
    _cToken.withdraw(_baseToken, assets);
  }

  /// @inheritdoc IInvestStrategy
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

  /// @inheritdoc IInvestStrategy
  function forwardEntryPoint(uint8 method, bytes memory params) external onlyDelegCall returns (bytes memory) {
    ForwardMethods checkedMethod = ForwardMethods(method);
    if (checkedMethod == ForwardMethods.harvestRewards) {
      // The harvestRewards receives the price as an input, expressed in wad as the units of the reward token
      // required to by one unit of `asset()`.
      // For example if reward token is COMP and asset is USDC, and price of COMP is $ 100,
      // Then we should receive 0.01 (in wad).
      // This is a permissioned call, and someone giving a wrong price can make the strategy sell the rewards at
      // a zero price. So you should be carefull regarding who can call this method, if rewards are a relevant part
      // of the returns
      uint256 price = abi.decode(params, (uint256));
      _harvestRewards(price);
    } else if (checkedMethod == ForwardMethods.setSwapConfig) {
      // This method receives the new swap config to be used when swapping rewards for asset().
      // A wrong swap config, with high slippage, might affect the conversion rate of the rewards into assets
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

  /**
   * @dev Returns the swap configuration of the given contract. It uses the internal function _getSwapConfig that returns the decoded swap configuration structure.
   *
   * @param contract_ Address of the contract configuration being requested.
   */
  function getSwapConfig(address contract_) public view returns (SwapLibrary.SwapConfig memory) {
    return _getSwapConfig(contract_);
  }
}
