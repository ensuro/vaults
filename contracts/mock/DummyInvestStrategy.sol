// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {IInvestStrategy} from "../interfaces/IInvestStrategy.sol";

contract DummyInvestStrategy is IInvestStrategy {
  IERC20 internal immutable _asset;

  event Deposit(uint256 assets);
  event Withdraw(uint256 assets);
  event Disconnect(bool force);
  event Connect(bytes initData);
  event SetFail(bool fail);

  error Fail(string where);

  enum ForwardMethods {
    setFail
  }

  constructor(IERC20 asset_) {
    _asset = asset_;
  }

  function connect(bytes32 storageSlot, bytes memory initData) external override {
    bool fail = abi.decode(initData, (bool));
    StorageSlot.getBooleanSlot(storageSlot).value = fail;
    if (fail) revert Fail("connect");
    emit Connect(initData);
  }

  function disconnect(bytes32 storageSlot, bool force) external override {
    if (StorageSlot.getBooleanSlot(storageSlot).value) revert Fail("disconnect");
    emit Disconnect(force);
  }

  function maxWithdraw(address contract_, bytes32) public view virtual override returns (uint256) {
    return _asset.balanceOf(contract_);
  }

  function maxDeposit(address, bytes32) public pure virtual override returns (uint256) {
    return type(uint256).max;
  }

  function totalAssets(address contract_, bytes32) public view virtual override returns (uint256 assets) {
    return _asset.balanceOf(contract_);
  }

  function withdraw(bytes32 storageSlot, uint256 assets) external override {
    if (StorageSlot.getBooleanSlot(storageSlot).value) revert Fail("withdraw");
    emit Withdraw(assets);
  }

  function deposit(bytes32 storageSlot, uint256 assets) external override {
    if (StorageSlot.getBooleanSlot(storageSlot).value) revert Fail("deposit");
    emit Deposit(assets);
  }

  function forwardEntryPoint(bytes32 storageSlot, uint8 method, bytes memory params) external returns (bytes memory) {
    ForwardMethods checkedMethod = ForwardMethods(method);
    if (checkedMethod == ForwardMethods.setFail) {
      bool fail = abi.decode(params, (bool));
      StorageSlot.getBooleanSlot(storageSlot).value = fail;
      emit SetFail(fail);
    }
    return bytes("");
  }
}
