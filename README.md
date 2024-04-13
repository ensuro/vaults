# Vaults

This package contains several ERC4626 implementations contracts to be used with the Ensuro Protocol.

Try running some of the following tasks:

```shell
npx hardhat help
npx hardhat test
GAS_REPORT=true npx hardhat test
```

## Invest Strategies

The invest Strategies (those who implement) IInvestStrategy are implementation contrats that manage the investment in
a particular protocol, like AAVEv3 or CompoundV3. These implementation contracts are meant to be used with delegate
calls from a containter contract (typically a 4626 vault), that contains one or several strategies.

## MultiStrategyERC4626

This vault supports several pluggable strategies to invest the funds diversified in several protocols, with resilience
of these protocols being paused or not accepting deposits, and spreading the risk and generating diversified yields.
