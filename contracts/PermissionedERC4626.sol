// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ICallable} from "./interfaces/ICallable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {MathUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

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
    IERC20Upgradeable asset_
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
    _setupRole(DEFAULT_ADMIN_ROLE, admin_);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override onlyRole(GUARDIAN_ROLE) {}

  /**
   * @dev See {IERC4626-mint}.
   */
  function mint(uint256 assets, address receiver) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.mint(assets, receiver);
  }

  /**
   * @dev See {IERC4626-deposit}.
   */
  function deposit(uint256 assets, address receiver) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.deposit(assets, receiver);
  }

  /**
   * @dev See {IERC4626-withdraw}.
   */
  function withdraw(
    uint256 assets,
    address receiver,
    address owner
  ) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.withdraw(assets, receiver, owner);
  }

  /**
   * @dev See {IERC4626-redeem}.
   */
  function redeem(
    uint256 assets,
    address receiver,
    address owner
  ) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.withdraw(assets, receiver, owner);
  }
}
