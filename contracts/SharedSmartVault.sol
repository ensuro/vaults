// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title SharedSmartVault
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SharedSmartVault is AccessControlUpgradeable, UUPSUpgradeable, ERC4626Upgradeable {
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant LP_ROLE = keccak256("LP_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

  address internal immutable _smartVault;
  address internal _collector;
  address internal _withdrawer;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(address smartVault_) {
    require(
      address(smartVault_) != address(0),
      "SharedSmartVault: smartVault_ cannot be zero address"
    );
    _disableInitializers();
    _smartVault = smartVault_;
  }

  /**
   * @dev Initializes the SharedSmartVault
   */
  function initialize(
    address collector_,
    address withdrawer_,
    IERC20Upgradeable asset_
  ) public virtual initializer {
    __SharedSmartVault_init(collector_, withdrawer_, asset_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __SharedSmartVault_init(
    address collector_,
    address withdrawer_,
    IERC20Upgradeable asset_
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    require(
      address(collector_) != address(0),
      "SharedSmartVault: collector_ cannot be zero address"
    );
    require(
      address(withdrawer_) != address(0),
      "SharedSmartVault: withdrawer_ cannot be zero address"
    );
    __ERC4626_init(asset_);
    __SharedSmartVault_init_unchained(collector_, withdrawer_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __SharedSmartVault_init_unchained(
    address collector_,
    address withdrawer_
  ) internal onlyInitializing {
    require(
      address(collector_) != address(0),
      "SharedSmartVault: collector_ cannot be zero address"
    );
    require(
      address(withdrawer_) != address(0),
      "SharedSmartVault: withdrawer_ cannot be zero address"
    );
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());

    _collector = collector_;
    _withdrawer = withdrawer_;
    // TODO: Infinite approval
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override onlyRole(GUARDIAN_ROLE) {}

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
