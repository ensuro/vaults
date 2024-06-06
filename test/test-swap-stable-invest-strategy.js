const { expect } = require("chai");
const { amountFunction, _W, getRole, accessControlMessage } = require("@ensuro/core/js/utils");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig } = require("./utils");
const { initCurrency } = require("@ensuro/core/js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Single Strategy Vault";
const SYMB = "SSV";

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
});
