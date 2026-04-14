# AGENTS.md

## Dev Commands

```bash
npx hardhat test                 # Run all tests
GAS_REPORT=true npx hardhat test # Run tests with gas report
npm run solhint                  # Lint Solidity
npm run prettier                 # Format Solidity/JS
npx hardhat compile              # Compile contracts
npx hardhat coverage             # Coverage report
npx hardhat size-contracts       # Contract size check
```

## CI Order

`compile -> size-contracts -> solhint -> test -> coverage`

## Testing

- Fork tests require `ALCHEMY_URL` or `INFURA_URL` env var (Polygon mainnet)
- Default fork block: 81382684 (override with `TEST_BLOCK` env var)

## Architecture

- **Vaults**: `AccessManagedMSV`, `OutflowLimitedAMMSV` inherit from `MSVBase`
- **Strategies**: Located in `contracts/strategies/` (AaveV3, CompoundV3, SwapStable, MerklRewards, etc.)
- **Strategy warning**: Each strategy's underlying asset must be unique; overlapping causes double-counting in `totalAssets()`

## Publishing

Package is published from `npm-package/` subdirectory (not root).
