const { expect } = require("chai");
const { amountFunction, _W, getRole, getTransactionEvent } = require("@ensuro/core/js/utils");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig, encodeDummyStorage } = require("./utils");
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

  const currA = await initCurrency(
    { name: "Test Currency with 6 decimals", symbol: "USDA", decimals: 6, initial_supply: _A(50000) },
    [lp, lp2, uniswapRouterMock],
    [_A(INITIAL), _A(INITIAL), _A(INITIAL * 3)]
  );
  const currB = await initCurrency(
    { name: "Another test Currency with 6 decimals", symbol: "USDB", decimals: 6, initial_supply: _A(50000) },
    [lp, lp2, uniswapRouterMock],
    [_A(INITIAL), _A(INITIAL), _A(INITIAL * 3)]
  );
  const currM = await initCurrency(
    { name: "Test Currency with 18 decimals", symbol: "USDM", decimals: 18, initial_supply: _W(50000) },
    [lp, lp2, uniswapRouterMock],
    [_W(INITIAL), _W(INITIAL), _W(INITIAL * 3)]
  );

  // After this, the uniswapRouterMock has enough liquidity to execute swaps. Now only needs prices
  // Initializing the prices as 1:1
  await uniswapRouterMock.setCurrentPrice(currA, currB, _W(1));
  await uniswapRouterMock.setCurrentPrice(currB, currA, _W(1));
  await uniswapRouterMock.setCurrentPrice(currA, currM, _W(1));
  await uniswapRouterMock.setCurrentPrice(currM, currA, _W(1));
  await uniswapRouterMock.setCurrentPrice(currB, currM, _W(1));
  await uniswapRouterMock.setCurrentPrice(currM, currB, _W(1));

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
    currA,
    currB,
    currM,
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

describe("SwapStableInvestStrategy contract tests", function () {
  it("Initializes the vault correctly", async () => {
    const { SwapStableInvestStrategy, setupVault, currA, currB } = await helpers.loadFixture(setUp);

    const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
    const vault = await setupVault(currA, strategy);
    // To Do: check asset() and add another investAsset() view
    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.strategy()).to.equal(strategy);
    expect(await vault.asset()).to.equal(currA);
    expect(await vault.totalAssets()).to.equal(0);
  });

  it("Deposit and accounting works - currA(6) -> currB(6)", async () => {
    const { SwapStableInvestStrategy, setupVault, currA, currB, lp } = await helpers.loadFixture(setUp);
    const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
    const vault = await setupVault(currA, strategy);
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await vault.totalAssets()).to.equal(_A("99.9")); // 0.01 slippage
    expect(await currB.balanceOf(vault)).to.equal(_A(100));
    expect(await currA.balanceOf(vault)).to.equal(_A(0));
  });

  it("Deposit and accounting works - currA(6) -> currM(18)", async () => {
    const { SwapStableInvestStrategy, setupVault, currA, currM, lp } = await helpers.loadFixture(setUp);
    const strategy = await SwapStableInvestStrategy.deploy(currA, currM, _W(1));
    const vault = await setupVault(currA, strategy);
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await vault.totalAssets()).to.equal(_A("99.9")); // 0.01 slippage
    expect(await currM.balanceOf(vault)).to.equal(_W(100));
    expect(await currA.balanceOf(vault)).to.equal(_A(0));
  });

  it("Checks methods can't be called directly", async () => {
    const { SwapStableInvestStrategy, currA, currB } = await helpers.loadFixture(setUp);
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

    await expect(strategy.withdraw(123)).to.be.revertedWithCustomError(strategy, "CanBeCalledOnlyThroughDelegateCall");

    await expect(strategy.forwardEntryPoint(1, ethers.toUtf8Bytes(""))).to.be.revertedWithCustomError(
      strategy,
      "CanBeCalledOnlyThroughDelegateCall"
    );
  });

  it("Checks onlyRole modifier & setSwapConfig function", async () => {
    const { SwapStableInvestStrategy, currA, currB, anon, admin, swapConfig, setupVault, uniswapRouterMock } =
      await helpers.loadFixture(setUp);
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

  it("Should return the correct swap configuration", async () => {
    const { SwapStableInvestStrategy, setupVault, currA, currB, admin, anon, uniswapRouterMock } =
      await helpers.loadFixture(setUp);
    const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
    const vault = await setupVault(currA, strategy);

    const newSwapConfig = buildUniswapConfig(_W("0.001"), 200, uniswapRouterMock.target);
    const newSwapConfigAsBytes = encodeSwapConfig(newSwapConfig);

    await vault.connect(admin).grantRole(await getRole("SWAP_ADMIN_ROLE"), anon);

    await vault.connect(anon).forwardToStrategy(SwapStableInvestStrategyMethods.setSwapConfig, newSwapConfigAsBytes);

    expect(await strategy.getSwapConfig(vault, strategy)).to.deep.equal(newSwapConfig);
  });

  it("Withdraw function executes swap correctly and emits correct events - currA(6) -> currB(6)", async () => {
    const { SwapStableInvestStrategy, setupVault, currA, currB, lp } = await helpers.loadFixture(setUp);
    const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
    const vault = await setupVault(currA, strategy);

    await vault.connect(lp).deposit(_A(100), lp);

    const initialBalanceInvestAsset = await currB.balanceOf(vault);

    await expect(vault.connect(lp).withdraw(_A(50), lp, lp))
      .to.emit(vault, "Withdraw")
      .withArgs(lp, lp, lp, _A(50), anyUint);

    expect(await currB.balanceOf(vault)).to.equal(initialBalanceInvestAsset - _A(50));

    await expect(vault.connect(lp).withdraw(_A(49.9), lp, lp))
      .to.emit(vault, "Withdraw")
      .withArgs(lp, lp, lp, _A(49.9), anyUint);

    expect(await currB.balanceOf(vault)).to.equal(_A(0.1));
  });

  it("Withdraw function executes swap correctly and emits correct events - currA(6) -> currM(18)", async () => {
    const { SwapStableInvestStrategy, setupVault, currA, currM, lp } = await helpers.loadFixture(setUp);
    const strategy = await SwapStableInvestStrategy.deploy(currA, currM, _W(1));
    const vault = await setupVault(currA, strategy);

    await vault.connect(lp).deposit(_A(100), lp);

    await expect(vault.connect(lp).withdraw(_A(50), lp, lp))
      .to.emit(vault, "Withdraw")
      .withArgs(lp, lp, lp, _A(50), anyUint);

    expect(await currM.balanceOf(vault)).to.equal(ethers.parseUnits("50", 18));

    await expect(vault.connect(lp).withdraw(_A(49.9), lp, lp))
      .to.emit(vault, "Withdraw")
      .withArgs(lp, lp, lp, _A(49.9), anyUint);

    expect(await currM.balanceOf(vault)).to.equal(ethers.parseUnits("0.1", 18));
  });

  it("Withdraw function fails", async () => {
    const { SwapStableInvestStrategy, setupVault, currA, currM, lp } = await helpers.loadFixture(setUp);
    const strategy = await SwapStableInvestStrategy.deploy(currA, currM, _W(1));
    const vault = await setupVault(currA, strategy);

    await vault.connect(lp).deposit(_A(100), lp);

    await expect(vault.connect(lp).withdraw(_A(200), lp, lp)).to.be.revertedWith("ERC4626: withdraw more than max");

    await expect(vault.connect(lp).withdraw(_A(0), lp, lp)).to.be.revertedWith("AmountOut cannot be zero");
  });

  it("setStrategy should work and disconnect strategy when authorized", async function () {
    const { SwapStableInvestStrategy, setupVault, currA, currM, anon, admin } = await helpers.loadFixture(setUp);
    const strategy = await SwapStableInvestStrategy.deploy(currA, currM, _W(1));
    const vault = await setupVault(currA, strategy);

    const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
    const dummyStrategy = await DummyInvestStrategy.deploy(currA);

    await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), anon);

    const tx = await vault.connect(anon).setStrategy(dummyStrategy, encodeDummyStorage({}), true);

    await expect(tx).to.emit(vault, "StrategyChanged").withArgs(strategy, dummyStrategy);
  });

  it("Disconnect should fail when force false and with asset", async function () {
    const { SwapStableInvestStrategy, setupVault, currA, currB, lp, admin } = await helpers.loadFixture(setUp);
    const strategy = await SwapStableInvestStrategy.deploy(currA, currB, _W(1));
    const vault = await setupVault(currA, strategy);

    const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
    const dummyStrategy = await DummyInvestStrategy.deploy(currA);

    await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), lp);
    await expect(vault.connect(lp).setStrategy(dummyStrategy, encodeDummyStorage({}), false)).to.be.revertedWith(
      "AmountOut cannot be zero"
    );

    await vault.connect(lp).deposit(_A(100), lp);

    await expect(
      vault.connect(lp).setStrategy(dummyStrategy, encodeDummyStorage({}), false)
    ).to.be.revertedWithCustomError(strategy, "CannotDisconnectWithAssets");
  });
});
