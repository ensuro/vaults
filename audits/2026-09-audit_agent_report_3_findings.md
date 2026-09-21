# Audit Agent Report #3 — Findings Response

This document records our stance on the findings in
[`2026-09-audit_agent_report_3_ad8b66d5-ddab-42bf-be03-9b6eeaae908e.pdf`](./2026-09-audit_agent_report_3_ad8b66d5-ddab-42bf-be03-9b6eeaae908e.pdf).

## Finding #1 — Acknowledged

Our use of the vault is only with stablecoins (USDC), so we have no strategy for handling native
Ether. If the contract ever receives Ether, we can recover it by adding a strategy that manages it.

## Finding #2 — Acknowledged

The contract being called, Aave, is an immutable and trusted protocol, and there is no risk of
reentrancy from calling `getReserveData()`.

## Finding #3 — Acknowledged

We will always have fewer than 32 strategies, so this is not a concern.

## Finding #4 — Acknowledged

## Finding #5 — Acknowledged

We are aware of this and take care when adding new strategies that they don't account for the same
assets. When adding new strategies or rebalancing, we run tests checking that `totalAssets()`
doesn't change.

## Finding #6 — Acknowledged

First, the current MSV does have the `IdleInvestStrategy`. But even without it, this finding isn't
relevant. Additionally, in Ensuro's use case, the MSV isn't open to anonymous LPs: only whitelisted
LPs can deposit or withdraw from the MSV.

## Finding #7 — Acknowledged

## Finding #8 — Acknowledged

We take care to grant the necessary AccessManager permissions to call this method.

## Finding #9 — Acknowledged

Not a significant problem if we collect rewards frequently, and also given that we only use
whitelisted LPs.

## Finding #10 — Acknowledged

Not a significant issue: the user will receive an error anyway.

## Finding #11 — Acknowledged

This doesn't produce any loss for the vault and can be reverted by rebalancing back to the
`IdleInvestStrategy`.

## Finding #12 — Acknowledged

## Findings #13–#28 — Acknowledged (Low severity)

The remaining findings are low-severity issues — mostly code style, gas optimizations, and minor
robustness improvements (unused imports/state, TODO comments, literals instead of constants, empty
blocks, unspecific pragma, unchecked ERC20 returns, empty `revert()` statements, and loop-related
gas costs). We acknowledge them and will address them as part of routine code-quality maintenance;
none represent a loss of funds for the vault or its users.
