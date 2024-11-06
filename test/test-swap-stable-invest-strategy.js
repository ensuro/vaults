const { expect } = require("chai");
const { amountFunction, _W, getRole, getTransactionEvent } = require("@ensuro/core/js/utils");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig, encodeDummyStorage, tagit } = require("./utils");
const { initCurrency } = require("@ensuro/core/js/test-utils");
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

const SwapStableInvestStrategyMethods = {
  setSwapConfig: 0,
};

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();

  const SwapRouterMock = await ethers.getContractFactory("SwapRouterMock");
  const uniswapRouterMock = await SwapRouterMock.deploy(admin);

  const USDA = await initCurrency(
    { name: "Test Currency with 6 decimals", symbol: "USDA", decimals: 6, initial_supply: _A(50000) },
    [lp, lp2, uniswapRouterMock],
    [_A(INITIAL), _A(INITIAL), _A(INITIAL * 3)]
  );
  const USDB = await initCurrency(
    { name: "Another test Currency with 6 decimals", symbol: "USDB", decimals: 6, initial_supply: _A(50000) },
    [lp, lp2, uniswapRouterMock],
    [_A(INITIAL), _A(INITIAL), _A(INITIAL * 3)]
  );
  const USDM = await initCurrency(
    { name: "Test Currency with 18 decimals", symbol: "USDM", decimals: 18, initial_supply: _W(50000) },
    [lp, lp2, uniswapRouterMock],
    [_W(INITIAL), _W(INITIAL), _W(INITIAL * 3)]
  );
  const USDX = await initCurrency(
    { name: "Test Currency with 18 decimals", symbol: "USDX", decimals: 18, initial_supply: _W(50000) },
    [lp, lp2, uniswapRouterMock],
    [_W(INITIAL), _W(INITIAL), _W(INITIAL * 3)]
  );

  // After this, the uniswapRouterMock has enough liquidity to execute swaps. Now only needs prices
  // Initializing the prices as 1:1
  await uniswapRouterMock.setCurrentPrice(USDA, USDB, _W(1));
  await uniswapRouterMock.setCurrentPrice(USDB, USDA, _W(1));
  await uniswapRouterMock.setCurrentPrice(USDA, USDM, _W(1));
  await uniswapRouterMock.setCurrentPrice(USDM, USDA, _W(1));
  await uniswapRouterMock.setCurrentPrice(USDB, USDM, _W(1));
  await uniswapRouterMock.setCurrentPrice(USDM, USDB, _W(1));
  // USDX only agains USDM
  await uniswapRouterMock.setCurrentPrice(USDM, USDX, _W(1));
  await uniswapRouterMock.setCurrentPrice(USDX, USDM, _W(1));

  const adminAddr = await ethers.resolveAddress(admin);
  const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
  const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
  const swapLibrary = await SwapLibrary.deploy();
  const SwapStableInvestStrategy = await ethers.getContractFactory("SwapStableInvestStrategy", {
    libraries: {
      SwapLibrary: await ethers.resolveAddress(swapLibrary),
    },
  });
  const SingleStrategyERC4626 = await ethers.getContractFactory("SingleStrategyERC4626");

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
    USDA,
    USDB,
    USDM,
    USDX,
    SingleStrategyERC4626,
    SwapStableInvestStrategy,
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

function makeFixture(asset, investAsset, assetFn, investFn) {
  return async () => {
    const ret = await helpers.loadFixture(setUp);
    return {
      ...ret,
      _a: assetFn,
      _i: investFn,
      currA: ret[`USD${asset}`],
      currB: ret[`USD${investAsset}`],
    };
  };
}

const variants = [
  {
    name: "A(6)->B(6)",
    tagit: tagit,
    fixture: makeFixture("A", "B", _A, _A),
  },
  {
    name: "A(6)->M(18)",
    tagit: tagit,
    fixture: makeFixture("A", "M", _A, _W),
  },
  {
    name: "M(18)->X(18)",
    tagit: tagit,
    fixture: makeFixture("M", "X", _W, _W),
  },
  {
    name: "M(18)->A(6)",
    tagit: tagit,
    fixture: makeFixture("M", "A", _W, _A),
  },
];

variants.forEach((variant) => {
  describe(`SwapStableInvestStrategy contract tests ${variant.name}`, function () {
    variant.tagit("Initializes the vault correctly", async () => {
      const { SwapStableInvestStrategy, setupVault, currA, currB } = await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
      const vault = await setupVault(currA, strategy);
      expect(await vault.name()).to.equal(NAME);
      expect(await vault.symbol()).to.equal(SYMB);
      expect(await vault.strategy()).to.equal(strategy);
      expect(await vault.asset()).to.equal(currA);
      expect(await vault.totalAssets()).to.equal(0);
      expect(await strategy.asset(vault)).to.equal(currA);
      expect(await strategy.investAsset(vault)).to.equal(currB);
    });

    variant.tagit("Deposit and accounting works", async () => {
      const { SwapStableInvestStrategy, setupVault, currA, currB, lp, _a, _i } = await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
      const vault = await setupVault(currA, strategy);
      await vault.connect(lp).deposit(_a(100), lp);
      expect(await vault.totalAssets()).to.equal(_a("99.9")); // 0.01 slippage
      expect(await currB.balanceOf(vault)).to.equal(_i(100));
      expect(await currA.balanceOf(vault)).to.equal(_a(0));
    });

    variant.tagit(
      "Withdraw function executes swap correctly and emits correct events - currA(6) -> currB(6)",
      async () => {
        const { SwapStableInvestStrategy, setupVault, currA, currB, lp, _a, _i } = await variant.fixture();
        const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
        const vault = await setupVault(currA, strategy);

        await vault.connect(lp).deposit(_a(100), lp);

        const initialBalanceInvestAsset = await currB.balanceOf(vault);

        await expect(vault.connect(lp).withdraw(_a(50), lp, lp))
          .to.emit(vault, "Withdraw")
          .withArgs(lp, lp, lp, _a(50), anyUint);

        expect(await currB.balanceOf(vault)).to.equal(initialBalanceInvestAsset - _i(50));

        await expect(vault.connect(lp).withdraw(_a(49.9), lp, lp))
          .to.emit(vault, "Withdraw")
          .withArgs(lp, lp, lp, _a(49.9), anyUint);

        expect(await currB.balanceOf(vault)).to.equal(_i(0.1));
      }
    );

    variant.tagit("Withdraw function fails", async () => {
      const { SwapStableInvestStrategy, setupVault, currA, currB, lp, _a } = await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
      const vault = await setupVault(currA, strategy);

      await vault.connect(lp).deposit(_a(100), lp);

      await expect(vault.connect(lp).withdraw(_a(200), lp, lp)).to.be.revertedWith("ERC4626: withdraw more than max");

      // withdraw(0) doesn't reverts
      await expect(vault.connect(lp).withdraw(_a(0), lp, lp)).not.to.be.reverted;
    });

    variant.tagit("Deposit and accounting works when price != 1", async () => {
      const { SwapStableInvestStrategy, setupVault, currA, currB, lp, _a, _i, uniswapRouterMock } =
        await variant.fixture();
      await uniswapRouterMock.setCurrentPrice(currA, currB, _W("0.5"));
      await uniswapRouterMock.setCurrentPrice(currB, currA, _W("2"));
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W("0.5")); // price = 0.5 A/B
      const vault = await setupVault(currA, strategy);
      await vault.connect(lp).deposit(_a(100), lp);
      expect(await vault.totalAssets()).to.equal(_a("99.9")); // 0.01 slippage
      expect(await currB.balanceOf(vault)).to.equal(_i(200));
      expect(await currA.balanceOf(vault)).to.equal(_a(0));

      await expect(vault.connect(lp).withdraw(_a(50), lp, lp))
        .to.emit(vault, "Withdraw")
        .withArgs(lp, lp, lp, _a(50), anyUint);
      expect(await currB.balanceOf(vault)).to.equal(_i(100));
      expect(await currA.balanceOf(vault)).to.equal(_a(0));
      expect(await currA.balanceOf(lp)).to.equal(_a(INITIAL) - _a(50));
    });

    variant.tagit("Deposit and accounting works when price != 1 and slippage", async () => {
      const { SwapStableInvestStrategy, setupVault, currA, currB, lp, _a, _i, uniswapRouterMock } =
        await variant.fixture();
      await uniswapRouterMock.setCurrentPrice(currA, currB, _W("0.49"));
      await uniswapRouterMock.setCurrentPrice(currB, currA, _W("2.001"));
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W("0.5")); // price = 0.5 A/B
      const vault = await setupVault(currA, strategy);
      await vault.connect(lp).deposit(_a(100), lp);
      expect(await vault.totalAssets()).to.closeTo(_a("101.94"), _a("0.005")); // ((100/.49)*.5) * (1-0.001) slippage
      expect(await currB.balanceOf(vault)).to.closeTo(_i("204.08"), _i("0.005")); // 100 / .49
      expect(await currA.balanceOf(vault)).to.equal(_a(0));

      await expect(vault.connect(lp).withdraw(_a(50), lp, lp))
        .to.emit(vault, "Withdraw")
        .withArgs(lp, lp, lp, _a(50), anyUint);
      expect(await currB.balanceOf(vault)).to.closeTo(_i("104.03"), _i("0.005"));
      expect(await currA.balanceOf(vault)).to.equal(_a(0));
      expect(await currA.balanceOf(lp)).to.equal(_a(INITIAL) - _a(50));
    });

    variant.tagit("Checks methods can't be called directly", async () => {
      const { SwapStableInvestStrategy, currA, currB } = await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));

      await expect(strategy.getFunction("connect")(ethers.toUtf8Bytes(""))).to.be.revertedWithCustomError(
        strategy,
        "CanBeCalledOnlyThroughDelegateCall"
      );

      await expect(strategy.disconnect(false)).to.be.revertedWithCustomError(
        strategy,
        "CanBeCalledOnlyThroughDelegateCall"
      );

      await expect(strategy.deposit(123)).to.be.revertedWithCustomError(strategy, "CanBeCalledOnlyThroughDelegateCall");

      await expect(strategy.withdraw(123)).to.be.revertedWithCustomError(
        strategy,
        "CanBeCalledOnlyThroughDelegateCall"
      );

      await expect(strategy.forwardEntryPoint(1, ethers.toUtf8Bytes(""))).to.be.revertedWithCustomError(
        strategy,
        "CanBeCalledOnlyThroughDelegateCall"
      );
    });

    variant.tagit("Checks onlyRole modifier & setSwapConfig function", async () => {
      const { SwapStableInvestStrategy, currA, currB, anon, admin, swapConfig, setupVault, uniswapRouterMock } =
        await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
      const vault = await setupVault(currA, strategy);
      const newSwapConfig = buildUniswapConfig(_W("0.001"), 200, uniswapRouterMock.target);
      const newSwapConfigAsBytes = encodeSwapConfig(newSwapConfig);
      const modifiedSwapConfig = [...newSwapConfig, "extraData"];
      // Just for out attempt to call setSwapConfig with extra data, encodeSwapConfig only accepts three elements in out tuple.
      const modifiedSwapConfigAsBytes = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8, uint256, bytes, string)"],
        [modifiedSwapConfig]
      );

      await expect(
        vault.connect(anon).forwardToStrategy(SwapStableInvestStrategyMethods.setSwapConfig, newSwapConfigAsBytes)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");

      await vault.connect(admin).grantRole(await getRole("SWAP_ADMIN_ROLE"), anon);

      let tx = await vault
        .connect(anon)
        .forwardToStrategy(SwapStableInvestStrategyMethods.setSwapConfig, newSwapConfigAsBytes);
      let receipt = await tx.wait();
      let evt = getTransactionEvent(strategy.interface, receipt, "SwapConfigChanged");

      expect(evt).not.equal(null);

      expect(evt.args.oldConfig).to.deep.equal(swapConfig);
      expect(evt.args.newConfig).to.deep.equal(newSwapConfig);

      // We attempt to call setSwapConfig with extra data (e.g., modifiedSwapConfig --> modifiedSwapConfigAsBytes).
      await expect(
        vault.connect(anon).forwardToStrategy(SwapStableInvestStrategyMethods.setSwapConfig, modifiedSwapConfigAsBytes)
      ).to.be.revertedWithCustomError(strategy, "NoExtraDataAllowed");
    });

    variant.tagit("Should return the correct swap configuration", async () => {
      const { SwapStableInvestStrategy, setupVault, currA, currB, admin, anon, uniswapRouterMock } =
        await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
      const vault = await setupVault(currA, strategy);

      const newSwapConfig = buildUniswapConfig(_W("0.001"), 200, uniswapRouterMock.target);
      const newSwapConfigAsBytes = encodeSwapConfig(newSwapConfig);

      await vault.connect(admin).grantRole(await getRole("SWAP_ADMIN_ROLE"), anon);

      await vault.connect(anon).forwardToStrategy(SwapStableInvestStrategyMethods.setSwapConfig, newSwapConfigAsBytes);

      expect(await strategy.getSwapConfig(vault, strategy)).to.deep.equal(newSwapConfig);
    });

    variant.tagit("setStrategy should work and disconnect strategy when authorized", async function () {
      const { SwapStableInvestStrategy, setupVault, currA, currB, anon, admin } = await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
      const vault = await setupVault(currA, strategy);

      const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
      const dummyStrategy = await DummyInvestStrategy.deploy(currA);

      await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), anon);

      const tx = await vault.connect(anon).setStrategy(dummyStrategy, encodeDummyStorage({}), true);

      await expect(tx).to.emit(vault, "StrategyChanged").withArgs(strategy, dummyStrategy);
    });

    variant.tagit("Disconnect doesn't fail when changing strategy", async function () {
      const { SwapStableInvestStrategy, setupVault, currA, currB, lp, admin, _a } = await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
      const vault = await setupVault(currA, strategy);

      const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
      const dummyStrategy = await DummyInvestStrategy.deploy(currA);

      await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), lp);
      await vault.connect(lp).deposit(_a(100), lp);

      await expect(vault.connect(lp).setStrategy(dummyStrategy, encodeDummyStorage({}), false)).not.to.be.reverted;
    });

    variant.tagit("Disconnect without assets doesn't revert", async function () {
      const { SwapStableInvestStrategy, setupVault, currA, currB, lp, admin } = await variant.fixture();
      const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
      const vault = await setupVault(currA, strategy);

      const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
      const dummyStrategy = await DummyInvestStrategy.deploy(currA);

      await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), lp);
      // Without assets, it doesn't revert
      await expect(vault.connect(lp).setStrategy(dummyStrategy, encodeDummyStorage({}), false)).not.to.be.reverted;
    });
  });
});
