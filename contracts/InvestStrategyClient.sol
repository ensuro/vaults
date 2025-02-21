// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";

/**
 * @title InvestStrategyClient
 *
 * @dev Library to simplify the interaction with IInvestStrategy objects. Abstract away the delegate calls and
 *      other gotchas of the communication with the strategies.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library InvestStrategyClient {
  using Address for address;

  event StrategyChanged(IInvestStrategy oldStrategy, IInvestStrategy newStrategy);
  event WithdrawFailed(bytes reason);
  event DepositFailed(bytes reason);
  event DisconnectFailed(bytes reason);

  error InvalidStrategyAsset();

  /**
   * @dev Performs a connection with the given strategy. See {IInvestStrategy.connect}
   *
   * @param strategy Investment strategy to connect.
   * @param initStrategyData Initialization data required for the strategy to connect.
   */
  function dcConnect(IInvestStrategy strategy, bytes memory initStrategyData) internal {
    address(strategy).functionDelegateCall(abi.encodeCall(IInvestStrategy.connect, initStrategyData));
  }

  /**
   * @dev Disconnects from the given strategy. This diconnection is done using a delegatecall to the strategy.
   *
   *      See {IInvestStrategy.disconnect}
   *
   * @param strategy Investment strategy to connect.
   * @param force Bool value to force disconnection, when `true` it will just emit DisconnectFailed if it fails,
   *              otherwise it will revert when it's false and fails.
   */
  function dcDisconnect(IInvestStrategy strategy, bool force) internal {
    if (force) {
      // solhint-disable-next-line avoid-low-level-calls
      (bool success, bytes memory returndata) = address(strategy).delegatecall(
        abi.encodeCall(IInvestStrategy.disconnect, true)
      );
      if (!success) emit DisconnectFailed(returndata);
    } else {
      address(strategy).functionDelegateCall(abi.encodeCall(IInvestStrategy.disconnect, false));
    }
  }

  /**
   * @dev Delegate call to withdraw assets from a given strategy.
   *
   *      See {IInvestStrategy.withdraw}
   *
   * @param strategy Strategy to withdraw assets from.
   * @param assets Amount of assets to be withdrawn.
   * @param ignoreError When true, the error will be caught and event WithdrawFailed will be emitted,
                        otherwise it will revert when it's false and fails.
   * @return Returns true if it was successful, otherwise returns false (only when ignoreError = true, otherwise reverts)
   */
  function dcWithdraw(IInvestStrategy strategy, uint256 assets, bool ignoreError) internal returns (bool) {
    if (ignoreError) {
      // solhint-disable-next-line avoid-low-level-calls
      (bool success, bytes memory returndata) = address(strategy).delegatecall(
        abi.encodeCall(IInvestStrategy.withdraw, assets)
      );
      if (!success) emit WithdrawFailed(returndata);
      return success;
    } else {
      address(strategy).functionDelegateCall(abi.encodeCall(IInvestStrategy.withdraw, assets));
      return true;
    }
  }

  /**
   * @dev Delegate call to deposit assets from a given strategy.
   *
   *      See {IInvestStrategy.deposit}
   *
   * @param strategy Strategy to deposit assets from.
   * @param assets Amount of assets to be deposited.
   * @param ignoreError When true, the error will be caught and event DepositFailed will be emitted,
                        otherwise it will revert when it's false and fails.
   * @return Returns true if it was successful, otherwise returns false (only when ignoreError = true, otherwise reverts)
   */
  function dcDeposit(IInvestStrategy strategy, uint256 assets, bool ignoreError) internal returns (bool) {
    if (ignoreError) {
      // solhint-disable-next-line avoid-low-level-calls
      (bool success, bytes memory returndata) = address(strategy).delegatecall(
        abi.encodeCall(IInvestStrategy.deposit, assets)
      );
      if (!success) emit DepositFailed(returndata);
      return success;
    } else {
      address(strategy).functionDelegateCall(abi.encodeCall(IInvestStrategy.deposit, assets));
      return true;
    }
  }

  /**
   * @dev Delegate call to forward a custom method of the given strategy.
   *
   *      See {IInvestStrategy.forwardEntryPoint}
   *
   * @param strategy Strategy to forward the custom method.
   * @param method Method to be forwarded.
   * @param extraData Additional params required by the method
   * @return Returns the result of {IInvestStrategy.forwardEntryPoint}
   */
  function dcForward(IInvestStrategy strategy, uint8 method, bytes memory extraData) internal returns (bytes memory) {
    return
      address(strategy).functionDelegateCall(abi.encodeCall(IInvestStrategy.forwardEntryPoint, (method, extraData)));
  }

  /**
   * @dev Checks the strategy asset() to ensure it is the same as the asset of the vault.
   * @param strategy Strategy to be checked.
   * @param asset Asset of the vault.
   */
  function checkAsset(IInvestStrategy strategy, address asset) internal view {
    if (strategy.asset(address(this)) != asset) revert InvalidStrategyAsset();
  }

  /**
   * @dev Replaces one strategy with another.
   *
   * @param oldStrategy The strategy to be replaced
   * @param newStrategy The new strategy to connect
   * @param newStrategyInitData The initialization data that will be send to the `newStrategy` on connect
   * @param asset Asset of the vault (the newStrategy has to have the same asset)
   * @param force When false, it reverts if withdrawal of assets or disconnection or deposit into the new strategy
   *              fails. When true, it doesn't revert on any of those errors, it just emits events.
   */
  function strategyChange(
    IInvestStrategy oldStrategy,
    IInvestStrategy newStrategy,
    bytes memory newStrategyInitData,
    IERC20Metadata asset,
    bool force
  ) internal {
    checkAsset(newStrategy, address(asset));
    // I explicitly don't check newStrategy != _strategy because in some cases might be usefull to disconnect and
    // connect a strategy
    dcWithdraw(oldStrategy, oldStrategy.totalAssets(address(this)), force);
    dcDisconnect(oldStrategy, force);
    // We don't make _connect error proof, since the user can take care the new strategy doesn't fails on connect
    dcConnect(newStrategy, newStrategyInitData);
    // Deposits all the funds, in case something was gifted to the vault.
    dcDeposit(newStrategy, asset.balanceOf(address(this)), force);
    emit StrategyChanged(oldStrategy, newStrategy);
  }

  /**
   * @dev Returns the slot where the specific data of the strategy is stored.
   *
   *      WARNING: This assumes the same strategy (deployed code in a given address) isn't used twice inside a given
   *      contract. If that happens, the storage of one can collide with the other.
   *      Also, be aware if you unplug and the re-plug a given strategy into a contract, you might be reading a state
   *      that is not clean
   */
  function makeStorageSlot(IInvestStrategy strategy) internal pure returns (bytes32) {
    return keccak256(abi.encode("co.ensuro.InvestStrategyClient", strategy));
  }

  /**
   * @dev Returns the total assets in the strategy given.
   *
   * See {IInvestStrategy.totalAssets()}
   */
  function totalAssets(IInvestStrategy strategy) internal view returns (uint256) {
    return strategy.totalAssets(address(this));
  }

  /**
   * @dev Returns the maximum amount of assets that can be deposited in the strategy.
   *
   *      See {IInvestStrategy.maxDeposit}
   */
  function maxDeposit(IInvestStrategy strategy) internal view returns (uint256) {
    return strategy.maxDeposit(address(this));
  }

  /**
   * @dev Returns the maximum amount of assets that can be withdrawn from the strategy.
   *
   *      See {IInvestStrategy.maxWithdraw}
   */
  function maxWithdraw(IInvestStrategy strategy) internal view returns (uint256) {
    return strategy.maxWithdraw(address(this));
  }
}
