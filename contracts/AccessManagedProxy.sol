// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessManager} from "@openzeppelin/contracts/access/manager/IAccessManager.sol";

/**
 * @title AccessManagedProxy
 * @dev Proxy contract using IAccessManager to manage access control before delegating calls.
 *
 *      It's a variant of ERC1967Proxy.
 *
 *      Currently the check is executed on any call received by the proxy contract even calls to view methods
 *      (staticcall). In the setup of the ACCESS_MANAGER permissions you would want to make all the views and pure
 *      functions enabled for the PUBLIC_ROLE.
 *
 *      For gas efficiency, the ACCESS_MANAGER is immutable, so take care you don't lose control of it, otherwise
 *      it will make your contract inaccesible or other bad things will happen.
 *
 *      Check https://forum.openzeppelin.com/t/accessmanagedproxy-is-a-good-idea/41917 for a discussion on the
 *      advantages and disadvantages of using it.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract AccessManagedProxy is ERC1967Proxy {
  IAccessManager public immutable ACCESS_MANAGER;

  // Error copied from IAccessManaged
  error AccessManagedUnauthorized(address caller);

  constructor(
    address implementation,
    bytes memory _data,
    IAccessManager manager
  ) payable ERC1967Proxy(implementation, _data) {
    ACCESS_MANAGER = manager;
  }

  /**
   * @dev Checks with the ACCESS_MANAGER if msg.sender is authorized to call the current call's function,
   *      and if so, delegates the current call to `implementation`.
   *
   *      This function does not return to its internal call site, it will return directly to the external caller.
   *
   *      It uses `msg.sender`, so it will ignore any metatx like ERC-2771 or other ways of changing the sender.
   *
   *      Only let's the call go throught for immediate access, but scheduled calls can be made throught the
   *      ACCESS_MANAGER. It doesn't support the `.consumeScheduledOp(...)` flow that other access managed contracts
   *      support.
   */
  function _delegate(address implementation) internal virtual override {
    (bool immediate, ) = ACCESS_MANAGER.canCall(msg.sender, address(this), bytes4(msg.data[0:4]));
    if (!immediate) revert AccessManagedUnauthorized(msg.sender);
    super._delegate(implementation);
  }
}
