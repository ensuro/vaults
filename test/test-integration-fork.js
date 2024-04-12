const { expect } = require("chai");
const { amountFunction, _W, getRole } = require("@ensuro/core/js/utils");
const { initForkCurrency, setupChain } = require("@ensuro/core/js/test-utils");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig } = require("./utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers;

const ADDRESSES = {
  // polygon mainnet addresses
  UNISWAP: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDCWhale: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  cUSDCv3: "0xF25212E676D1F7F89Cd72fFEe66158f541246445",
  REWARDS: "0x45939657d1CA34A8FA39A924B71D28Fe8431e581",
  COMP: "0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c",
  cUSDCv3_GUARDIAN: "0x8Ab717CAC3CbC4934E63825B88442F5810aAF6e5",
  AAVEv3: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  aUSDCv3: "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
  AAVEPoolConfigurator: "0x8145eddDf43f50276641b55bd3AD95944510021E",
  AAVEPoolAdmin: "0xDf7d0e6454DB638881302729F5ba99936EaAB233",
  COMP_CHAINLINK: "0x2A8758b7257102461BC958279054e372C2b1bDE6",
};

const ChainlinkABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { internalType: "uint80", name: "roundId", type: "uint80" },
      { internalType: "int256", name: "answer", type: "int256" },
      { internalType: "uint256", name: "startedAt", type: "uint256" },
      { internalType: "uint256", name: "updatedAt", type: "uint256" },
      { internalType: "uint80", name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const TEST_BLOCK = 55737565;
const CENT = _A("0.01");
const HOUR = 3600;
const DAY = HOUR * 24;
const MONTH = DAY * 30;
const INITIAL = 10000;
const NAME = "Ensuro MultiStrategy";
const SYMB = "USDCmulti";

const FEETIER = 3000;

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();
  const currency = await initForkCurrency(ADDRESSES.USDC, ADDRESSES.USDCWhale, [lp, lp2], [_A(INITIAL), _A(INITIAL)]);

  const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
  const swapLibrary = await SwapLibrary.deploy();

  const swapConfig = buildUniswapConfig(_W("0.00001"), FEETIER, ADDRESSES.UNISWAP);
  const adminAddr = await ethers.resolveAddress(admin);

  const CompoundV3InvestStrategy = await ethers.getContractFactory("CompoundV3InvestStrategy", {
    libraries: {
      SwapLibrary: await ethers.resolveAddress(swapLibrary),
    },
  });
  const compoundStrategy = await CompoundV3InvestStrategy.deploy(ADDRESSES.cUSDCv3, ADDRESSES.REWARDS);
  const AaveV3InvestStrategy = await ethers.getContractFactory("AaveV3InvestStrategy");
  const aaveStrategy = await AaveV3InvestStrategy.deploy(ADDRESSES.USDC, ADDRESSES.AAVEv3);
  const MultiStrategyERC4626 = await ethers.getContractFactory("MultiStrategyERC4626");
  const vault = await hre.upgrades.deployProxy(
    MultiStrategyERC4626,
    [
      NAME,
      SYMB,
      adminAddr,
      await ethers.resolveAddress(currency),
      await Promise.all([aaveStrategy, compoundStrategy].map(ethers.resolveAddress)),
      [ethers.toUtf8Bytes(""), encodeSwapConfig(swapConfig)],
      [0, 1],
      [0, 1],
    ],
    {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
    }
  );
  await currency.connect(lp).approve(vault, MaxUint256);
  await currency.connect(lp2).approve(vault, MaxUint256);
  await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
  await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp2);
  await vault.connect(admin).grantRole(getRole("REBALANCER_ROLE"), admin);

  const COMPPrice = await ethers.getContractAt(ChainlinkABI, ADDRESSES.COMP_CHAINLINK);

  return {
    currency,
    swapConfig,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    swapLibrary,
    CompoundV3InvestStrategy,
    AaveV3InvestStrategy,
    MultiStrategyERC4626,
    aaveStrategy,
    compoundStrategy,
    vault,
    COMPPrice,
  };
}

const CompoundV3StrategyMethods = {
  harvestRewards: 0,
  setSwapConfig: 1,
};

describe("MultiStrategy Integration fork tests", function () {
  before(async () => {
    await setupChain(TEST_BLOCK);
  });

  it("Can perform a basic smoke test", async () => {
    const { vault, currency, lp, lp2, admin, aaveStrategy, compoundStrategy, COMPPrice } =
      await helpers.loadFixture(setUp);
    expect(await vault.name()).to.equal(NAME);
    await vault.connect(lp).deposit(_A(5000), lp);
    await vault.connect(lp2).deposit(_A(7000), lp2);

    expect(await vault.totalAssets()).to.be.closeTo(_A(12000), CENT);

    await vault.connect(admin).rebalance(0, 1, _A(7000));

    expect(await aaveStrategy.totalAssets(vault)).to.closeTo(_A(5000), CENT);
    expect(await compoundStrategy.totalAssets(vault)).to.closeTo(_A(7000), CENT);

    await helpers.time.increase(MONTH);
    expect(await aaveStrategy.totalAssets(vault)).to.closeTo(_A("5061.125277"), CENT);
    expect(await compoundStrategy.totalAssets(vault)).to.closeTo(_A("7060.519644"), CENT);
    expect(await vault.totalAssets()).to.be.closeTo(_A("12121.644921"), CENT);

    await vault.connect(admin).grantRole(getRole("HARVEST_ROLE"), admin);

    // Take the price from the oracle (8 decimals) and add 10 more to convert it to wad
    const compUSD = (await COMPPrice.latestRoundData())[1] * 10n ** 10n;

    await vault
      .connect(admin)
      .forwardToStrategy(
        1,
        CompoundV3StrategyMethods.harvestRewards,
        ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [compUSD])
      );

    expect(await compoundStrategy.totalAssets(vault)).to.closeTo(_A("7070.852454"), CENT);
    expect(await vault.totalAssets()).to.be.closeTo(_A("12131.977778"), CENT);

    // Withdraw all the funds
    await vault.connect(lp).redeem(_A(5000), lp, lp);
    await vault.connect(lp2).redeem(await vault.balanceOf(lp2), lp2, lp2);
    expect(await vault.totalAssets()).to.be.closeTo(_A("0"), CENT);

    expect(await currency.balanceOf(lp)).to.closeTo(_A(INITIAL) + _A("54.990740"), CENT);
    expect(await currency.balanceOf(lp2)).to.closeTo(_A(INITIAL) + _A("76.987037"), CENT);
  });
});
