// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
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

  // From OZ v5
  error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
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

  modifier onlyRole(bytes32 role) {
    if (!IAccessControl(address(this)).hasRole(role, msg.sender))
      revert AccessControlUnauthorizedAccount(msg.sender, role);
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

  function connect(bytes memory initData) external virtual override onlyDelegCall {
    _setSwapConfigNoCheck(SwapLibrary.SwapConfig(SwapLibrary.SwapProtocol.undefined, 0, bytes("")), initData);
  }

  function disconnect(bool force) external virtual override onlyDelegCall {
    if (!force && _investAsset.balanceOf(address(this)) != 0) revert CannotDisconnectWithAssets();
  }

  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    return totalAssets(contract_); // TODO: check how much can be swapped without breaking the slippage
  }

  function maxDeposit(address /*contract_*/) public view virtual override returns (uint256) {
    return type(uint256).max; // TODO: check how much can be swapped without breaking the slippage
  }

  function asset(address) public view virtual override returns (address) {
    return address(_asset);
  }

  function investAsset(address) public view returns (address) {
    return address(_investAsset);
  }

  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    return
      Math.mulDiv(
        Math.mulDiv(_investAsset.balanceOf(contract_) * _toWadFactor(_investAsset), _price, WAD),
        WAD - _getSwapConfig(contract_).maxSlippage,
        WAD
      ) / _toWadFactor(_asset);
  }

  function withdraw(uint256 assets) external virtual override onlyDelegCall {
    SwapLibrary.SwapConfig memory swapConfig = abi.decode(
      StorageSlot.getBytesSlot(storageSlot).value,
      (SwapLibrary.SwapConfig)
    );
    uint256 price = Math.mulDiv(WAD, WAD, _price); // 1/_price - Units: investAsset/asset
    // swapLibrary expects a price expressed in tokenOut/tokenIn - OK since price is in _investAsset/_price
    swapConfig.exactOutput(address(_investAsset), address(_asset), assets, price);
  }

  function deposit(uint256 assets) external virtual override onlyDelegCall {
    SwapLibrary.SwapConfig memory swapConfig = abi.decode(
      StorageSlot.getBytesSlot(storageSlot).value,
      (SwapLibrary.SwapConfig)
    );
    // swapLibrary expects a price expressed in tokenOut/tokenIn - OK since _price is in _asset/_investAsset
    swapConfig.exactInput(address(_asset), address(_investAsset), assets, _price);
  }

  function _setSwapConfig(bytes memory newSwapConfigAsBytes) internal onlyRole(SWAP_ADMIN_ROLE) {
    _setSwapConfigNoCheck(_getSwapConfig(address(this)), newSwapConfigAsBytes);
  }

  function _setSwapConfigNoCheck(
    SwapLibrary.SwapConfig memory oldSwapConfig,
    bytes memory newSwapConfigAsBytes
  ) internal {
    SwapLibrary.SwapConfig memory swapConfig = abi.decode(newSwapConfigAsBytes, (SwapLibrary.SwapConfig));
    swapConfig.validate();
    if (abi.encode(swapConfig).length != newSwapConfigAsBytes.length) revert NoExtraDataAllowed();
    emit SwapConfigChanged(oldSwapConfig, swapConfig);
    StorageSlot.getBytesSlot(storageSlot).value = newSwapConfigAsBytes;
  }

  function forwardEntryPoint(uint8 method, bytes memory params) external onlyDelegCall returns (bytes memory) {
    ForwardMethods checkedMethod = ForwardMethods(method);
    if (checkedMethod == ForwardMethods.setSwapConfig) {
      _setSwapConfig(params);
    }
    // Should never reach to this revert, since method should be one of the enum values but leave it in case
    // we add new values in the enum and we forgot to add them here
    // solhint-disable-next-line custom-errors,reason-string
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
