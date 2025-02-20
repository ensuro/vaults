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
 * @title SwapStableInvestStrategy
 * @dev Strategy that invests/deinvests by swapping into another token that has a stable price compared to the asset.
 *      Useful for yield bearing rebasing tokens like Lido o USDM
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SwapStableInvestStrategy is IInvestStrategy {
  using SwapLibrary for SwapLibrary.SwapConfig;

  bytes32 public constant SWAP_ADMIN_ROLE = keccak256("SWAP_ADMIN_ROLE");
  uint256 public constant WAD = 1e18;

  address private immutable __self = address(this);
  bytes32 public immutable storageSlot = InvestStrategyClient.makeStorageSlot(this);

  IERC20Metadata internal immutable _asset;
  IERC20Metadata internal immutable _investAsset;
  uint256 internal immutable _price; // One unit of _investAsset in _asset  (in Wad), units: (asset/investAsset)

  event SwapConfigChanged(SwapLibrary.SwapConfig oldConfig, SwapLibrary.SwapConfig newConfig);

  error CanBeCalledOnlyThroughDelegateCall();
  error CannotDisconnectWithAssets();
  error NoExtraDataAllowed();

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
   * @param price_ Approximate amount of units of _asset required to acquire a unit of _investAsset
   */
  constructor(IERC20Metadata asset_, IERC20Metadata investAsset_, uint256 price_) {
    _asset = asset_;
    _investAsset = investAsset_;
    _price = price_;
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
    if (!force && _investAsset.balanceOf(address(this)) != 0) revert CannotDisconnectWithAssets();
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

  function _convertAssets(uint256 investAssets, address contract_) internal view virtual returns (uint256 assets) {
    return
      Math.mulDiv(
        Math.mulDiv(investAssets * _toWadFactor(_investAsset), _price, WAD),
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
   * @dev Withdraws the amount of assets given from the strategy swapping _investAsset to _asset, to do this swap it calculates the price for conversion.
   *      This function can only be called through delegatecall.
   * @param assets Amount of assets to be withdrawn.
   */
  function withdraw(uint256 assets) public virtual override onlyDelegCall {
    if (assets == 0) return;
    SwapLibrary.SwapConfig memory swapConfig = abi.decode(
      StorageSlot.getBytesSlot(storageSlot).value,
      (SwapLibrary.SwapConfig)
    );
    // swapLibrary expects a price expressed in tokenOut/tokenIn - OK since price is in _investAsset/_price
    uint256 price = Math.mulDiv(WAD, WAD, _price); // 1/_price - Units: investAsset/asset
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
   * @dev Deposit the amount of assets given into the strategy swapping _asset to _investAsset, this swap is done using the exchange rate given by _price.
   *
   * @param assets Amount of assets to be deposited.
   */
  function deposit(uint256 assets) public virtual override onlyDelegCall {
    if (assets == 0) return;
    SwapLibrary.SwapConfig memory swapConfig = abi.decode(
      StorageSlot.getBytesSlot(storageSlot).value,
      (SwapLibrary.SwapConfig)
    );
    // swapLibrary expects a price expressed in tokenOut/tokenIn - OK since _price is in _asset/_investAsset
    swapConfig.exactInput(address(_asset), address(_investAsset), assets, _price);
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
    if (checkedMethod == ForwardMethods.setSwapConfig) {
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

  /**
   * @dev Returns the swap configuration of the given contract. It uses the internal function _getSwapConfig that returns the decoded swap configuration structure.
   *
   * @param contract_ Address of the contract configuration being requested.
   */
  function getSwapConfig(address contract_) public view returns (SwapLibrary.SwapConfig memory) {
    return _getSwapConfig(contract_);
  }
}
