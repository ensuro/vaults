const { expect } = require("chai");
const { amountFunction, _W, getRole, getTransactionEvent } = require("@ensuro/core/js/utils");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig, encodeDummyStorage, tagit } = require("./utils");
const { initForkCurrency, setupChain } = require("@ensuro/core/js/test-utils");
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
const SLIPPAGE = _W("0.00015"); // 0.015%
const FEETIER = 100; // 0.01%
const TEST_BLOCK = 63671575;

const ADDRESSES = {
  // polygon mainnet addresses
  UNISWAP: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDCWhale: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  USDC_NATIVE: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  USDCNativeWhale: "0xD36ec33c8bed5a9F7B6630855f1533455b98a418",
  AAVEv3: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  aUSDCv3: "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
  aUSDCNATIVEv3: "0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD",
  AAVEPoolConfigurator: "0x8145eddDf43f50276641b55bd3AD95944510021E",
  AAVEPoolAdmin: "0xDf7d0e6454DB638881302729F5ba99936EaAB233",
};

const SwapStableAaveV3InvestStrategyMethods = {
  setSwapConfig: 0,
};

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();

  const USDC = await initForkCurrency(ADDRESSES.USDC, ADDRESSES.USDCWhale, [lp, lp2], [_A(INITIAL), _A(INITIAL)]);
  const USDC_NATIVE = await ethers.getContractAt("IERC20Metadata", ADDRESSES.USDC_NATIVE);
  const aToken = await ethers.getContractAt("IERC20Metadata", ADDRESSES.aUSDCNATIVEv3);

  const adminAddr = await ethers.resolveAddress(admin);

  const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
  const swapLibrary = await SwapLibrary.deploy();
  const swapLibraryAddress = await ethers.resolveAddress(swapLibrary);

  const SwapStableAaveV3InvestStrategy = await ethers.getContractFactory("SwapStableAaveV3InvestStrategy", {
    libraries: {
      SwapLibrary: swapLibraryAddress,
    },
  });

  const SingleStrategyERC4626 = await ethers.getContractFactory("SingleStrategyERC4626");

  const swapConfig = buildUniswapConfig(SLIPPAGE, FEETIER, ADDRESSES.UNISWAP);

  async function setupVault(assetAddress, strategyAddress, strategyData = encodeSwapConfig(swapConfig)) {
    const vault = await hre.upgrades.deployProxy(
      SingleStrategyERC4626,
      [
        NAME,
        SYMB,
        adminAddr,
        await ethers.resolveAddress(assetAddress),
        await ethers.resolveAddress(strategyAddress),
        strategyData,
      ],
      {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
      }
    );

    const assetContract = await ethers.getContractAt("IERC20", assetAddress);
    await assetContract.connect(lp).approve(vault, MaxUint256);
    await assetContract.connect(lp2).approve(vault, MaxUint256);

    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp.address);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp2.address);

    return vault;
  }

  return {
    USDC,
    USDC_NATIVE,
    aToken,
    SingleStrategyERC4626,
    SwapStableAaveV3InvestStrategy,
    adminAddr,
    swapLibrary: swapLibraryAddress,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    swapConfig,
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
      currA: ret.USDC,
      currB: ret.USDC_NATIVE,
      aToken: ret.aToken,
    };
  };
}

const variants = [
  {
    name: "A(6)->B(6) with AAVE",
    tagit: tagit,
    fixture: makeFixture("A", "B", _A, _A),
  },
];

variants.forEach((variant) => {
  describe(`SwapStableAaveV3InvestStrategy contract tests ${variant.name}`, function () {
    before(async () => {
      await setupChain(TEST_BLOCK);
    });

    variant.tagit("Initializes the vault correctly with AAVE", async () => {
      const { SwapStableAaveV3InvestStrategy, setupVault, currA, currB } = await variant.fixture();

      const strategy = await SwapStableAaveV3InvestStrategy.deploy(currA, currB, _W(1), ADDRESSES.AAVEv3);

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
      const { SwapStableAaveV3InvestStrategy, setupVault, currA, currB, aToken, lp, _a, _i } = await variant.fixture();
      const strategy = await SwapStableAaveV3InvestStrategy.deploy(currA, currB, _W(1), ADDRESSES.AAVEv3);
      const vault = await setupVault(currA, strategy);
      await vault.connect(lp).deposit(_a(100), lp);

      expect(await aToken.balanceOf(vault)).to.closeTo(_i(100), _i("0.001"));
      expect(await currA.balanceOf(vault)).to.equal(_a(0));
    });
  });
});
