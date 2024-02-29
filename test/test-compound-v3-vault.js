const { expect } = require("chai");
const {
  amountFunction,
  _W,
  getRole,
} = require("@ensuro/core/js/utils");
const { initForkCurrency, setupChain } = require("@ensuro/core/js/test-utils");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
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
};

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const TEST_BLOCK = 54090000;
const MCENT = 10n; // 1/1000 of a cent
const CENT = _A("0.01");
const HOUR = 3600;
const DAY = HOUR * 24;
const MONTH = DAY * 30;

describe("CompoundV3ERC4626 contract tests", function () {
  const NAME = "Compound USDCv3 Vault";
  const SYMB = "ecUSDCv3";

  const FEETIER = 3000;

  before(async () => {
    await setupChain(TEST_BLOCK);
  });

  async function setUp() {
    const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();
    const currency = await initForkCurrency(ADDRESSES.USDC, ADDRESSES.USDCWhale, [lp, lp2], [_A(10000), _A(10000)]);

    const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
    const library = await SwapLibrary.deploy();

    const CompoundV3ERC4626 = await ethers.getContractFactory("CompoundV3ERC4626", {
      libraries: {
        SwapLibrary: library.target,
      },
    });
    const swapConfig = buildUniswapConfig(_W("0.01"), FEETIER, ADDRESSES.UNISWAP);
    const adminAddr = await ethers.resolveAddress(admin);
    const vault = await hre.upgrades.deployProxy(CompoundV3ERC4626, [NAME, SYMB, adminAddr, swapConfig], {
      kind: "uups",
      constructorArgs: [ADDRESSES.cUSDCv3, ADDRESSES.REWARDS],
      unsafeAllow: ["external-library-linking"],
    });
    await currency.connect(lp).approve(vault, MaxUint256);
    await currency.connect(lp2).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp2);

    return {
      currency,
      CompoundV3ERC4626,
      swapConfig,
      vault,
      adminAddr,
      lp,
      lp2,
      anon,
      guardian,
      admin,
    };
  }

  it("Checks vault inititializes correctly", async () => {
    const { currency, vault, admin, anon } = await helpers.loadFixture(setUp);

    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.asset()).to.equal(currency);
    expect(await vault.totalAssets()).to.equal(0);
    expect(await vault.hasRole(getRole("DEFAULT_ADMIN_ROLE"), admin)).to.equal(true);
    expect(await vault.hasRole(getRole("DEFAULT_ADMIN_ROLE"), anon)).to.equal(false);
  });

  it("Checks vault constructs with disabled initializer", async () => {
    const { CompoundV3ERC4626, adminAddr, swapConfig } = await helpers.loadFixture(setUp);
    const newVault = await CompoundV3ERC4626.deploy(ADDRESSES.cUSDCv3, ADDRESSES.REWARDS);
    await expect(newVault.deploymentTransaction()).to.emit(newVault, "Initialized");
    await expect(newVault.initialize("foo", "bar", adminAddr, swapConfig)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Checks entering the vault is permissioned, exit isn't", async () => {
    const { currency, vault, anon, lp } = await helpers.loadFixture(setUp);

    await expect(vault.connect(anon).deposit(_A(100), anon)).to.be.revertedWith("ERC4626: deposit more than max");

    await expect(vault.connect(anon).mint(_A(100), anon)).to.be.revertedWith("ERC4626: mint more than max");

    await expect(vault.connect(lp).deposit(_A(100), lp))
      .to.emit(vault, "Deposit")
      .withArgs(lp, lp, _A(100), _A(100))
      .to.emit(currency, "Transfer")
      .withArgs(lp, vault, _A(100))
      .to.emit(currency, "Transfer")
      .withArgs(vault, ADDRESSES.cUSDCv3, _A(100));

    // Nothing stays in the vault
    expect(await currency.balanceOf(vault)).to.equal(0);

    await expect(vault.connect(anon).withdraw(_A(100), anon, anon)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );

    await vault.connect(lp).transfer(anon, _A(50));

    await expect(vault.connect(anon).withdraw(_A(50), anon, anon))
      .to.emit(vault, "Withdraw")
      .withArgs(anon, anon, anon, _A(50), anyUint)
      .to.emit(currency, "Transfer")
      .withArgs(ADDRESSES.cUSDCv3, vault, _A(50))
      .to.emit(currency, "Transfer")
      .withArgs(vault, anon, _A(50));
  });

  it("Checks vault accrues compound earnings", async () => {
    const { currency, vault, lp, lp2 } = await helpers.loadFixture(setUp);

    await expect(vault.connect(lp).mint(_A(1000), lp))
      .to.emit(vault, "Deposit")
      .withArgs(lp, lp, _A(1000), _A(1000))
      .to.emit(currency, "Transfer")
      .withArgs(lp, vault, _A(1000))
      .to.emit(currency, "Transfer")
      .withArgs(vault, ADDRESSES.cUSDCv3, _A(1000));

    expect(await vault.totalAssets()).to.be.closeTo(_A(1000), MCENT);

    await helpers.time.increase(MONTH);
    expect(await vault.totalAssets()).to.be.closeTo(_A("1009.522026"), MCENT);

    expect(await vault.balanceOf(lp)).to.be.equal(_A("1000"));
    expect(await vault.convertToAssets(_A(100))).to.be.closeTo(_A("100.9522"), MCENT);

    // Another LP deposits 2000 and gets less shares
    await expect(vault.connect(lp2).deposit(_A(2000), lp2))
      .to.emit(vault, "Deposit")
      .withArgs(lp2, lp2, _A(2000), anyUint)
      .to.emit(currency, "Transfer")
      .withArgs(lp2, vault, _A(2000))
      .to.emit(currency, "Transfer")
      .withArgs(vault, ADDRESSES.cUSDCv3, _A(2000));

    const lp2balance = await vault.balanceOf(lp2);
    expect(lp2balance).to.be.closeTo(_A("1981.13"), CENT);

    // Withdraws all the funds
    await vault.connect(lp).redeem(_A("1000"), lp, lp);
    await vault.connect(lp2).redeem(lp2balance, lp2, lp2);

    expect(await vault.totalAssets()).to.be.equal(0);

    expect(await currency.balanceOf(lp)).to.closeTo(_A("10009.522"), CENT);
    expect(await currency.balanceOf(lp2)).to.closeTo(_A("10000"), CENT);
  });
});
