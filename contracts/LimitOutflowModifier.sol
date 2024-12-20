// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Proxy} from "@openzeppelin/contracts/proxy/Proxy.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title LimitOutflowModifier
 * @dev Implementation contract that sits in the middle between the proxy and the implementation contract of
 *      an ERC-4626 contract and checks if the net outflows in a given timeframe exceeded a given threshold.
 *
 *      The check is executed before any withdraw/redeem operation, and the outflows are recorded on each
 *      withdraw/redeem/mint/deposit methods. The amounts are computed from the first parameter of these methods
 *      calls (expressed in assets or shares), without considering the actual assets transferred.
 *
 *      This means, this assumes the underlying ERC-4626 works well.
 *
 *      The limit is applied for TWO `slotSize` periods. So for example if slotSize=1 day and limit=100K, this means
 *      that up to 100K of outflows every two calendar days are acceptable.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract LimitOutflowModifier is Proxy {
  using Address for address;
  using SafeCast for uint256;

  address public immutable VAULT;

  type SlotIndex is uint256; // slotSize << 128 + block.timestamp / slotSize

  // @custom:storage-location erc7201:ensuro.storage.LimitOutflowModifier
  struct LOMStorage {
    uint128 slotSize; // Duration in seconds of the time slots
    uint128 limit; // Limit of outflows in a given slot + the previous one
    mapping(SlotIndex => int256) assetsDelta; // Variation in assets in a given slot
  }

  enum MethodType {
    other,
    enter,
    exit
  }

  event LimitChanged(uint256 slotSize, uint256 newLimit);
  event DeltaManuallySet(SlotIndex slot, int256 oldDelta, int256 newDelta);

  error LimitReached(int256 assetsDelta, uint256 limit);

  // keccak256(abi.encode(uint256(keccak256("ensuro.storage.LimitOutflowModifier")) - 1)) & ~bytes32(uint256(0xff))
  bytes32 private constant STORAGE_LOCATION = 0x0c147463594770c228964940e3a69f233ddf647014df668242e963bf18053800;

  function _getLOMStorage() private pure returns (LOMStorage storage $) {
    // solhint-disable-next-line no-inline-assembly
    assembly {
      $.slot := STORAGE_LOCATION
    }
  }

  constructor(address implementation) {
    VAULT = implementation;
  }

  // I don't define initialize method, because I want to pass it through to the vault.

  /**
   * @dev Changes the limit and the timeframe used to track it.
   *
   * @notice This method doesn't have built-in access control. The access control validation is supposed to be
   *         implemented by the proxy. But this SHOULDN'T be publicly available.
   *
   * @param slotSize The duration in seconds of the timeframe used to limit the amount of outflows.
   * @param limit    The max amount of outflows that will be allowed in a given time slot.
   */
  // solhint-disable-next-line func-name-mixedcase
  function LOM__setLimit(uint256 slotSize, uint256 limit) external {
    _getLOMStorage().limit = limit.toUint128();
    _getLOMStorage().slotSize = slotSize.toUint128();
    emit LimitChanged(slotSize, limit);
  }

  // solhint-disable-next-line func-name-mixedcase
  function LOM__getSlotSize() external view returns (uint256) {
    return _getLOMStorage().slotSize;
  }

  // solhint-disable-next-line func-name-mixedcase
  function LOM__getLimit() external view returns (uint256) {
    return _getLOMStorage().limit;
  }

  // solhint-disable-next-line func-name-mixedcase
  function LOM__getAssetsDelta(SlotIndex slot) external view returns (int256) {
    return _getLOMStorage().assetsDelta[slot];
  }

  // solhint-disable-next-line func-name-mixedcase
  function LOM__makeSlot(uint256 slotSize, uint40 timestamp) external pure returns (SlotIndex) {
    return SlotIndex.wrap((slotSize << 128) + timestamp / slotSize);
  }

  /**
   * @dev Manually changes the delta in a given slot. Used to exceptionally allow or disallow limits different than
   *      the configured ones or to reset the limit when a valid operation is verified.
   *
   * @notice This method doesn't have built-in access control. The access control validation is supposed to be
   *         implemented by the proxy. But this SHOULDN'T be publicly available.
   *
   * @param slot Identification of the slot to modify.
   *             The slot is computed as `slotSize << 128 + block.timestamp / slotSize`
   * @param newDelta The delta in assets to store in a given slot
   */
  // solhint-disable-next-line func-name-mixedcase
  function LOM__changeDelta(SlotIndex slot, int256 deltaChange) external returns (int256 newDelta) {
    int256 oldDelta = _getLOMStorage().assetsDelta[slot];
    newDelta = _getLOMStorage().assetsDelta[slot] += deltaChange;
    emit DeltaManuallySet(slot, oldDelta, newDelta);
  }

  function _implementation() internal view virtual override returns (address) {
    return VAULT;
  }

  function _slotIndex() internal view returns (SlotIndex) {
    uint256 slotSize = _getLOMStorage().slotSize;
    return SlotIndex.wrap((slotSize << 128) + block.timestamp / slotSize);
  }

  function _methodType(bytes4 selector) internal pure returns (MethodType) {
    if (selector == IERC4626.withdraw.selector || selector == IERC4626.redeem.selector) return MethodType.exit;
    if (selector == IERC4626.mint.selector || selector == IERC4626.deposit.selector) return MethodType.enter;
    return MethodType.other;
  }

  function _convertToAssets(uint256 shares) internal returns (uint256) {
    bytes memory result = VAULT.functionDelegateCall(abi.encodeWithSelector(IERC4626.convertToAssets.selector, shares));
    return abi.decode(result, (uint256));
  }

  function _computeAssetsDelta() internal returns (int256) {
    bytes4 selector = bytes4(msg.data[0:4]);
    uint256 amount = abi.decode(msg.data[4:36], (uint256));
    if (selector == IERC4626.withdraw.selector) return -int256(amount);
    if (selector == IERC4626.redeem.selector) return -int256(_convertToAssets(amount));
    if (selector == IERC4626.mint.selector) return int256(_convertToAssets(amount));
    // then --> (selector == IERC4626.deposit.selector)
    return int256(amount);
  }

  function _fallback() internal override {
    MethodType methodType = _methodType(bytes4(msg.data[0:4]));
    // If some of the enter/exit methods called, updates
    if (methodType != MethodType.other) {
      // Computes how much assets will change and if the change exceeds the threshold fails before calling
      // the implementation
      SlotIndex slot = _slotIndex();
      int256 assetsDelta = _computeAssetsDelta();
      if (assetsDelta < 0) {
        // Checks limit not reached
        SlotIndex prevSlot = SlotIndex.wrap(SlotIndex.unwrap(slot) - 1);
        int256 deltaLastTwoSlots = assetsDelta +
          _getLOMStorage().assetsDelta[slot] +
          _getLOMStorage().assetsDelta[prevSlot];
        // To check the limit, uses TWO slots, the current one and the previous one. This is to avoid someone doing
        // several operations in the slot limit, like withdrawal at 11:59PM and another withdrawal at 12:01 AM.
        if (deltaLastTwoSlots < 0 && uint256(-deltaLastTwoSlots) > _getLOMStorage().limit)
          revert LimitReached(deltaLastTwoSlots, _getLOMStorage().limit);
      }
      _getLOMStorage().assetsDelta[slot] += assetsDelta;
    }
    super._fallback();
  }
}
