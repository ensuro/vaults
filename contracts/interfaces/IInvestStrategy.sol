// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

interface IInvestStrategy {
  function connect(bytes32 storageSlot, bytes memory initData) external;
  function disconnect(bytes32 storageSlot, bool force) external;
  function deposit(bytes32 storageSlot, uint256 assets) external;
  function withdraw(bytes32 storageSlot, uint256 assets) external;

  // Views
  function totalAssets(address contract_, bytes32 storageSlot) external view returns (uint256 totalManagedAssets);
  function maxDeposit(address contract_, bytes32 storageSlot) external view returns (uint256 maxAssets);
  function maxWithdraw(address contract_, bytes32 storageSlot) external view returns (uint256 maxAssets);

  function forwardAllowed(bytes4 selector) external view returns (bool);
}
