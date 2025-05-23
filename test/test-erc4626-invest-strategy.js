const { expect } = require("chai");
const { amountFunction, _W, getRole, getTransactionEvent } = require("@ensuro/utils/js/utils");
const { encodeDummyStorage, tagit } = require("./utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Single Strategy Vault";
const SYMB = "SSV";

const CENT = _A("0.01");
const MCENT = CENT / 1000n;

const OverrideOption = {
  deposit: 0,
  mint: 1,
  withdraw: 2,
  redeem: 3,
};

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();

  const USDC = await initCurrency(
    {
      name: "Test Currency with 6 decimals",
      symbol: "USDC",
      decimals: 6,
      initial_supply: _A(50000),
      extraArgs: [admin],
    },
    [lp, lp2],
    [_A(INITIAL), _A(INITIAL)]
  );

  const adminAddr = await ethers.resolveAddress(admin);
  const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
  const ERC4626InvestStrategy = await ethers.getContractFactory("ERC4626InvestStrategy");
  const SingleStrategyERC4626 = await ethers.getContractFactory("SingleStrategyERC4626");
  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const investVault = await TestERC4626.deploy("Some vault", "VAULT", USDC);

  // Grant roles to the test vault, so it can mint/burn earnings/losses
  await USDC.connect(admin).grantRole(getRole("MINTER_ROLE"), investVault);
  await USDC.connect(admin).grantRole(getRole("BURNER_ROLE"), investVault);

  async function setupVault(asset, strategy, strategyData = ethers.toUtf8Bytes("")) {
    const vault = await hre.upgrades.deployProxy(
      SingleStrategyERC4626,
      [NAME, SYMB, adminAddr, await ethers.resolveAddress(asset), await ethers.resolveAddress(strategy), strategyData],
      {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
      }
    );
    // Whitelist LPs
    await asset.connect(lp).approve(vault, MaxUint256);
    await asset.connect(lp2).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp2);
    return vault;
  }

  return {
    USDC,
    SingleStrategyERC4626,
    ERC4626InvestStrategy,
    DummyInvestStrategy,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    investVault,
    setupVault,
  };
}

async function setUpCommon() {
  const ret = await helpers.loadFixture(setUp);
  const strategy = await ret.ERC4626InvestStrategy.deploy(ret.investVault);
  const vault = await ret.setupVault(ret.USDC, strategy);
  return { ...ret, vault, strategy };
}

describe("ERC4626InvestStrategy contract tests", function () {
  it("Initializes the vault correctly", async () => {
    const { USDC, investVault, vault, strategy } = await setUpCommon();
    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.strategy()).to.equal(strategy);
    expect(await vault.asset()).to.equal(USDC);
    expect(await vault.totalAssets()).to.equal(0);
    expect(await strategy.asset(vault)).to.equal(USDC);
    expect(await strategy.investVault(vault)).to.equal(investVault);
  });

  it("Deposit and accounting works", async () => {
    const { USDC, investVault, vault, lp } = await setUpCommon();
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await vault.totalAssets()).to.equal(_A(100));
    expect(await investVault.convertToAssets(await investVault.balanceOf(vault))).to.equal(_A(100));

    // Checks allowance backs to 0 after the deposit
    expect(await USDC.allowance(vault, investVault)).to.equal(0);

    await investVault.discreteEarning(_A(40));
    expect(await vault.totalAssets()).to.closeTo(_A(140), MCENT);

    await investVault.discreteEarning(-_A(50));
    expect(await vault.totalAssets()).to.closeTo(_A(90), MCENT);
  });

  it("Withdraws and reduces the assets", async () => {
    const { USDC, investVault, vault, lp } = await setUpCommon();
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await vault.totalAssets()).to.equal(_A(100));

    await vault.connect(lp).withdraw(_A(80), lp, lp);
    expect(await vault.totalAssets()).to.equal(_A(20));

    await investVault.discreteEarning(_A(40));
    expect(await vault.totalAssets()).to.closeTo(_A(60), MCENT);

    await vault.connect(lp).redeem(_A(20), lp, lp);

    expect(await USDC.balanceOf(lp)).to.closeTo(_A(INITIAL + 40), MCENT);
  });

  it("Checks maxWithdraw and maxDeposit reflect the limits of the investVault", async () => {
    const { investVault, vault, lp, strategy } = await setUpCommon();

    await investVault.setOverride(OverrideOption.deposit, _A(10));

    await expect(vault.connect(lp).deposit(_A(100), lp)).to.be.revertedWithCustomError(
      vault,
      "ERC4626ExceededMaxDeposit"
    );
    expect(await strategy.maxDeposit(vault)).to.equal(_A(10));

    await vault.connect(lp).deposit(_A(10), lp);
    expect(await vault.totalAssets()).to.equal(_A(10));

    await investVault.setOverride(OverrideOption.withdraw, _A(0));

    await expect(vault.connect(lp).withdraw(_A(9), lp, lp)).to.be.revertedWithCustomError(
      vault,
      "ERC4626ExceededMaxWithdraw"
    );
    expect(await strategy.maxWithdraw(vault)).to.equal(_A(0));

    await investVault.setOverride(OverrideOption.withdraw, await investVault.OVERRIDE_UNSET());

    const maxWithdraw = await strategy.maxWithdraw(vault);
    expect(maxWithdraw).to.closeTo(_A(10), MCENT);

    await vault.connect(lp).withdraw(maxWithdraw, lp, lp);
    expect(await vault.totalAssets()).to.equal(_A(0));
  });

  it("Checks methods can't be called directly", async () => {
    const { strategy } = await setUpCommon();

    await expect(strategy.getFunction("connect")(ethers.toUtf8Bytes(""))).to.be.revertedWithCustomError(
      strategy,
      "CanBeCalledOnlyThroughDelegateCall"
    );

    await expect(strategy.disconnect(false)).to.be.revertedWithCustomError(
      strategy,
      "CanBeCalledOnlyThroughDelegateCall"
    );

    await expect(strategy.deposit(123)).to.be.revertedWithCustomError(strategy, "CanBeCalledOnlyThroughDelegateCall");

    await expect(strategy.withdraw(123)).to.be.revertedWithCustomError(strategy, "CanBeCalledOnlyThroughDelegateCall");

    await expect(strategy.forwardEntryPoint(1, ethers.toUtf8Bytes(""))).to.be.revertedWithCustomError(
      strategy,
      "CanBeCalledOnlyThroughDelegateCall"
    );
  });

  it("Checks forwardToStrategy fails with any input", async () => {
    const { vault } = await setUpCommon();
    await expect(vault.forwardToStrategy(123, ethers.toUtf8Bytes(""))).to.be.reverted;
  });

  it("Verifies an investVault with a different asset doesn't work", async () => {
    const { setupVault, investVault, admin, SingleStrategyERC4626, ERC4626InvestStrategy } =
      await helpers.loadFixture(setUp);
    const strategy = await ERC4626InvestStrategy.deploy(investVault);
    const EURC = await initCurrency(
      {
        name: "Euro",
        symbol: "EURC",
        decimals: 6,
        initial_supply: _A(50000),
        extraArgs: [admin],
      },
      [],
      []
    );
    await expect(setupVault(EURC, strategy)).to.be.revertedWithCustomError(
      SingleStrategyERC4626,
      "InvalidStrategyAsset"
    );
  });

  it("Verifies connect doesn't accept extra data", async () => {
    const { setupVault, investVault, USDC, ERC4626InvestStrategy } = await helpers.loadFixture(setUp);
    const strategy = await ERC4626InvestStrategy.deploy(investVault);
    await expect(setupVault(USDC, strategy, ethers.toUtf8Bytes("foobar"))).to.be.revertedWithCustomError(
      strategy,
      "NoExtraDataAllowed"
    );
  });

  it("Checks the strategy can't be disconnected with assets unless forced", async () => {
    const { USDC, investVault, vault, lp, DummyInvestStrategy, admin, strategy } = await setUpCommon();
    await vault.connect(lp).deposit(_A(100), lp);

    const dummy = await DummyInvestStrategy.deploy(USDC);

    await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), admin);

    expect(await investVault.totalAssets()).to.equal(_A(100));
    expect(await strategy.totalAssets(vault)).to.equal(_A(100));

    // This works fine because the funds are withdrawn from strategy and deposited into dummy
    await vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), false);

    expect(await strategy.totalAssets(vault)).to.equal(_A(0));
    expect(await vault.totalAssets()).to.equal(_A(100));

    // Reconnect the strategy
    await vault.connect(admin).setStrategy(strategy, ethers.toUtf8Bytes(""), false);

    // Now set maxWithdraw to 10
    await investVault.setOverride(OverrideOption.withdraw, _A(10));
    await expect(vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), false)).to.be.revertedWithCustomError(
      vault,
      "ERC4626ExceededMaxWithdraw"
    );
    await investVault.setOverride(OverrideOption.withdraw, await investVault.OVERRIDE_UNSET());
    await investVault.setBroken(true);

    await expect(vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), false)).to.be.revertedWithCustomError(
      investVault,
      "VaultIsBroken"
    );
    // But with forced disconnect works fine
    await vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), true);
  });

  it("Checks the strategy can't be disconnected with SHARES in the investVault unless forced", async () => {
    const { USDC, investVault, vault, lp, DummyInvestStrategy, admin, strategy } = await setUpCommon();
    await vault.connect(lp).deposit(_A(100), lp);

    const dummy = await DummyInvestStrategy.deploy(USDC);

    await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), admin);

    await investVault.discreteEarning(-_A(100));
    expect(await vault.totalAssets()).to.equal(_A(0));

    await expect(vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), false)).to.be.revertedWithCustomError(
      strategy,
      "CannotDisconnectWithAssets"
    );

    await expect(vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), true)).not.to.be.reverted;
  });
});
