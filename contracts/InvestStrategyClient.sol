// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
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

  function dcConnect(IInvestStrategy strategy, bytes memory initStrategyData) internal {
    address(strategy).functionDelegateCall(abi.encodeCall(IInvestStrategy.connect, initStrategyData));
  }

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

  function dcForward(IInvestStrategy strategy, uint8 method, bytes memory extraData) internal returns (bytes memory) {
    return
      address(strategy).functionDelegateCall(abi.encodeCall(IInvestStrategy.forwardEntryPoint, (method, extraData)));
  }

  function strategyChange(
    IInvestStrategy oldStrategy,
    IInvestStrategy newStrategy,
    bytes memory newStrategyInitData,
    IERC20Metadata asset,
    bool force
  ) internal {
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
   *      Warning! This assumes the same strategy (deployed code in a given address) isn't used twice inside a given
   *      contract. If that happens, the storage of one can collide with the other.
   *      Also, be aware if you unplug and the re-plug a given strategy into a contract, you might be reading a state
   *      that is not clean
   */
  function makeStorageSlot(IInvestStrategy strategy) internal pure returns (bytes32) {
    return keccak256(abi.encode("co.ensuro.InvestStrategyClient", strategy));
  }

  function totalAssets(IInvestStrategy strategy) internal view returns (uint256) {
    return strategy.totalAssets(address(this));
  }

  function maxDeposit(IInvestStrategy strategy) internal view returns (uint256) {
    return strategy.maxDeposit(address(this));
  }

  function maxWithdraw(IInvestStrategy strategy) internal view returns (uint256) {
    return strategy.maxWithdraw(address(this));
  }
}
