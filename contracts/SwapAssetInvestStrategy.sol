// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {SwapLibrary} from "@ensuro/swaplibrary/contracts/SwapLibrary.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IExposeStorage} from "./interfaces/IExposeStorage.sol";
import {InvestStrategyClient} from "./InvestStrategyClient.sol";

/**
 * @title SwapAssetInvestStrategy
 * @dev Strategy that invests/deinvests by swapping into another token. Abstract contract, childs must define how
 *      to get the swap price.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract SwapAssetInvestStrategy is IInvestStrategy {
  using SwapLibrary for SwapLibrary.SwapConfig;

  uint256 internal constant WAD = 1e18;

  address internal immutable __self = address(this);
  bytes32 public immutable storageSlot = InvestStrategyClient.makeStorageSlot(this);

  IERC20Metadata internal immutable _asset;
  IERC20Metadata internal immutable _investAsset;

  event SwapConfigChanged(SwapLibrary.SwapConfig oldConfig, SwapLibrary.SwapConfig newConfig);

  error CanBeCalledOnlyThroughDelegateCall();
  error CannotDisconnectWithAssets();
  error NoExtraDataAllowed();
  error InvalidAsset();

  enum ForwardMethods {
    setSwapConfig
  }

  modifier onlyDelegCall() {
    if (address(this) == __self) revert CanBeCalledOnlyThroughDelegateCall();
    _;
  }

  /**
   * @dev Constructor of the strategy
   *
   * @param asset_ The address of the underlying token used for accounting, depositing, and withdrawing.
   * @param investAsset_ The address of the tokens hold by the strategy. Typically a rebasing yield bearing token
   */
  constructor(IERC20Metadata asset_, IERC20Metadata investAsset_) {
    require(asset_.decimals() <= 18, InvalidAsset());
    require(investAsset_.decimals() <= 18, InvalidAsset());
    require(asset_ != investAsset_, InvalidAsset());
    _asset = asset_;
    _investAsset = investAsset_;
  }

  function _toWadFactor(IERC20Metadata token) internal view returns (uint256) {
    return 10 ** (18 - token.decimals());
  }

  /// @inheritdoc IInvestStrategy
  function connect(bytes memory initData) external virtual override onlyDelegCall {
    _setSwapConfig(SwapLibrary.SwapConfig(SwapLibrary.SwapProtocol.undefined, 0, bytes("")), initData);
  }

  /// @inheritdoc IInvestStrategy
  function disconnect(bool force) external virtual override onlyDelegCall {
    if (!force && totalAssets(address(this)) != 0) revert CannotDisconnectWithAssets();
  }

  /// @inheritdoc IInvestStrategy
  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    return totalAssets(contract_); // TODO: check how much can be swapped without breaking the slippage
  }

  /// @inheritdoc IInvestStrategy
  function maxDeposit(address /*contract_*/) public view virtual override returns (uint256) {
    return type(uint256).max; // TODO: check how much can be swapped without breaking the slippage
  }

  /// @inheritdoc IInvestStrategy
  function asset(address) public view virtual override returns (address) {
    return address(_asset);
  }

  /**
   * @dev Returns the address of the asset invested in the strategy.
   */
  function investAsset(address) public view returns (address) {
    return address(_investAsset);
  }

  /**
   * @dev Returns the amount of `asset()` required to acquire one unit of `investAsset()` or the amount of `asset()`
   *      that should be received by selling a unit of `investAsset()`. It doesn't consider slippage.
   *
   * @return The amount is expressed in WAD (18 decimals), units: (asset/investAsset)
   */
  function investAssetPrice() public view virtual returns (uint256);

  function sellInvestAssetPrice() internal view returns (uint256) {
    return Math.mulDiv(WAD, WAD, investAssetPrice()); // 1/investAssetPrice() - Units: investAsset/asset
  }

  /**
   * @dev Converts a given amount of investAssets into assets, considering the difference in decimals and the
   *      maxSlippage accepted
   *
   * @param investAssets Amount in investAssets
   * @param contract_ The address of the vault, not used in the implementation, but it might be required by
   *                  inheriting contracts.
   * @return assets The minimum amount in assets that will result from swapping `investAssets`
   */
  function _convertAssets(uint256 investAssets, address contract_) internal view virtual returns (uint256 assets) {
    return
      Math.mulDiv(
        Math.mulDiv(investAssets * _toWadFactor(_investAsset), investAssetPrice(), WAD),
        WAD - _getSwapConfig(contract_).maxSlippage,
        WAD
      ) / _toWadFactor(_asset);
  }

  /// @inheritdoc IInvestStrategy
  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    return _convertAssets(_investAsset.balanceOf(contract_), contract_);
  }

  /// @inheritdoc IInvestStrategy
  /**
   * @dev Withdraws the amount of assets given from the strategy swapping _investAsset to _asset
   *
   * @param assets Amount of assets to be withdrawn.
   */
  function withdraw(uint256 assets) public virtual override onlyDelegCall {
    if (assets == 0) return;
    SwapLibrary.SwapConfig memory swapConfig = _getSwapConfigSelf();
    uint256 price = sellInvestAssetPrice();
    if (assets >= _convertAssets(_investAsset.balanceOf(address(this)), address(this))) {
      // When the intention is to withdraw all the strategy assets, I convert all the _investAsset.
      // This might result in more assets, but it's fine, better than leaving extra _investAsset in the strategy
      swapConfig.exactInput(address(_investAsset), address(_asset), _investAsset.balanceOf(address(this)), price);
    } else {
      swapConfig.exactOutput(address(_investAsset), address(_asset), assets, price);
    }
  }

  /// @inheritdoc IInvestStrategy
  /**
   * @dev Deposit the amount of assets given into the strategy by swapping _asset to _investAsset
   *
   * @param assets Amount of assets to be deposited.
   */
  function deposit(uint256 assets) public virtual override onlyDelegCall {
    if (assets == 0) return;
    // swapLibrary expects a price expressed in tokenOut/tokenIn - OK since investAssetPrice() is in _asset/_investAsset
    _getSwapConfigSelf().exactInput(address(_asset), address(_investAsset), assets, investAssetPrice());
  }

  function _setSwapConfig(SwapLibrary.SwapConfig memory oldSwapConfig, bytes memory newSwapConfigAsBytes) internal {
    SwapLibrary.SwapConfig memory swapConfig = abi.decode(newSwapConfigAsBytes, (SwapLibrary.SwapConfig));
    swapConfig.validate();
    if (abi.encode(swapConfig).length != newSwapConfigAsBytes.length) revert NoExtraDataAllowed();
    emit SwapConfigChanged(oldSwapConfig, swapConfig);
    StorageSlot.getBytesSlot(storageSlot).value = newSwapConfigAsBytes;
  }

  /// @inheritdoc IInvestStrategy
  function forwardEntryPoint(uint8 method, bytes memory params) public virtual onlyDelegCall returns (bytes memory) {
    ForwardMethods checkedMethod = ForwardMethods(method);
    if (checkedMethod == ForwardMethods.setSwapConfig) {
      // The change of the swap config, that involves both the DEX to use and the maxSlippage is a critical operation
      // that should be access controlled, probably imposing timelocks, because it can produce a conversion of the
      // assets at a non-fair price
      _setSwapConfig(_getSwapConfig(address(this)), params);
    }
    // Should never reach to this revert, since method should be one of the enum values but leave it in case
    // we add new values in the enum and we forgot to add them here
    // solhint-disable-next-line gas-custom-errors,reason-string
    else revert();

    return bytes("");
  }

  function _getSwapConfig(address contract_) internal view returns (SwapLibrary.SwapConfig memory) {
    bytes memory swapConfigAsBytes = IExposeStorage(contract_).getBytesSlot(storageSlot);
    return abi.decode(swapConfigAsBytes, (SwapLibrary.SwapConfig));
  }

  function _getSwapConfigSelf() internal view returns (SwapLibrary.SwapConfig memory) {
    return abi.decode(StorageSlot.getBytesSlot(storageSlot).value, (SwapLibrary.SwapConfig));
  }

  /**
   * @dev Returns the swap configuration of the given contract.
   *
   * @param contract_ Address of the vault contract
   */
  function getSwapConfig(address contract_) public view returns (SwapLibrary.SwapConfig memory) {
    return _getSwapConfig(contract_);
  }
}
