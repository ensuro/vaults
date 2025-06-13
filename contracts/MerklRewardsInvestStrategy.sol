// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SwapLibrary} from "@ensuro/swaplibrary/contracts/SwapLibrary.sol";
import {IInvestStrategy} from "./interfaces/IInvestStrategy.sol";
import {ChainlinkSwapAssetInvestStrategy} from "./ChainlinkSwapAssetInvestStrategy.sol";
import {AggregatorV3Interface} from "./dependencies/chainlink/AggregatorV3Interface.sol";
import {MSVBase} from "./MSVBase.sol";

interface IMerklDistributor {
  function claim(
    address[] calldata users,
    address[] calldata tokens,
    uint256[] calldata amounts,
    bytes32[][] calldata proofs
  ) external;
}

/**
 * @title MerklRewardsInvestStrategy
 * @dev Strategy that collects the Merkl Rewards and accounts them. Also supports swapping them in reinjecting
 *      them into the vault.
 *
 *      Uses Chainlink oracles to price the asset
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract MerklRewardsInvestStrategy is ChainlinkSwapAssetInvestStrategy {
  using Address for address;
  using SwapLibrary for SwapLibrary.SwapConfig;

  IMerklDistributor public immutable distributor;

  enum MerklForwardMethods {
    setSwapConfig,
    claimRewards,
    claimAndSwapRewards,
    swapRewards
  }

  event RewardsClaimed(address indexed token, uint256 amount);
  event RewardsSwapped(address indexed token, uint256 amountIn, uint256 amountOut);

  /**
   * @dev Constructor of the strategy
   *
   * @param asset_ The address of the underlying token used for accounting, depositing, and withdrawing.
   * @param investAsset_ The address of the tokens hold by the strategy. Typically a rebasing yield bearing token
   * @param assetOracle_ The chainlink oracle to obtain the price of the asset. If address(0) the price is 1.
   * @param investAssetOracle_ The chainlink oracle to obtain the price of the invest asset. If address(0) => 1
   * @param investAssetOracle_ The chainlink oracle to obtain the price of the invest asset. If address(0) => 1
   */
  constructor(
    IERC20Metadata asset_,
    IERC20Metadata investAsset_,
    AggregatorV3Interface assetOracle_,
    AggregatorV3Interface investAssetOracle_,
    uint256 priceTolerance_,
    IMerklDistributor distributor_
  ) ChainlinkSwapAssetInvestStrategy(asset_, investAsset_, assetOracle_, investAssetOracle_, priceTolerance_) {
    distributor = distributor_;
  }

  /// @inheritdoc IInvestStrategy
  function maxDeposit(address /*contract_*/) public view virtual override returns (uint256) {
    // Disable deposits
    return 0;
  }

  function _claimRewards(bytes memory params) internal {
    uint256[] memory amounts = new uint256[](1);
    address[] memory users = new address[](1);
    address[] memory tokens = new address[](1);
    bytes32[][] memory proofs = new bytes32[][](1);
    (amounts[0], proofs[0]) = abi.decode(params, (uint256, bytes32[]));
    users[0] = address(this);
    tokens[0] = investAsset(address(this));
    distributor.claim(users, tokens, amounts, proofs);
    emit RewardsClaimed(tokens[0], amounts[0]);
  }

  function _swapRewards(uint256 amount) internal {
    if (amount == type(uint256).max) amount = _investAsset.balanceOf(address(this));
    uint256 amountOut = _getSwapConfigSelf().exactInput(
      address(_investAsset),
      address(_asset),
      amount,
      sellInvestAssetPrice()
    );

    // Reinjects the rewards in the vault calling `depositToStrategies` on the implementation contract
    ERC1967Utils.getImplementation().functionDelegateCall(abi.encodeCall(MSVBase.depositToStrategies, amountOut));
    emit RewardsSwapped(investAsset(address(this)), amount, amountOut);
  }

  /// @inheritdoc IInvestStrategy
  function forwardEntryPoint(
    uint8 method,
    bytes memory params
  ) public virtual override onlyDelegCall returns (bytes memory result) {
    MerklForwardMethods checkedMethod = MerklForwardMethods(method);
    if (checkedMethod == MerklForwardMethods.claimRewards) {
      _claimRewards(params);
    } else if (checkedMethod == MerklForwardMethods.claimAndSwapRewards) {
      _claimRewards(params);
      _swapRewards(type(uint256).max);
    } else if (checkedMethod == MerklForwardMethods.swapRewards) {
      _swapRewards(abi.decode(params, (uint256)));
    } else return super.forwardEntryPoint(method, params);
  }
}
