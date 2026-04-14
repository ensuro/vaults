const { expect } = require("chai");
const { amountFunction, _W } = require("@ensuro/utils/js/utils");
const { initForkCurrency, setupChain } = require("@ensuro/utils/js/test-utils");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig, makeAllPublic } = require("./utils");
const { deployAMPProxy } = require("@ensuro/access-managed-proxy/js/deployProxy");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers;

const ADDRESSES = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDCWhale: "0x05ff6964D21e5dAE3b1010D5AE0465b3c450F381",
  AAVEv3: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  aUSDCv3: "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
  MORPHO_SKY_V2_VAULT: "0x56bfa6f53669B836D1E0Dfa5e99706b12c373ecf",
};

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const TEST_BLOCK = 24878000;
const CENT = _A("0.01");
const HOUR = 3600;
const DAY = HOUR * 24;
const MONTH = DAY * 30;
const INITIAL = 10000;
const NAME = "Ensuro MultiStrategy";
const SYMB = "USDCmulti";

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();
  const currency = await initForkCurrency(ADDRESSES.USDC, ADDRESSES.USDCWhale, [lp, lp2], [_A(INITIAL), _A(INITIAL)]);

  const adminAddr = await ethers.resolveAddress(admin);

  const AaveV3InvestStrategy = await ethers.getContractFactory("AaveV3InvestStrategy");
  const aaveStrategy = await AaveV3InvestStrategy.deploy(ADDRESSES.USDC, ADDRESSES.AAVEv3);

  const MorphoVaultV2InvestStrategy = await ethers.getContractFactory("MorphoVaultV2InvestStrategy");
  const morphoStrategy = await MorphoVaultV2InvestStrategy.deploy(ADDRESSES.MORPHO_SKY_V2_VAULT);

  const AccessManagedMSV = await ethers.getContractFactory("AccessManagedMSV");
  const AccessManager = await ethers.getContractFactory("AccessManager");
  const acMgr = await AccessManager.deploy(admin);
  const vault = await deployAMPProxy(
    AccessManagedMSV,
    [
      NAME,
      SYMB,
      await ethers.resolveAddress(currency),
      await Promise.all([aaveStrategy, morphoStrategy].map(ethers.resolveAddress)),
      [ethers.toUtf8Bytes(""), ethers.toUtf8Bytes("")],
      [0, 1],
      [0, 1],
    ],
    {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      acMgr,
      skipViewsAndPure: true,
    }
  );
  await makeAllPublic(vault, acMgr.connect(admin));
  await currency.connect(lp).approve(vault, MaxUint256);
  await currency.connect(lp2).approve(vault, MaxUint256);

  return {
    currency,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    AaveV3InvestStrategy,
    MorphoVaultV2InvestStrategy,
    AccessManagedMSV,
    aaveStrategy,
    morphoStrategy,
    vault,
    acMgr,
  };
}

describe("MultiStrategy Mainnet Fork Integration Tests", function () {
  before(async function () {
    await setupChain(TEST_BLOCK, "ALCHEMY_URL_MAINNET");
  });

  it("Can perform a basic smoke test", async function () {
    const { vault, currency, lp, lp2, admin, aaveStrategy, morphoStrategy, acMgr } = await helpers.loadFixture(setUp);
    expect(await vault.name()).to.equal(NAME);
    await vault.connect(lp).deposit(_A(5000), lp);
    await vault.connect(lp2).deposit(_A(7000), lp2);

    expect(await vault.totalAssets()).to.be.closeTo(_A(12000), CENT);

    await vault.connect(admin).rebalance(0, 1, _A(7000));

    expect(await aaveStrategy.totalAssets(vault)).to.closeTo(_A(5000), CENT);
    expect(await morphoStrategy.totalAssets(vault)).to.closeTo(_A(7000), CENT);

    await helpers.time.increase(MONTH);
    expect(await aaveStrategy.totalAssets(vault)).to.closeTo(_A("5009.419771"), CENT);
    expect(await morphoStrategy.totalAssets(vault)).to.be.gt(_A(7000));
    expect(await vault.totalAssets()).to.be.gt(_A(12000));

    // Withdraw all the funds
    await vault.connect(lp).redeem(_A(5000), lp, lp);
    await vault.connect(lp2).redeem(await vault.balanceOf(lp2), lp2, lp2);
    expect(await vault.totalAssets()).to.be.closeTo(_A("0"), CENT);

    expect(await currency.balanceOf(lp)).to.be.gt(_A(INITIAL));
    expect(await currency.balanceOf(lp2)).to.be.gt(_A(INITIAL));
  });
});
