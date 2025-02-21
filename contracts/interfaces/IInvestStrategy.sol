// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IInvestStrategy
 *
 * @dev Interface that must follow investment strategies to be plugged into ERC4626 vaults. All the non-view methods
 *      MUST be called using delegatecall, thus executed in the context of the calling vault.
 *
 *      The strategy can use the storage of the calling contract, but ONLY in the storageSlot computed calling
 *      {InvestStrategyClient.makeStorageSlot}
 *
 *      The calling contract should implement IExposeStorage to give access to the storage to the strategy views
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
interface IInvestStrategy {
  /**
   * @dev Called when the strategy is plugged into the vault. Initializes the strategy storage and can do validations
   *
   * @param initData Initialization data for the strategy. Must be parsed by the strategy, since the format is
   *                 strategy specific
   */
  function connect(bytes memory initData) external;

  /**
   * @dev Called when the strategy is un-plugged from the vault. Should revert if there are still assets in the
   *      strategy, unless force==true.
   *
   * @param force If true, disconnect should not fail if assets remain in the strategy. Otherwise, disconnect
   *              MUST fail if totalAssets() != 0.
   */
  function disconnect(bool force) external;

  /**
   * @dev Deposits a given amount of assets into the strategy. It MUST revert if it can't deposit the specified amount.
   *      It assumes the assets are already in the contract (owned by address(this)).
   *
   * @param assets The amount of assets to deposit. Should be <= maxDeposit.
   */
  function deposit(uint256 assets) external;

  /**
   * @dev Withdraws a given amount of assets from the strategy. It MUST revert if it can't withdraw the specified amount.
   *      Leaves the withdrawn assets in the contract (owned by address(this)).
   *
   * @param assets The amount of assets to withdraw. Should be <= maxWithdraw.
   */
  function withdraw(uint256 assets) external;

  /**
   * @dev Receives an external call to execute a custom method of action in the strategy. Can be used for harvesting
   *      rewards or other tasks. It's called with delegatecall from the calling vault. The calling vault SHOULD
   *      do the access control validation, since the strategy normally won't do it.
   *
   * @param method An id of the method or action to call/execute. It's recommended to define an enum and convert the
   *               the uint8 value into the enum.
   * @param params Params for the method or action. Parsed by the strategy, it might differ from one or other method.
   */
  function forwardEntryPoint(uint8 method, bytes memory params) external returns (bytes memory);

  /**
   * VIEWS
   *
   * All the views receive as a parameter the contract (the vault) of which they should return the information,
   * since they won't be called with delegatecall (because EVM doesn't have staticdelegatecall)
   */

  /**
   * @dev The address of the underlying token used for accounting, depositing, and withdrawing. It must be the same
   *      as `IERC4626(contract_).asset()` when dealing with vaults.
   *
   * @param contract_ The address of the vault contract that owns the assets.
   */
  function asset(address contract_) external view returns (address);

  /**
   * @dev Returns the number of assets under management of the investment strategy for a given contract.
   *
   * @param contract_ The address of the vault contract that owns the assets and where the strategy is plugged
   */
  function totalAssets(address contract_) external view returns (uint256 totalManagedAssets);

  /**
   * @dev Returns the max amount that can be deposited into the strategy.
   *
   * @param contract_ The address of the vault contract that owns the assets and where the strategy is plugged
   */
  function maxDeposit(address contract_) external view returns (uint256 maxAssets);

  /**
   * @dev Returns the max amount that can be withdrawn from the strategy.
   *
   * @param contract_ The address of the vault contract that owns the assets and where the strategy is plugged
   */
  function maxWithdraw(address contract_) external view returns (uint256 maxAssets);

  /**
   * @dev Returns the slot where the data of the strategy can be stored.
   *       Typically it would return `InvestStrategyClient.makeStorageSlot(<strategyAddress>)`
   */
  function storageSlot() external view returns (bytes32);
}
