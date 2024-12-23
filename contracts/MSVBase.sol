// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {InvestStrategyClient} from "./InvestStrategyClient.sol";
import {IExposeStorage} from "./interfaces/IExposeStorage.sol";

abstract contract MSVBase is IExposeStorage {
  using InvestStrategyClient for IInvestStrategy;

  uint8 public constant MAX_STRATEGIES = 32;

  uint8[MAX_STRATEGIES] internal _depositQueue;
  uint8[MAX_STRATEGIES] internal _withdrawQueue;
  IInvestStrategy[MAX_STRATEGIES] internal _strategies;

  // Events duplicated here from InvestStrategyClient library, so they go to the ABI
  event StrategyChanged(IInvestStrategy oldStrategy, IInvestStrategy newStrategy);
  event WithdrawFailed(bytes reason);
  event DepositFailed(bytes reason);
  event DisconnectFailed(bytes reason);
  event StrategyAdded(IInvestStrategy indexed strategy, uint8 index);
  event StrategyRemoved(IInvestStrategy indexed strategy, uint8 index);
  event DepositQueueChanged(uint8[] queue);
  event WithdrawQueueChanged(uint8[] queue);
  event Rebalance(IInvestStrategy indexed strategyFrom, IInvestStrategy indexed strategyTo, uint256 amount);

  error InvalidStrategiesLength();
  error InvalidStrategy();
  error DuplicatedStrategy(IInvestStrategy strategy);
  error InvalidStrategyInDepositQueue(uint8 index);
  error InvalidStrategyInWithdrawQueue(uint8 index);
  error WithdrawError();
  error DepositError();
  error OnlyStrategyStorageExposed();
  error CannotRemoveStrategyWithAssets();
  error InvalidQueue();
  error InvalidQueueLength();
  error InvalidQueueIndexDuplicated(uint8 index);
  error RebalanceAmountExceedsMaxDeposit(uint256 max);
  error RebalanceAmountExceedsMaxWithdraw(uint256 max);

  // Must be implemented by the inheriting class
  function _asset() internal view virtual returns (address);

  // solhint-disable-next-line func-name-mixedcase
  function __MSVBase_init_unchained(
    IInvestStrategy[] memory strategies_,
    bytes[] memory initStrategyDatas,
    uint8[] memory depositQueue_,
    uint8[] memory withdrawQueue_
  ) internal {
    if (
      strategies_.length == 0 ||
      strategies_.length > MAX_STRATEGIES ||
      strategies_.length != initStrategyDatas.length ||
      strategies_.length != depositQueue_.length ||
      strategies_.length != withdrawQueue_.length
    ) revert InvalidStrategiesLength();
    bool[MAX_STRATEGIES] memory presentInDeposit;
    bool[MAX_STRATEGIES] memory presentInWithdraw;
    for (uint256 i; i < strategies_.length; i++) {
      if (address(strategies_[i]) == address(0)) revert InvalidStrategy();
      strategies_[i].checkAsset(_asset());
      // Check strategies_[i] not duplicated
      for (uint256 j; j < i; j++) {
        if (strategies_[i] == strategies_[j]) revert DuplicatedStrategy(strategies_[i]);
      }
      // Check depositQueue_[i] and withdrawQueue_[i] not duplicated and within bounds
      if (depositQueue_[i] >= strategies_.length || presentInDeposit[depositQueue_[i]])
        revert InvalidStrategyInDepositQueue(depositQueue_[i]);
      if (withdrawQueue_[i] >= strategies_.length || presentInWithdraw[withdrawQueue_[i]])
        revert InvalidStrategyInWithdrawQueue(withdrawQueue_[i]);
      presentInDeposit[depositQueue_[i]] = true;
      presentInWithdraw[withdrawQueue_[i]] = true;
      _strategies[i] = strategies_[i];
      _depositQueue[i] = depositQueue_[i] + 1; // Adding one, so we know when 0 is end of array
      _withdrawQueue[i] = withdrawQueue_[i] + 1; // Adding one, so we know when 0 is end of array
      strategies_[i].dcConnect(initStrategyDatas[i]);
      emit StrategyAdded(strategies_[i], uint8(i));
    }
    emit DepositQueueChanged(depositQueue_);
    emit WithdrawQueueChanged(withdrawQueue_);
  }

  function _maxWithdrawable(uint256 limit) internal view returns (uint256 ret) {
    for (uint256 i; address(_strategies[i]) != address(0) && i < MAX_STRATEGIES; i++) {
      ret += _strategies[i].maxWithdraw();
      if (ret >= limit) return limit;
    }
    return ret;
  }

  function _maxDepositable() internal view returns (uint256 ret) {
    for (uint256 i; address(_strategies[i]) != address(0) && i < MAX_STRATEGIES; i++) {
      uint256 maxDep = _strategies[i].maxDeposit();
      if (maxDep == type(uint256).max) return maxDep;
      ret += maxDep;
    }
    return ret;
  }

  function _totalAssets() internal view returns (uint256 assets) {
    for (uint256 i; address(_strategies[i]) != address(0) && i < MAX_STRATEGIES; i++) {
      assets += _strategies[i].totalAssets();
    }
  }

  function _withdrawFromStrategies(uint256 assets) internal {
    uint256 left = assets;
    for (uint256 i; left != 0 && _withdrawQueue[i] != 0 && i < MAX_STRATEGIES; i++) {
      IInvestStrategy strategy = _strategies[_withdrawQueue[i] - 1];
      uint256 toWithdraw = Math.min(left, strategy.maxWithdraw());
      if (toWithdraw == 0) continue;
      strategy.dcWithdraw(toWithdraw, false);
      left -= toWithdraw;
    }
    if (left != 0) revert WithdrawError(); // This shouldn't happen, since assets must be <= maxWithdraw(owner)
  }

  function _depositToStrategies(uint256 assets) internal {
    // Transfers the assets from the caller and supplies to compound
    uint256 left = assets;
    for (uint256 i; left != 0 && _depositQueue[i] != 0 && i < MAX_STRATEGIES; i++) {
      IInvestStrategy strategy = _strategies[_depositQueue[i] - 1];
      uint256 toDeposit = Math.min(left, strategy.maxDeposit());
      if (toDeposit == 0) continue;
      strategy.dcDeposit(toDeposit, false);
      left -= toDeposit;
    }
    if (left != 0) revert DepositError(); // This shouldn't happen, since assets must be <= maxDeposit(owner)
  }

  /**
   * @dev Exposes a given slot as a bytes array. To be used by the IInvestStrategy views to access their storage.
   *      Only the slot==strategyStorageSlot() can be accessed.
   */
  function getBytesSlot(bytes32 slot) external view override returns (bytes memory) {
    for (uint256 i; _strategies[i] != IInvestStrategy(address(0)) && i < MAX_STRATEGIES; i++) {
      if (slot == _strategies[i].storageSlot()) {
        StorageSlot.BytesSlot storage r = StorageSlot.getBytesSlot(slot);
        return r.value;
      }
    }
    revert OnlyStrategyStorageExposed();
  }

  /**
   * @dev Used to call specific methods on the strategies. Anyone can call this method, is responsability of the
   *      IInvestStrategy to check access permissions when needed.
   * @param strategyIndex The index of the strategy in the _strategies array
   * @param method Id of the method to call. Is recommended that the strategy defines an enum with the methods that
   *               can be called externally and validates this value.
   * @param extraData Additional parameters sent to the method.
   * @return Returns the output received from the IInvestStrategy.
   */
  function forwardToStrategy(
    uint8 strategyIndex,
    uint8 method,
    bytes memory extraData
  ) external virtual returns (bytes memory) {
    IInvestStrategy strategy = _strategies[strategyIndex];
    if (address(strategy) == address(0)) revert InvalidStrategy();
    return _strategies[strategyIndex].dcForward(method, extraData);
  }

  /**
   * @dev Changes one investment strategy to a new one, keeping the deposit and withdraw queues unaffected.
   *      When this happens, all funds are withdrawn from the old strategy and deposited on the new one.
   *      This reverts if any of this fails, unless the force parameter is true, in that case errors in withdrawal
   *      or deposit are silented.
   * @param strategyIndex The index of the strategy in the _strategies array
   * @param newStrategy The new strategy to plug into the vault
   * @param initStrategyData Initialization parameters for this new strategy
   * @param force Boolean to indicate if errors on withdraw or deposit should be accepted. Normally you should send
   *              this value in `false`. Only use `true` if you know what you are doing and trying to replace a faulty
   *              strategy.
   */
  function replaceStrategy(
    uint8 strategyIndex,
    IInvestStrategy newStrategy,
    bytes memory initStrategyData,
    bool force
  ) public virtual {
    IInvestStrategy strategy = _strategies[strategyIndex];
    if (address(strategy) == address(0)) revert InvalidStrategy();
    for (uint256 i; i < MAX_STRATEGIES && _strategies[i] != IInvestStrategy(address(0)); i++) {
      if (_strategies[i] == newStrategy && i != strategyIndex) revert DuplicatedStrategy(newStrategy);
    }
    InvestStrategyClient.strategyChange(strategy, newStrategy, initStrategyData, IERC20Metadata(_asset()), force);
    _strategies[strategyIndex] = newStrategy;
  }

  /**
   * @dev Adds a new strategy to the vault. The new strategy will be added at the end of the deposit and withdraw
   *      queues.
   * @param newStrategy The new strategy to plug into the vault
   * @param initStrategyData Initialization parameters for this new strategy
   */
  function addStrategy(IInvestStrategy newStrategy, bytes memory initStrategyData) public virtual {
    if (address(newStrategy) == address(0)) revert InvalidStrategy();
    uint256 i;
    for (; i < MAX_STRATEGIES && _strategies[i] != IInvestStrategy(address(0)); i++) {
      if (_strategies[i] == newStrategy) revert DuplicatedStrategy(newStrategy);
    }
    if (i == MAX_STRATEGIES) revert InvalidStrategiesLength();
    _strategies[i] = newStrategy;
    _depositQueue[i] = uint8(i + 1);
    _withdrawQueue[i] = uint8(i + 1);
    newStrategy.checkAsset(_asset());
    newStrategy.dcConnect(initStrategyData);
    emit StrategyAdded(newStrategy, uint8(i));
  }

  /**
   * @dev Remove an strategy from the vault. It's only possible if the strategy doesn't have assets.
   *      The strategy is removed from deposit and withdraw queues
   * @param strategyIndex The index of the strategy in the _strategies array
   * @param force If strategy.disconnect fails, this parameter indicates whether the operation is reverted or not.
   */
  function removeStrategy(uint8 strategyIndex, bool force) public virtual {
    if (strategyIndex >= MAX_STRATEGIES) revert InvalidStrategy();
    IInvestStrategy strategy = _strategies[strategyIndex];
    if (address(strategy) == address(0)) revert InvalidStrategy();
    if (strategy.totalAssets() != 0) revert CannotRemoveStrategyWithAssets();
    // Check isn't removing the last one
    if (strategyIndex == 0 && address(_strategies[1]) == address(0)) revert InvalidStrategiesLength();
    // Shift the following strategies in the array
    uint256 i = strategyIndex + 1;
    for (; i < MAX_STRATEGIES && _strategies[i] != IInvestStrategy(address(0)); i++) {
      _strategies[i - 1] = _strategies[i];
    }
    _strategies[i - 1] = IInvestStrategy(address(0));
    // Shift and change the indexes in the queues
    bool shiftDeposit;
    bool shiftWithdraw;
    for (i = 0; _withdrawQueue[i] != 0 && i < MAX_STRATEGIES; i++) {
      if (shiftWithdraw) {
        // Already saw the deleted index, shift and change index if greater
        _withdrawQueue[i - 1] = _withdrawQueue[i] - ((_withdrawQueue[i] > (strategyIndex + 1)) ? 1 : 0);
      } else {
        if (_withdrawQueue[i] == (strategyIndex + 1)) {
          // Index to delete found, it will be deleted in the next interation
          shiftWithdraw = true;
        } else if (_withdrawQueue[i] > (strategyIndex + 1)) {
          // If index is greater, substract one
          _withdrawQueue[i] -= 1;
        }
      }

      // Same for deposit
      if (shiftDeposit) {
        // Already saw the deleted index, shift and change index if greater
        _depositQueue[i - 1] = _depositQueue[i] - ((_depositQueue[i] > (strategyIndex + 1)) ? 1 : 0);
      } else {
        if (_depositQueue[i] == (strategyIndex + 1)) {
          // Index to delete found, it will be deleted in the next interation
          shiftDeposit = true;
        } else if (_depositQueue[i] > (strategyIndex + 1)) {
          // If index is greater, substract one
          _depositQueue[i] -= 1;
        }
      }
    }
    _depositQueue[i - 1] = 0;
    _withdrawQueue[i - 1] = 0;
    strategy.dcDisconnect(force);
    emit StrategyRemoved(strategy, strategyIndex);
  }

  function changeDepositQueue(uint8[] memory newDepositQueue_) public virtual {
    bool[MAX_STRATEGIES] memory seen;
    uint256 i = 0;
    if (newDepositQueue_.length > MAX_STRATEGIES) revert InvalidQueue();
    for (; i < newDepositQueue_.length; i++) {
      if (newDepositQueue_[i] >= MAX_STRATEGIES || address(_strategies[newDepositQueue_[i]]) == address(0))
        revert InvalidQueue();
      if (seen[newDepositQueue_[i]]) revert InvalidQueueIndexDuplicated(newDepositQueue_[i]);
      seen[newDepositQueue_[i]] = true;
      _depositQueue[i] = newDepositQueue_[i] + 1;
    }
    if (i < MAX_STRATEGIES && address(_strategies[i]) != address(0)) revert InvalidQueueLength();
    emit DepositQueueChanged(newDepositQueue_);
  }

  function changeWithdrawQueue(uint8[] memory newWithdrawQueue_) public virtual {
    bool[MAX_STRATEGIES] memory seen;
    uint8 i = 0;
    if (newWithdrawQueue_.length > MAX_STRATEGIES) revert InvalidQueue();
    for (; i < newWithdrawQueue_.length; i++) {
      if (newWithdrawQueue_[i] >= MAX_STRATEGIES || address(_strategies[newWithdrawQueue_[i]]) == address(0))
        revert InvalidQueue();
      if (seen[newWithdrawQueue_[i]]) revert InvalidQueueIndexDuplicated(newWithdrawQueue_[i]);
      seen[newWithdrawQueue_[i]] = true;
      _withdrawQueue[i] = newWithdrawQueue_[i] + 1;
    }
    if (i < MAX_STRATEGIES && address(_strategies[i]) != address(0)) revert InvalidQueueLength();
    emit WithdrawQueueChanged(newWithdrawQueue_);
  }

  /**
   * @dev Moves funds from one strategy to the other.
   * @param strategyFromIdx The index of the strategy that will provide the funds in the _strategies array
   * @param strategyToIdx The index of the strategy that will receive the funds in the _strategies array
   * @param amount The amount to transfer from one strategy to the other. type(uint256).max to move all the assets.
   */
  function rebalance(uint8 strategyFromIdx, uint8 strategyToIdx, uint256 amount) public virtual returns (uint256) {
    if (strategyFromIdx >= MAX_STRATEGIES || strategyToIdx >= MAX_STRATEGIES) revert InvalidStrategy();
    IInvestStrategy strategyFrom = _strategies[strategyFromIdx];
    IInvestStrategy strategyTo = _strategies[strategyToIdx];
    if (address(strategyFrom) == address(0) || address(strategyTo) == address(0)) revert InvalidStrategy();
    if (amount == type(uint256).max) amount = strategyFrom.totalAssets();
    if (amount == 0) return 0; // Don't revert if nothing to do, just to make life easier for devs
    if (amount > strategyFrom.maxWithdraw()) revert RebalanceAmountExceedsMaxWithdraw(strategyFrom.maxWithdraw());
    if (amount > strategyTo.maxDeposit()) revert RebalanceAmountExceedsMaxDeposit(strategyTo.maxDeposit());
    strategyFrom.dcWithdraw(amount, false);
    strategyTo.dcDeposit(amount, false);
    emit Rebalance(strategyFrom, strategyTo, amount);
    return amount;
  }

  function strategies() external view returns (IInvestStrategy[MAX_STRATEGIES] memory) {
    return _strategies;
  }

  /**
   * @dev Returns the order in which the deposits will be made, expressed as index+1 in the _strategies array,
   *      filled with zeros at the end
   */
  function depositQueue() external view returns (uint8[MAX_STRATEGIES] memory) {
    return _depositQueue;
  }

  /**
   * @dev Returns the order in which the withdraws will be made, expressed as index+1 in the _strategies array,
   *      filled with zeros at the end
   */
  function withdrawQueue() external view returns (uint8[MAX_STRATEGIES] memory) {
    return _withdrawQueue;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[16] private __gap;
}
