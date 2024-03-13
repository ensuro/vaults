// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IInvestStrategy
 *
 * @dev Interface that must follow investment strategies to be plugged into ERC4626 vaults. All the non-view methods
 *      MUST be called using delegatecall, thus executed in the context of the calling vault.
 *
 *      The strategy can use the storage of the calling contract, but ONLY in the received storageSlot.
 *
 *      The calling contract should implement IExposeStorage to give access to the storage to the views.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
interface IInvestStrategy {
  /**
   * @dev Called when the strategy is plugged into the vault. Initializes the storage and can do validations (for
   *      example, checking the asset is the same)
   *
   * @param storageSlot The slot where the data of the strategy can be stored.
   * @param initData Initialization data for the strategy. Must be parsed by the strategy.
   */
  function connect(bytes32 storageSlot, bytes memory initData) external;

  /**
   * @dev Called when the strategy is un-plugged from the vault. Should revert if there are still assets in the
   *      strategy, unless force==true.
   *
   * @param storageSlot The slot where the data of the strategy is stored.
   * @param force If true, disconnect should not fail if assets remain in the strategy. Otherwise, disconnect
   *              MUST fail if totalAssets() != 0.
   */
  function disconnect(bytes32 storageSlot, bool force) external;

  /**
   * @dev Deposits a given amount of assets into the strategy. It MUST revert if it can't deposit the specified amount.
   *      It assumes the assets are already in the contract (owned by address(this)).
   *
   * @param storageSlot The slot where the data of the strategy is stored.
   * @param assets The amount of assets to deposit. Should be <= maxDeposit.
   */
  function deposit(bytes32 storageSlot, uint256 assets) external;

  /**
   * @dev Withdraws a given amount of assets from the strategy. It MUST revert if it can't withdraw the specified amount.
   *      Leaves the withdrawn assets in the contract (owned by address(this)).
   *
   * @param storageSlot The slot where the data of the strategy is stored.
   * @param assets The amount of assets to withdraw. Should be <= maxWithdraw.
   */
  function withdraw(bytes32 storageSlot, uint256 assets) external;

  /**
   * @dev Receives an external call to execute a custom method of action in the strategy. Can be used for harvesting
   *      rewards or other tasks. It's called with delegatecall from the calling vault, but the calling vault usually
   *      don't do any access validation, so if the method requires a permission, it must be checked by the strategy.
   *
   * @param storageSlot The slot where the data of the strategy is stored.
   * @param method An id of the method or action to call/execute. It's recommended to define an enum and convert the
   *               the uint8 value into the enum.
   * @param params Params for the method or action. Parsed by the strategy, it might differ from one or other method.
   */
  function forwardEntryPoint(bytes32 storageSlot, uint8 method, bytes memory params) external returns (bytes memory);

  // Views

  /**
   * @dev Returns the number of assets under management of the investment strategy for a given contract.
   *
   * @param contract_ The address of the contract that owns the assets.
   * @param storageSlot The slot where the data of the strategy is stored. For this to be useful, the contract must
   *                    implement IExposeStorage
   */
  function totalAssets(address contract_, bytes32 storageSlot) external view returns (uint256 totalManagedAssets);

  /**
   * @dev Returns the max amount that can be deposited into the strategy.
   *
   * @param contract_ The address of the contract that owns the assets.
   * @param storageSlot The slot where the data of the strategy is stored. For this to be useful, the contract must
   *                    implement IExposeStorage
   */
  function maxDeposit(address contract_, bytes32 storageSlot) external view returns (uint256 maxAssets);

  /**
   * @dev Returns the max amount that can be withdrawn from the strategy.
   *
   * @param contract_ The address of the contract that owns the assets.
   * @param storageSlot The slot where the data of the strategy is stored. For this to be useful, the contract must
   *                    implement IExposeStorage
   */
  function maxWithdraw(address contract_, bytes32 storageSlot) external view returns (uint256 maxAssets);
}
