// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {AccessManagedMSV} from "./AccessManagedMSV.sol";

/**
 * @title MigrateAssetMSV
 *
 * @dev Contract to execute an in-place migration from one asset() to another asset()
 *      Used to execute a migration from Bridged USDC to Native USDC
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract MigrateAssetMSV is AccessManagedMSV {
  error InvalidNewAsset();
  error TotalAssetsChangedDuringMigration(uint256 assetsBefore, uint256 assetsAfter);

  // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC4626")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line const-name-snakecase
  bytes32 internal constant ERC4626StorageLocation = 0x0773e532dfede91f04b12a73d3d2acd361424f41f76b4fb79f090161e36b4e00;

  // Copied from OZ's ERC4626.sol, because the original function is private
  function _getERC4626StorageCFL() internal pure returns (ERC4626Storage storage $) {
    // solhint-disable-next-line no-inline-assembly
    assembly {
      $.slot := ERC4626StorageLocation
    }
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @dev Executes the migration of the vault to the new asset
   *
   * @param newAsset_ The asset() of the ERC4626
   * @param acceptableAssetGain Max amount of increase in assets that is acceptable
   * @param acceptableAssetLoss Max amount of decrease in assets that is acceptable
   * @param strategies_ The IInvestStrategys that will be used to manage the funds received.
   * @param initStrategyDatas Initialization data that will be sent to the strategies
   * @param depositQueue_ The order in which the funds will be deposited in the strategies
   * @param withdrawQueue_ The order in which the funds will be withdrawn from the strategies
   */
  function reinitialize(
    IERC20Metadata newAsset_,
    uint256 acceptableAssetGain,
    uint256 acceptableAssetLoss,
    IInvestStrategy[] memory strategies_,
    bytes[] memory initStrategyDatas,
    uint8[] memory depositQueue_,
    uint8[] memory withdrawQueue_
  ) public virtual reinitializer(2) {
    require(
      address(newAsset_) != asset() && IERC20Metadata(asset()).decimals() == newAsset_.decimals(),
      InvalidNewAsset()
    );
    uint256 assetsBefore = totalAssets();

    ERC4626Storage storage $ERC4626 = _getERC4626StorageCFL();
    $ERC4626._asset = IERC20(address(newAsset_));
    __MSVBase_init_unchained(strategies_, initStrategyDatas, depositQueue_, withdrawQueue_);
    // Clean old strategies (in case the new installed strategies are less than the previous ones)
    for (uint256 i = strategies_.length; i < MAX_STRATEGIES && address(_strategies[i]) != address(0); ++i) {
      _strategies[i] = IInvestStrategy(address(0));
      _depositQueue[i] = 0;
      _withdrawQueue[i] = 0;
    }
    uint256 assetsAfter = totalAssets();
    require(
      assetsAfter <= assetsBefore || (assetsAfter - assetsBefore) <= acceptableAssetGain,
      TotalAssetsChangedDuringMigration(assetsBefore, assetsAfter)
    );
    require(
      assetsAfter >= assetsBefore || (assetsBefore - assetsAfter) <= acceptableAssetLoss,
      TotalAssetsChangedDuringMigration(assetsBefore, assetsAfter)
    );
  }
}
