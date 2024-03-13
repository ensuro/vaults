// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IExposeStorage
 *
 * @dev Interface for calling contracts to expose the storage, used by views of the strategies if they need to access
 *      the strategy data.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
interface IExposeStorage {
  /**
   * @dev Returns the data stored on a given slot as bytes. The contract can revert if doesn't want to share a
   *      specific slot.
   *
   * @param slot The slot where the data is stored.
   * @return The data in the specified slot as bytes
   */
  function getBytesSlot(bytes32 slot) external view returns (bytes memory);
}
