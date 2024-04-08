// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {IInvestStrategy} from "../interfaces/IInvestStrategy.sol";
import {IExposeStorage} from "../interfaces/IExposeStorage.sol";
import {InvestStrategyClient} from "../InvestStrategyClient.sol";

contract OtherAddress {
  constructor(IERC20 asset_) {
    asset_.approve(msg.sender, type(uint256).max);
  }
}

contract DummyInvestStrategy is IInvestStrategy {
  IERC20 internal immutable _asset;
  address private immutable __self = address(this);
  bytes32 public immutable storageSlot = InvestStrategyClient.makeStorageSlot(this);
  address public immutable other;

  error Fail(string where);
  error NoExtraDataAllowed();

  enum ForwardMethods {
    setFail
  }

  struct DummyStorage {
    bool failConnect;
    bool failDisconnect;
    bool failDeposit;
    bool failWithdraw;
  }

  event Deposit(uint256 assets);
  event Withdraw(uint256 assets);
  event Disconnect(bool force);
  event Connect(bytes initData);
  event SetFail(DummyStorage fail);

  constructor(IERC20 asset_) {
    _asset = asset_;
    other = address(new OtherAddress(asset_));
  }

  function connect(bytes memory initData) external override {
    DummyStorage memory fail = abi.decode(initData, (DummyStorage));
    if (abi.encode(fail).length != initData.length) revert NoExtraDataAllowed();
    StorageSlot.getBytesSlot(storageSlot).value = initData;
    if (fail.failConnect) revert Fail("connect");
    emit Connect(initData);
  }

  function _getStorage() internal view returns (DummyStorage memory) {
    return abi.decode(StorageSlot.getBytesSlot(storageSlot).value, (DummyStorage));
  }

  function _getStorageForViews(address contract_) internal view returns (DummyStorage memory) {
    return abi.decode(IExposeStorage(contract_).getBytesSlot(storageSlot), (DummyStorage));
  }

  function disconnect(bool force) external override {
    if (_getStorage().failDisconnect) revert Fail("disconnect");
    emit Disconnect(force);
  }

  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    if (_getStorageForViews(contract_).failWithdraw) return 0;
    return _asset.balanceOf(other);
  }

  function maxDeposit(address contract_) public view virtual override returns (uint256) {
    if (_getStorageForViews(contract_).failDeposit) return 0;
    return type(uint256).max;
  }

  function totalAssets(address) public view virtual override returns (uint256 assets) {
    return _asset.balanceOf(other);
  }

  function withdraw(uint256 assets) external override {
    if (_getStorage().failWithdraw) revert Fail("withdraw");
    _asset.transferFrom(other, address(this), assets);
    emit Withdraw(assets);
  }

  function deposit(uint256 assets) external override {
    if (_getStorage().failDeposit) revert Fail("deposit");
    _asset.transfer(other, assets);
    emit Deposit(assets);
  }

  function forwardEntryPoint(uint8 method, bytes memory params) external returns (bytes memory) {
    ForwardMethods checkedMethod = ForwardMethods(method);
    if (checkedMethod == ForwardMethods.setFail) {
      DummyStorage memory fail = abi.decode(params, (DummyStorage));
      StorageSlot.getBytesSlot(storageSlot).value = params;
      emit SetFail(fail);
    }
    return bytes("");
  }

  function getFail(address contract_) external view returns (DummyStorage memory) {
    return _getStorageForViews(contract_);
  }
}
