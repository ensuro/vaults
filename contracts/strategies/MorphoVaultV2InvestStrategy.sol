// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IInvestStrategy} from "../interfaces/IInvestStrategy.sol";
import {ERC4626InvestStrategy} from "./ERC4626InvestStrategy.sol";

/**
 * @title IVaultV2
 *
 * @notice Interface of VaultV2 Morpho contracts, only relevant methods.
 *
 * @dev See https://github.com/morpho-org/vault-v2/blob/main/src/interfaces/IVaultV2.sol
 */
interface IVaultV2 is IERC4626 {
  function _totalAssets() external view returns (uint128);
  function lastUpdate() external view returns (uint64);
}

/**
 * @title MorphoVaultV2InvestStrategy
 *
 * @dev Strategy that invests/deinvests into a MorphoV2 vault
 *      See https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2.sol
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract MorphoVaultV2InvestStrategy is ERC4626InvestStrategy {
  using Math for uint256;
  uint64 private constant CACHED_TOTAL_ASSETS_MAX_AGE = 1 days;

  constructor(IERC4626 vault_) ERC4626InvestStrategy(vault_) {}

  /// @inheritdoc IInvestStrategy
  function maxWithdraw(address contract_) public view virtual override returns (uint256) {
    return totalAssets(contract_);
  }

  /// @inheritdoc IInvestStrategy
  function maxDeposit(address) public view virtual override returns (uint256) {
    return type(uint256).max;
  }

  /// @inheritdoc IInvestStrategy
  function totalAssets(address contract_) public view virtual override returns (uint256 assets) {
    uint256 shares = _vault.balanceOf(contract_);
    if (shares == 0) return 0;
    IVaultV2 vaultV2 = IVaultV2(address(_vault));
    uint64 lastUpdate = vaultV2.lastUpdate();
    if (lastUpdate + CACHED_TOTAL_ASSETS_MAX_AGE < block.timestamp) {
      // Vault "cached" _totalAssets is too old, normal implementation
      return vaultV2.previewRedeem(shares);
    } else {
      uint256 totAssets = uint256(vaultV2._totalAssets());
      uint256 totShares = vaultV2.totalSupply();
      return totAssets.mulDiv(shares, totShares);
    }
  }
}
