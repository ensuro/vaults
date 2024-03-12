// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IInvestStrategy} from "../interfaces/IInvestStrategy.sol";

contract DummyInvestStrategy is IInvestStrategy {
  IERC20 internal immutable _asset;

  event Deposit(uint256 assets);
  event Withdraw(uint256 assets);
  event Disconnect(bool force);
  event Connect(bytes initData);

  constructor(IERC20 asset_) {
    _asset = asset_;
  }

  function connect(bytes32, bytes memory initData) external override {
    emit Connect(initData);
  }

  function disconnect(bytes32, bool force) external override {
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

  function withdraw(bytes32, uint256 assets) external override {
    emit Withdraw(assets);
  }

  function deposit(bytes32, uint256 assets) external override {
    emit Deposit(assets);
  }

  function forwardEntryPoint(bytes32, uint8, bytes memory) external pure {
    revert("No methods to forward");
  }
}
