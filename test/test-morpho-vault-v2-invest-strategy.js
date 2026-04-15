const { expect } = require("chai");
const { amountFunction } = require("@ensuro/utils/js/utils");
const { encodeDummyStorage } = require("./utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
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

const ONE_DAY_SECONDS = 86400;

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();

  const USDC = await initCurrency(
    {
      name: "Test Currency with 6 decimals",
      symbol: "USDC",
      decimals: 6,
      initial_supply: _A(50000),
    },
    [lp, lp2],
    [_A(INITIAL), _A(INITIAL)]
  );

  const adminAddr = await ethers.resolveAddress(admin);
  const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
  const MorphoVaultV2InvestStrategy = await ethers.getContractFactory("MorphoVaultV2InvestStrategy");
  const SingleStrategyERC4626 = await ethers.getContractFactory("SingleStrategyERC4626");
  const VaultV2Mock = await ethers.getContractFactory("VaultV2Mock");
  const investVault = await VaultV2Mock.deploy("Morpho Vault V2", "MV2", USDC);

  async function setupVault(asset, strategy, strategyData = ethers.toUtf8Bytes("")) {
    const vault = await hre.upgrades.deployProxy(
      SingleStrategyERC4626,
      [NAME, SYMB, await ethers.resolveAddress(asset), await ethers.resolveAddress(strategy), strategyData],
      {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
      }
    );
    await asset.connect(lp).approve(vault, MaxUint256);
    await asset.connect(lp2).approve(vault, MaxUint256);
    return vault;
  }

  return {
    USDC,
    SingleStrategyERC4626,
    MorphoVaultV2InvestStrategy,
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
  const ret = await setUp();
  const strategy = await ret.MorphoVaultV2InvestStrategy.deploy(ret.investVault);
  const vault = await ret.setupVault(ret.USDC, strategy);
  return { ...ret, vault, strategy };
}

describe("MorphoVaultV2InvestStrategy contract tests", function () {
  it("Initializes the vault correctly", async () => {
    const { USDC, investVault, vault, strategy } = await helpers.loadFixture(setUpCommon);
    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.strategy()).to.equal(strategy);
    expect(await vault.asset()).to.equal(USDC);
    expect(await vault.totalAssets()).to.equal(0);
    expect(await strategy.asset(vault)).to.equal(USDC);
    expect(await strategy.investVault(vault)).to.equal(investVault);
  });

  it("Deposit and accounting works", async () => {
    const { USDC, investVault, vault, lp, strategy } = await helpers.loadFixture(setUpCommon);
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await vault.totalAssets()).to.equal(_A(100));
    expect(await investVault.convertToAssets(await investVault.balanceOf(vault))).to.equal(_A(100));

    expect(await USDC.allowance(vault, investVault)).to.equal(0);

    await investVault.discreteEarning(_A(40));

    // Profits not recorded until cached totalAssets updated
    expect(await strategy.totalAssets(vault)).to.closeTo(_A(100), MCENT);
    await investVault.updateCachedTotalAssets();
    expect(await strategy.totalAssets(vault)).to.closeTo(_A(140), MCENT);

    await investVault.discreteEarning(-_A(50));

    // Or... when cached totalAssets is too old
    expect(await strategy.totalAssets(vault)).to.closeTo(_A(140), MCENT);
    await helpers.time.increase(ONE_DAY_SECONDS + 1);
    expect(await strategy.totalAssets(vault)).to.closeTo(_A(90), MCENT);
  });

  it("Withdraws and reduces the assets", async () => {
    const { USDC, investVault, vault, lp, strategy } = await helpers.loadFixture(setUpCommon);
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await strategy.totalAssets(vault)).to.closeTo(_A(100), MCENT);

    await vault.connect(lp).withdraw(_A(80), lp, lp);
    expect(await strategy.totalAssets(vault)).to.closeTo(_A(20), MCENT);

    await investVault.discreteEarning(_A(40));
    expect(await strategy.totalAssets(vault)).to.closeTo(_A(20), MCENT);

    await investVault.updateCachedTotalAssets();
    expect(await strategy.totalAssets(vault)).to.closeTo(_A(60), MCENT);

    await vault.connect(lp).redeem(_A(20), lp, lp);
    expect(await USDC.balanceOf(lp)).to.closeTo(_A(INITIAL + 40), MCENT);
  });

  it("Checks maxWithdraw returns totalAssets and maxDeposit returns type(uint256).max", async () => {
    const { vault, lp, strategy } = await helpers.loadFixture(setUpCommon);

    await vault.connect(lp).deposit(_A(100), lp);
    expect(await strategy.maxDeposit(vault)).to.equal(MaxUint256);
    expect(await strategy.maxWithdraw(vault)).to.equal(_A(100));
  });

  it("Checks methods can't be called directly", async () => {
    const { strategy } = await helpers.loadFixture(setUpCommon);

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
    const { vault } = await helpers.loadFixture(setUpCommon);
    await expect(vault.forwardToStrategy(123, ethers.toUtf8Bytes(""))).to.be.reverted;
  });

  it("Verifies an investVault with a different asset doesn't work", async () => {
    const { setupVault, investVault, SingleStrategyERC4626, MorphoVaultV2InvestStrategy } =
      await helpers.loadFixture(setUp);
    const strategy = await MorphoVaultV2InvestStrategy.deploy(investVault);
    const EURC = await initCurrency(
      {
        name: "Euro",
        symbol: "EURC",
        decimals: 6,
        initial_supply: _A(50000),
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
    const { setupVault, investVault, USDC, MorphoVaultV2InvestStrategy } = await helpers.loadFixture(setUp);
    const strategy = await MorphoVaultV2InvestStrategy.deploy(investVault);
    await expect(setupVault(USDC, strategy, ethers.toUtf8Bytes("foobar"))).to.be.revertedWithCustomError(
      strategy,
      "NoExtraDataAllowed"
    );
  });

  it("Checks the strategy can't be disconnected with assets unless forced", async () => {
    const { USDC, investVault, vault, lp, DummyInvestStrategy, admin, strategy } =
      await helpers.loadFixture(setUpCommon);
    await vault.connect(lp).deposit(_A(100), lp);

    const dummy = await DummyInvestStrategy.deploy(USDC);

    expect(await investVault.totalAssets()).to.equal(_A(100));
    expect(await strategy.totalAssets(vault)).to.equal(_A(100));

    await vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), false);

    expect(await strategy.totalAssets(vault)).to.equal(_A(0));
    expect(await vault.totalAssets()).to.equal(_A(100));

    await vault.connect(admin).setStrategy(strategy, ethers.toUtf8Bytes(""), false);

    await investVault.setBroken(true);

    await expect(vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), false)).to.be.revertedWithCustomError(
      investVault,
      "VaultIsBroken"
    );
    await expect(vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), true)).not.to.be.reverted;
  });

  it("Checks the strategy can't be disconnected with SHARES in the investVault unless forced", async () => {
    const { USDC, investVault, vault, lp, DummyInvestStrategy, admin, strategy } =
      await helpers.loadFixture(setUpCommon);
    await vault.connect(lp).deposit(_A(100), lp);

    const dummy = await DummyInvestStrategy.deploy(USDC);

    await investVault.discreteEarning(-_A(100));
    expect(await investVault.totalAssets()).to.closeTo(_A(0), MCENT);

    expect(await strategy.totalAssets(vault)).to.closeTo(_A(100), MCENT);

    await expect(vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), false)).to.be.reverted;

    await expect(vault.connect(admin).setStrategy(dummy, encodeDummyStorage({}), true)).not.to.be.reverted;
  });

  it("Uses cached _totalAssets when lastUpdate is recent", async () => {
    const { investVault, vault, strategy, lp } = await helpers.loadFixture(setUpCommon);

    await vault.connect(lp).deposit(_A(100), lp);

    const shares = await investVault.balanceOf(vault);
    const cachedTotalAssets = await investVault._totalAssets();
    const totalSupply = await investVault.totalSupply();

    const expectedFromCached = (cachedTotalAssets * shares) / totalSupply;
    const actualTotalAssets = await strategy.totalAssets(vault);
    await investVault.discreteEarning(_A(1));

    expect(actualTotalAssets).to.equal(expectedFromCached);
  });

  it("Falls back to previewRedeem when cached is stale (> 1 day)", async () => {
    const { investVault, vault, strategy, lp } = await helpers.loadFixture(setUpCommon);

    await vault.connect(lp).deposit(_A(100), lp);
    await investVault.updateCachedTotalAssets();

    await helpers.time.increase(ONE_DAY_SECONDS + 1);

    const shares = await investVault.balanceOf(vault);
    const expectedFromPreview = await investVault.previewRedeem(shares);
    const actualTotalAssets = await strategy.totalAssets(vault);

    expect(actualTotalAssets).to.equal(expectedFromPreview);
  });
});
