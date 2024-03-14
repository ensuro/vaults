// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";

/**
 * @title InvestStrategyClient
 * @dev Library to simplify the interaction with IInvestStrategy objects
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library InvestStrategyClient {
  using Address for address;

  event StrategyChanged(IInvestStrategy oldStrategy, IInvestStrategy newStrategy);
  event WithdrawFailed(bytes reason);
  event DepositFailed(bytes reason);
  event DisconnectFailed(bytes reason);

  function dcConnect(IInvestStrategy strategy, bytes32 storageSlot, bytes memory initStrategyData) internal {
    address(strategy).functionDelegateCall(
      abi.encodeWithSelector(IInvestStrategy.connect.selector, storageSlot, initStrategyData)
    );
  }

  function dcDisconnect(IInvestStrategy strategy, bytes32 storageSlot, bool force) internal {
    if (force) {
      // solhint-disable-next-line avoid-low-level-calls
      (bool success, bytes memory returndata) = address(strategy).delegatecall(
        abi.encodeWithSelector(IInvestStrategy.disconnect.selector, storageSlot, true)
      );
      if (!success) emit DisconnectFailed(returndata);
    } else {
      address(strategy).functionDelegateCall(
        abi.encodeWithSelector(IInvestStrategy.disconnect.selector, storageSlot, false)
      );
    }
  }

  function dcWithdraw(
    IInvestStrategy strategy,
    bytes32 storageSlot,
    uint256 assets,
    bool ignoreError
  ) internal returns (bool) {
    if (ignoreError) {
      // solhint-disable-next-line avoid-low-level-calls
      (bool success, bytes memory returndata) = address(strategy).delegatecall(
        abi.encodeWithSelector(IInvestStrategy.withdraw.selector, storageSlot, assets)
      );
      if (!success) emit WithdrawFailed(returndata);
      return success;
    } else {
      address(strategy).functionDelegateCall(
        abi.encodeWithSelector(IInvestStrategy.withdraw.selector, storageSlot, assets)
      );
      return true;
    }
  }

  function dcDeposit(
    IInvestStrategy strategy,
    bytes32 storageSlot,
    uint256 assets,
    bool ignoreError
  ) internal returns (bool) {
    if (ignoreError) {
      // solhint-disable-next-line avoid-low-level-calls
      (bool success, bytes memory returndata) = address(strategy).delegatecall(
        abi.encodeWithSelector(IInvestStrategy.deposit.selector, storageSlot, assets)
      );
      if (!success) emit DepositFailed(returndata);
      return success;
    } else {
      address(strategy).functionDelegateCall(
        abi.encodeWithSelector(IInvestStrategy.deposit.selector, storageSlot, assets)
      );
      return true;
    }
  }

  function dcForward(
    IInvestStrategy strategy,
    bytes32 storageSlot,
    uint8 method,
    bytes memory extraData
  ) internal returns (bytes memory) {
    return
      address(strategy).functionDelegateCall(
        abi.encodeWithSelector(IInvestStrategy.forwardEntryPoint.selector, storageSlot, method, extraData)
      );
  }

  function strategyChange(
    IInvestStrategy oldStrategy,
    bytes32 oldStorageSlot,
    IInvestStrategy newStrategy,
    bytes32 newStorageSlot,
    bytes memory newStrategyInitData,
    IERC20Metadata asset,
    bool force
  ) internal {
    // I explicitly don't check newStrategy != _strategy because in some cases might be usefull to disconnect and
    // connect a strategy
    dcWithdraw(oldStrategy, oldStorageSlot, oldStrategy.totalAssets(address(this), oldStorageSlot), force);
    dcDisconnect(oldStrategy, oldStorageSlot, force);
    // We don't make _connect error proof, since the user can take care the new strategy doesn't fails on connect
    dcConnect(newStrategy, newStorageSlot, newStrategyInitData);
    // Deposits all the funds, in case something was gifted to the vault.
    dcDeposit(newStrategy, newStorageSlot, asset.balanceOf(address(this)), force);
    emit StrategyChanged(oldStrategy, newStrategy);
  }

  /**
   * @dev Returns the slot where the specific data of the strategy is stored.
   *      Warning! This assumes the same strategy (deployed code in a given address) isn't used twice inside a given
   *      contract. If that happens, the storage of one can collide with the other.
   *      Also, be aware if you unplug and the re-plug a given strategy into a contract, you might be reading a state
   *      that is not clean
   */
  function storageSlot(IInvestStrategy strategy) public pure returns (bytes32) {
    return keccak256(abi.encode("co.ensuro.InvestStrategyClient", strategy));
  }
}
