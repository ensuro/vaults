// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title PermissionedERC4626
 * @dev Base class for permissioned ERC-4626 that use AccessControl for the access permissions.
 *
 *      Not used at the moment, since we started to use AccessManagedProxy contracts.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract PermissionedERC4626 is AccessControlUpgradeable, UUPSUpgradeable, ERC4626Upgradeable {
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant LP_ROLE = keccak256("LP_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

  error InvalidAsset(address asset);

  // solhint-disable-next-line func-name-mixedcase
  function __PermissionedERC4626_init(
    string memory name_,
    string memory symbol_,
    address admin_,
    IERC20 asset_
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    if (address(asset_) == address(0)) revert InvalidAsset(address(0));
    __ERC4626_init(asset_);
    __ERC20_init(name_, symbol_);
    __PermissionedERC4626_init_unchained(admin_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PermissionedERC4626_init_unchained(address admin_) internal onlyInitializing {
    _grantRole(DEFAULT_ADMIN_ROLE, admin_);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override onlyRole(GUARDIAN_ROLE) {}

  function setRoleAdmin(bytes32 role, bytes32 adminRole) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _setRoleAdmin(role, adminRole);
  }

  /**
   * @dev See {IERC4626-maxDeposit}.
   */
  function maxDeposit(address owner) public view virtual override returns (uint256) {
    if (!hasRole(LP_ROLE, owner)) return 0;
    return super.maxDeposit(owner);
  }

  /**
   * @dev See {IERC4626-maxMint}.
   */
  function maxMint(address owner) public view virtual override returns (uint256) {
    if (!hasRole(LP_ROLE, owner)) return 0;
    return super.maxMint(owner);
  }
}
