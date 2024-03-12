// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

interface IExposeStorage {
  function getBytes32Slot(bytes32 slot) external view returns (bytes32);
  function getBytesSlot(bytes32 slot) external view returns (bytes memory);
}
