// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {IInvestStrategy} from "../interfaces/IInvestStrategy.sol";
import {IExposeStorage} from "../interfaces/IExposeStorage.sol";

contract DummyInvestStrategy is IInvestStrategy {
  address private immutable __self = address(this);
  IERC20 internal immutable _asset;

  error Fail(string where);

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
  }

  function connect(bytes32 storageSlot, bytes memory initData) external override {
    DummyStorage memory fail = abi.decode(initData, (DummyStorage));
    StorageSlot.getBytesSlot(storageSlot).value = initData;
    if (fail.failConnect) revert Fail("connect");
    emit Connect(initData);
  }

  function _getStorage(bytes32 storageSlot) internal view returns (DummyStorage memory) {
    return abi.decode(StorageSlot.getBytesSlot(storageSlot).value, (DummyStorage));
  }

  function _getStorageForViews(address contract_, bytes32 storageSlot) internal view returns (DummyStorage memory) {
    return abi.decode(IExposeStorage(contract_).getBytesSlot(storageSlot), (DummyStorage));
  }

  function disconnect(bytes32 storageSlot, bool force) external override {
    if (_getStorage(storageSlot).failDisconnect) revert Fail("disconnect");
    emit Disconnect(force);
  }

  function maxWithdraw(address contract_, bytes32 storageSlot) public view virtual override returns (uint256) {
    if (_getStorageForViews(contract_, storageSlot).failWithdraw) return 0;
    return _asset.balanceOf(contract_);
  }

  function maxDeposit(address contract_, bytes32 storageSlot) public view virtual override returns (uint256) {
    if (_getStorageForViews(contract_, storageSlot).failDeposit) return 0;
    return type(uint256).max;
  }

  function totalAssets(address contract_, bytes32) public view virtual override returns (uint256 assets) {
    return _asset.balanceOf(contract_);
  }

  function withdraw(bytes32 storageSlot, uint256 assets) external override {
    if (_getStorage(storageSlot).failWithdraw) revert Fail("withdraw");
    emit Withdraw(assets);
  }

  function deposit(bytes32 storageSlot, uint256 assets) external override {
    if (_getStorage(storageSlot).failDeposit) revert Fail("deposit");
    emit Deposit(assets);
  }

  function forwardEntryPoint(bytes32 storageSlot, uint8 method, bytes memory params) external returns (bytes memory) {
    ForwardMethods checkedMethod = ForwardMethods(method);
    if (checkedMethod == ForwardMethods.setFail) {
      DummyStorage memory fail = abi.decode(params, (DummyStorage));
      StorageSlot.getBytesSlot(storageSlot).value = params;
      emit SetFail(fail);
    }
    return bytes("");
  }

  function getFail(address contract_, bytes32 storageSlot) external view returns (DummyStorage memory) {
    return _getStorageForViews(contract_, storageSlot);
  }
}
