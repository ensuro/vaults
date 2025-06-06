const { expect } = require("chai");
const { amountFunction, _W, getRole, getTransactionEvent, tagitVariant } = require("@ensuro/utils/js/utils");
const { DAY } = require("@ensuro/utils/js/constants");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig, encodeDummyStorage } = require("./utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256, ZeroAddress } = hre.ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Single Strategy Vault";
const SYMB = "SSV";

const SwapStableInvestStrategyMethods = {
  setSwapConfig: 0,
};

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();

  const SwapRouterMock = await ethers.getContractFactory("SwapRouterMock");
  const uniswapRouterMock = await SwapRouterMock.deploy(admin);

  const USDC = await initCurrency(
    {
      name: "Test Currency with 6 decimals",
      symbol: "USDC",
      decimals: 6,
      initial_supply: _A(50000),
      extraArgs: [admin],
    },
    [lp, lp2, uniswapRouterMock],
    [_A(INITIAL), _A(INITIAL), _A(INITIAL * 3)]
  );
  const WPOL = await initCurrency(
    {
      name: "Wrapped POL",
      symbol: "WPOL",
      decimals: 18,
      initial_supply: _W(50000),
      extraArgs: [admin],
    },
    [lp, lp2, uniswapRouterMock],
    [_W(INITIAL), _W(INITIAL), _W(INITIAL * 3)]
  );
  const COMP = await initCurrency(
    {
      name: "Compound",
      symbol: "COMP",
      decimals: 18,
      initial_supply: _W(50000),
      extraArgs: [admin],
    },
    [lp, lp2, uniswapRouterMock],
    [_W(INITIAL), _W(INITIAL), _W(INITIAL * 3)]
  );

  const adminAddr = await ethers.resolveAddress(admin);
  const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
  const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
  const swapLibrary = await SwapLibrary.deploy();
  const ChainlinkSwapAssetInvestStrategy = await ethers.getContractFactory("ChainlinkSwapAssetInvestStrategy", {
    libraries: {
      SwapLibrary: await ethers.resolveAddress(swapLibrary),
    },
  });
  const SingleStrategyERC4626 = await ethers.getContractFactory("SingleStrategyERC4626");
  const ChainlinkOracleMock = await ethers.getContractFactory("ChainlinkOracleMock");

  const now = await helpers.time.latest();

  const compOracle = await ChainlinkOracleMock.deploy(8, "COMP Oracle", 0);
  await compOracle.addRound(1, 40n * 10n ** 8n, 0, now, 0);
  const wpolOracle = await ChainlinkOracleMock.deploy(18, "WPOL Oracle", 0);
  await wpolOracle.addRound(1, (2n * 10n ** 18n) / 10n, 0, now, 0); // 0.2
  const usdcOracle = await ChainlinkOracleMock.deploy(18, "USDC Oracle", 0);
  await usdcOracle.addRound(1, _W(1), 0, now, 0); // 1

  // After this, the uniswapRouterMock has enough liquidity to execute swaps. Now only needs prices
  // Initializing the prices as 1:1
  await uniswapRouterMock.setCurrentPrice(COMP, USDC, _W(1 / 40));
  await uniswapRouterMock.setCurrentPrice(USDC, COMP, _W(40));
  await uniswapRouterMock.setCurrentPrice(WPOL, USDC, _W(1 / 0.2));
  await uniswapRouterMock.setCurrentPrice(USDC, WPOL, _W(0.2));

  const swapConfig = buildUniswapConfig(_W("0.001"), 100, uniswapRouterMock.target);

  async function setupVault(asset, strategy, strategyData = encodeSwapConfig(swapConfig)) {
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
    now,
    USDC,
    COMP,
    WPOL,
    usdcOracle,
    compOracle,
    wpolOracle,
    SingleStrategyERC4626,
    ChainlinkSwapAssetInvestStrategy,
    DummyInvestStrategy,
    adminAddr,
    swapLibrary,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    swapConfig,
    uniswapRouterMock,
    setupVault,
  };
}

function makeFixture(
  asset,
  investAsset,
  assetFn,
  investFn,
  hasAssetOracle = true,
  hasInvestOracle = true,
  priceTolerance = DAY
) {
  return async () => {
    const ret = await helpers.loadFixture(setUp);
    const assetOracle = hasAssetOracle ? ret[`${asset.toLowerCase()}Oracle`] : ZeroAddress;
    const investOracle = hasInvestOracle ? ret[`${investAsset.toLowerCase()}Oracle`] : ZeroAddress;
    return {
      ...ret,
      _a: assetFn,
      _i: investFn,
      asset: ret[`${asset}`],
      investAsset: ret[`${investAsset}`],
      assetOracle,
      investOracle,
      priceTolerance,
    };
  };
}

const variants = [
  {
    name: "USDC->COMP",
    fixture: makeFixture("USDC", "COMP", _A, _W),
    price: 40,
  },
  {
    name: "USDC->WPOL",
    fixture: makeFixture("USDC", "WPOL", _A, _W),
    price: 0.2,
  },
  {
    name: "USDC->COMP - No asset oracle",
    fixture: makeFixture("USDC", "COMP", _A, _W, false),
    price: 40,
  },
  {
    name: "USDC->WPOL - No asset oracle",
    fixture: makeFixture("USDC", "WPOL", _A, _W, false),
    price: 0.2,
  },
];

variants.forEach((variant) => {
  const it = (testDescription, test) => tagitVariant(variant, false, testDescription, test);
  it.only = (testDescription, test) => tagitVariant(variant, true, testDescription, test);

  describe(`ChainlinkSwapAssetInvestStrategy contract tests ${variant.name}`, function () {
    it("Initializes the vault correctly", async () => {
      const {
        ChainlinkSwapAssetInvestStrategy,
        setupVault,
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance,
      } = await variant.fixture();
      const strategy = await ChainlinkSwapAssetInvestStrategy.deploy(
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance
      );
      const vault = await setupVault(asset, strategy);
      expect(await vault.name()).to.equal(NAME);
      expect(await vault.symbol()).to.equal(SYMB);
      expect(await vault.strategy()).to.equal(strategy);
      expect(await vault.asset()).to.equal(asset);
      expect(await vault.totalAssets()).to.equal(0);
      expect(await strategy.asset(vault)).to.equal(asset);
      expect(await strategy.investAsset(vault)).to.equal(investAsset);
      expect(await strategy.priceTolerance()).to.equal(priceTolerance);
      expect(await strategy.assetOracle()).to.equal(assetOracle);
      expect(await strategy.investAssetOracle()).to.equal(investOracle);
    });

    it("Deposit and accounting works", async () => {
      const {
        ChainlinkSwapAssetInvestStrategy,
        setupVault,
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance,
        _a,
        _i,
        lp,
      } = await variant.fixture();
      const strategy = await ChainlinkSwapAssetInvestStrategy.deploy(
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance
      );
      const vault = await setupVault(asset, strategy);
      await vault.connect(lp).deposit(_a(100), lp);
      expect(await strategy.investAssetPrice()).to.closeTo(_W(variant.price), _W("0.0000001"));
      expect(await vault.totalAssets()).to.equal(_a("99.9")); // 0.01 slippage
      expect(await investAsset.balanceOf(vault)).to.equal(_i(100 / variant.price));
      expect(await asset.balanceOf(vault)).to.equal(_a(0));
    });

    it("Withdraw function executes swap correctly and emits correct events", async () => {
      const {
        ChainlinkSwapAssetInvestStrategy,
        setupVault,
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance,
        _a,
        _i,
        lp,
      } = await variant.fixture();
      const strategy = await ChainlinkSwapAssetInvestStrategy.deploy(
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance
      );
      const vault = await setupVault(asset, strategy);

      await vault.connect(lp).deposit(_a(100), lp);

      const initialBalanceInvestAsset = await investAsset.balanceOf(vault);

      await expect(vault.connect(lp).withdraw(_a(50), lp, lp))
        .to.emit(vault, "Withdraw")
        .withArgs(lp, lp, lp, _a(50), anyUint);

      expect(await investAsset.balanceOf(vault)).to.equal(initialBalanceInvestAsset - _i(50 / variant.price));

      await expect(vault.connect(lp).withdraw(_a(49.9), lp, lp))
        .to.emit(vault, "Withdraw")
        .withArgs(lp, lp, lp, _a(49.9), anyUint);

      expect(await investAsset.balanceOf(vault)).to.equal(_i(0.1 / variant.price));
    });

    it("Deposit and accounting works when price changes", async () => {
      const {
        ChainlinkSwapAssetInvestStrategy,
        setupVault,
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance,
        _a,
        now,
        lp,
      } = await variant.fixture();
      const strategy = await ChainlinkSwapAssetInvestStrategy.deploy(
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance
      );
      const vault = await setupVault(asset, strategy);
      await vault.connect(lp).deposit(_a(100), lp);
      expect(await vault.totalAssets()).to.equal(_a("99.9")); // 0.01 slippage

      // Increase price of the invest asset 20%
      await investOracle.addRound(
        2,
        BigInt(variant.price * 1.2 * 10000) * 10n ** ((await investOracle.decimals()) - 4n),
        now,
        now,
        0
      );
      expect(await strategy.investAssetPrice()).to.closeTo(_W(variant.price * 1.2), _W("0.0000001"));
      expect(await vault.totalAssets()).to.closeTo(_a(120 * 0.999), _a("0.01"));

      if (assetOracle === ZeroAddress) return;

      // Duplicate the price of the asset
      const [, oldAssetPrice] = await assetOracle.latestRoundData();
      await assetOracle.addRound(2, oldAssetPrice * 2n, now, now, 0);

      expect(await strategy.investAssetPrice()).to.closeTo(_W((variant.price * 1.2) / 2), _W("0.0000001"));
      expect(await vault.totalAssets()).to.closeTo(_a(60 * 0.999), _a("0.01"));
    });

    it("Fails when price is too old or invalid (<=0)", async () => {
      const {
        ChainlinkSwapAssetInvestStrategy,
        setupVault,
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance,
        _a,
        now,
        lp,
      } = await variant.fixture();
      const strategy = await ChainlinkSwapAssetInvestStrategy.deploy(
        asset,
        investAsset,
        assetOracle,
        investOracle,
        priceTolerance
      );
      const vault = await setupVault(asset, strategy);
      await vault.connect(lp).deposit(_a(100), lp);
      expect(await vault.totalAssets()).to.equal(_a("99.9")); // 0.01 slippage

      // Set price to 0
      await investOracle.addRound(2, 0, now, now, 0);
      await expect(strategy.investAssetPrice()).to.be.revertedWithCustomError(strategy, "InvalidPrice").withArgs(0);

      // Increase price of the invest asset 20%
      await investOracle.addRound(
        3,
        BigInt(variant.price * 1.2 * 10000) * 10n ** ((await investOracle.decimals()) - 4n),
        now,
        now,
        0
      );
      expect(await strategy.investAssetPrice()).to.closeTo(_W(variant.price * 1.2), _W("0.0000001"));
      expect(await vault.totalAssets()).to.closeTo(_a(120 * 0.999), _a("0.01"));

      if (assetOracle === ZeroAddress) return;

      // Duplicate the price of the asset but with an old update date
      const [, oldAssetPrice] = await assetOracle.latestRoundData();
      await assetOracle.addRound(3, oldAssetPrice * 2n, now, now - 2 * DAY, 0);
      await expect(strategy.investAssetPrice())
        .to.be.revertedWithCustomError(strategy, "PriceTooOld")
        .withArgs(now - 2 * DAY);
    });
  });
});
