# Vaults

This package contains several ERC4626 implementations contracts to be used with the Ensuro Protocol.

Try running some of the following tasks:

```shell
npx hardhat help
npx hardhat test
GAS_REPORT=true npx hardhat test
```

## Multi Strategy Vaults (MSV)

These contracts are ERC4626 vaults where several investment strategies are plugged and the funds are allocated across
them.

This allows diverfisication of the assets and the risks in a flexible manner.

The contract doesn't implement any rebalance strategy, that needs to be called from the outside. It is just a queue
of strategies for deposits and another for withdrawals and uses that order to serve the enter or exit request as
fast as possible.

For efficiency and transparency reasons, the strategies are contracts called with delegatecall, meaning that they
execute in the context of the vault, managing the vault assets. Only trusted strategies must be plugged.

### MSV Alternatives

The repositoy includes three MultiStrategyVault alternatives, all inheriting from MSVBase, difering on how they manage
access control or other features:

- **MultiStrategyERC4626**: uses OZ's AccessControl contract for managing the permissions.
- **AccessManagedMSV**: this one is intented to be deployed behing an AccessManagedProxy, a modified ERC1967
  proxy that checks with an AccessManager (OZ 5.x) contract for each method called. The contract itself doesn't
  implement any access control policy.
- **OutflowLimitedMSV**: this one is a variation of AccessManagedMSV that also tracks the net inflows by slots
  of time and rejects withdrawals when a given outflow limit is exceeded.

## Invest Strategies

The invest Strategies (those who implement) IInvestStrategy are implementation contrats that manage the investment in
a particular protocol, like AAVEv3 or CompoundV3. These implementation contracts are meant to be used with delegate
calls from a containter contract (typically a MSV), that contains one or several strategies.

The current implemented strategies are:

- **AaveV3InvestStrategy**: invests the funds received in an AAVE pool.
- **CompoundV3InvestStrategy**: invest the funds received in a Compound pool. Has support for claiming rewards that
  are reinvested.
- **SwapStableInvestStrategy**: the strategy consist in swapping the asset to an investment assets that typically
  has a 1:1 equivalence with the asset. Useful for yield bearing assets like USDM or Lido ETH.
- **SwapStableAaveV3InvestStrategy**: it swaps the asset and invests it into AAVE. Useful for equivalent assets that
  have different returns on AAVE like Bridged USDC vs Native USDC.

**WARNING**: the underlying asset of each strategy should be different, and not overlap with other strategies'
underlying assets, because this can produce double-counting in the totalAssets() method. Be careful of this when
adding a new strategy to an existing vault.
