// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {AccessManagedMSV} from "./AccessManagedMSV.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title OutflowLimitedAMMSV
 * @dev Variant of the AccessManagedMSV that has protection to limit the amount of outflows in a given timeframe.
 *
 *      Reverts if net outflows in a given timeframe exceeded a given threshold.
 *
 *      The check is executed before any withdraw/redeem operation, and the outflows are recorded on each
 *      withdraw/redeem/mint/deposit methods.
 *
 *      The limit is applied for TWO `slotSize` periods. So for example if slotSize=1 day and limit=100K, this means
 *      that up to 100K of outflows every two consecutive calendar days are acceptable.

 *      The vault MUST be deployed behind an AccessManagedProxy that controls the access to the critical methods
 *      Since this contract DOESN'T DO ANY ACCESS CONTROL.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract OutflowLimitedAMMSV is AccessManagedMSV {
  using SafeCast for uint256;

  type SlotIndex is uint256; // slotSize << 128 + block.timestamp / slotSize

  // @custom:storage-location erc7201:ensuro.storage.OutflowLimitedAMMSV
  struct LOMStorage {
    uint128 slotSize; // Duration in seconds of the time slots
    uint128 limit; // Limit of outflows in a given slot + the previous one
    mapping(SlotIndex => int256) assetsDelta; // Variation in assets in a given slot
  }

  event LimitChanged(uint256 slotSize, uint256 newLimit);
  event DeltaManuallySet(SlotIndex slot, int256 oldDelta, int256 newDelta);

  error LimitReached(int256 assetsDelta, uint256 limit);

  // keccak256(abi.encode(uint256(keccak256("ensuro.storage.OutflowLimitedAMMSV")) - 1)) & ~bytes32(uint256(0xff))
  bytes32 private constant STORAGE_LOCATION = 0xa2ada5d673dba5eecea7c7503ee87e29913d0d36ae093e950d632f7b86891f00;

  function _getLOMStorage() private pure returns (LOMStorage storage $) {
    // solhint-disable-next-line no-inline-assembly
    assembly {
      $.slot := STORAGE_LOCATION
    }
  }

  /**
   * @dev Changes the limit and the timeframe used to track it.
   *
   * @param slotSize The duration in seconds of the timeframe used to limit the amount of outflows.
   * @param limit    The max amount of outflows that will be allowed in a given time slot.
   */
  function setupOutflowLimit(uint256 slotSize, uint256 limit) external {
    LOMStorage storage $ = _getLOMStorage();
    $.limit = limit.toUint128();
    $.slotSize = slotSize.toUint128();
    emit LimitChanged(slotSize, limit);
  }

  /**
   * @dev Returns the current time slot size in seconds.
   */
  function getOutflowLimitSlotSize() external view returns (uint256) {
    return _getLOMStorage().slotSize;
  }

  /**
   * @dev Returns the net outflow limit that will be applied on two consecutive time slots
   */
  function getOutflowLimit() external view returns (uint256) {
    return _getLOMStorage().limit;
  }

  /**
   * @dev The current delta variation in assets for the given slot.
   *      Calculated as the sum of limit + deposits - withdrawals.
   * @param slot The given slot to check the delta. Compatible with the slot calculated by makeOutflowSlot.
   * @return The net flows in a slot (positive for inflows, more deposits than withdrawals, negative otherwise)
   */
  function getAssetsDelta(SlotIndex slot) external view returns (int256) {
    return _getLOMStorage().assetsDelta[slot];
  }

  /**
   * @dev Computes the SlotIndex datatype comining both the slotSize and the index in which the timestamp is in
   *      a line of time that starts at epoch, with slots of slotSize
   *
   * @param slotSize The size of the slot in seconds that splits the timeline
   * @param timestamp The time for which we want to calculate the slot.
   * @return Returns a SlotIndex datatype that's the combination of the slotSize and the index in which the timestamp
   *         falls
   */
  function makeOutflowSlot(uint256 slotSize, uint40 timestamp) external pure returns (SlotIndex) {
    return SlotIndex.wrap((slotSize << 128) + timestamp / slotSize);
  }

  /**
   * @dev Manually changes the delta in a given slot. Used to exceptionally allow or disallow limits different than
   *      the configured ones or to reset the limit when a valid operation is verified.
   *
   * @param slot Identification of the slot to modify.
   *             The slot is computed as `slotSize << 128 + block.timestamp / slotSize` (See {makeOutflowSlot})
   * @param deltaChange The modification to apply to the registered inflows in a given slot. Positive to increase the
   *                    inflows, negative to decrease the outflows.
   * @return newDelta The resulting delta in the slot after applying the change
   */
  function changeDelta(SlotIndex slot, int256 deltaChange) external returns (int256 newDelta) {
    int256 oldDelta = _getLOMStorage().assetsDelta[slot];
    newDelta = _getLOMStorage().assetsDelta[slot] += deltaChange;
    emit DeltaManuallySet(slot, oldDelta, newDelta);
  }

  function _slotIndex() internal view returns (SlotIndex) {
    uint256 slotSize = _getLOMStorage().slotSize;
    return SlotIndex.wrap((slotSize << 128) + block.timestamp / slotSize);
  }

  /// @inheritdoc ERC4626Upgradeable
  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    SlotIndex slot = _slotIndex();

    // Check delta doesn't exceed the threshold
    SlotIndex prevSlot = SlotIndex.wrap(SlotIndex.unwrap(slot) - 1);
    LOMStorage storage $ = _getLOMStorage();
    int256 deltaLastTwoSlots = -int256(assets) + $.assetsDelta[slot] + $.assetsDelta[prevSlot];
    // To check the limit, uses TWO slots, the current one and the previous one. This is to avoid someone doing
    // several operations in the slot limit, like withdrawal at 11:59PM and another withdrawal at 12:01 AM.
    if (deltaLastTwoSlots < 0 && uint256(-deltaLastTwoSlots) > $.limit) revert LimitReached(deltaLastTwoSlots, $.limit);

    // Update the delta and pass the message to parent contract
    $.assetsDelta[slot] -= assets.toInt256();
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  /// @inheritdoc ERC4626Upgradeable
  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    // Just update the delta and pass the message to parent contract
    SlotIndex slot = _slotIndex();
    _getLOMStorage().assetsDelta[slot] += assets.toInt256();
    super._deposit(caller, receiver, assets, shares);
  }
}
