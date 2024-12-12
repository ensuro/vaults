const { expect } = require("chai");
const { amountFunction, getRole } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { encodeDummyStorage } = require("./utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = hre.ethers;

const CURRENCY_DECIMALS = 6;
const MAX_STRATEGIES = 32;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Multi Strategy Vault";
const SYMB = "MSV";

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000), extraArgs: [admin] },
    [lp, lp2],
    [_A(INITIAL), _A(INITIAL)]
  );

  const adminAddr = await ethers.resolveAddress(admin);
  const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
  const strategies = await Promise.all(
    Array(MAX_STRATEGIES)
      .fill(0)
      .map(() => DummyInvestStrategy.deploy(currency))
  );
  const MultiStrategyERC4626 = await ethers.getContractFactory("MultiStrategyERC4626");
  const LimitOutflowModifier = await ethers.getContractFactory("LimitOutflowModifier");
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");

  async function deployVault(strategies_, initStrategyDatas, depositQueue, withdrawQueue) {
    const msv = await MultiStrategyERC4626.deploy();

    if (strategies_ === undefined) {
      strategies_ = strategies;
    } else if (typeof strategies_ == "number") {
      strategies_ = strategies.slice(0, strategies_);
    }
    if (initStrategyDatas === undefined) {
      initStrategyDatas = strategies_.map(() => encodeDummyStorage({}));
    }
    if (depositQueue === undefined) {
      depositQueue = strategies_.map((_, i) => i);
    }
    if (withdrawQueue === undefined) {
      withdrawQueue = strategies_.map((_, i) => i);
    }

    const initializeData = msv.interface.encodeFunctionData("initialize", [
      NAME,
      SYMB,
      adminAddr,
      await ethers.resolveAddress(currency),
      await Promise.all(strategies_.map(ethers.resolveAddress)),
      initStrategyDatas,
      depositQueue,
      withdrawQueue,
    ]);

    const lom = await LimitOutflowModifier.deploy(msv);
    const proxy = await ERC1967Proxy.deploy(lom, initializeData);
    const deploymentTransaction = proxy.deploymentTransaction();
    const vault = await ethers.getContractAt("MultiStrategyERC4626", await ethers.resolveAddress(proxy));
    vault.deploymentTransaction = () => deploymentTransaction;

    const vaultAsLOM = LimitOutflowModifier.attach(proxy);
    await vaultAsLOM.LOM__setLimit(3600 * 24, _A(1000));

    return {
      vault,
      lom: vaultAsLOM,
    };
  }

  return {
    currency,
    strategies,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    deployVault,
  };
}

describe("LOM-MSERC4626 contract tests", function () {
  it("Initializes the vault correctly", async () => {
    const { deployVault, currency, strategies } = await helpers.loadFixture(setUp);
    const { vault } = await deployVault(1);
    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.withdrawQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));
    expect(await vault.depositQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));
    expect(await vault.strategies()).to.deep.equal(
      [await ethers.resolveAddress(strategies[0])].concat(Array(MAX_STRATEGIES - 1).fill(ZeroAddress))
    );
    expect(await vault.asset()).to.equal(currency);
    expect(await vault.totalAssets()).to.equal(0);
  });

  it("Handles withdrawal limits correctly for multiple LPs and ensures limits are respected across time periods", async () => {
    const { deployVault, lp, lp2, currency, admin } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(800), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(5600), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await currency.connect(lp2).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp2);

    await expect(vault.connect(lp2).deposit(_A(2000), lp2)).not.to.be.reverted;
    await expect(vault.connect(lp2).withdraw(_A(400), lp2, lp2)).not.to.be.reverted;

    await expect(vault.connect(lp2).withdraw(_A(6700), lp2, lp2)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(3600 * 24 * 7);

    await expect(vault.connect(lp).withdraw(_A(320), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp2).withdraw(_A(680), lp2, lp2)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(700), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp2).withdraw(_A(800), lp2, lp2)).to.be.revertedWithCustomError(lom, "LimitReached");
  });

  it("Respects withdrawal limits and resets daily limit after time advancement", async () => {
    const { deployVault, lp, currency, admin } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

    await helpers.time.increase(3600 * 24 * 7);

    await expect(vault.connect(lp).withdraw(_A(100), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(970), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await expect(vault.connect(lp).withdraw(_A(830), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(80), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(3600 * 24);

    await expect(vault.connect(lp).withdraw(_A(80), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(3600 * 24 * 4);

    await expect(vault.connect(lp).withdraw(_A(80), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(920), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(65), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
  });

  it("Prevents withdrawal when combined daily limits from consecutive slots are surpassed", async () => {
    const { deployVault, lp, currency, admin } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

    await helpers.time.increase(3600 * 24 * 7);

    await expect(vault.connect(lp).withdraw(_A(1001), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).withdraw(_A(1000), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(3600 * 24);

    await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(3600 * 24);

    await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).not.to.be.reverted;

    await helpers.time.increase(3600 * 24);

    await expect(vault.connect(lp).withdraw(_A(745), lp, lp)).not.to.be.reverted;

    await helpers.time.increase(3600 * 24);

    await expect(vault.connect(lp).withdraw(_A(275), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await expect(vault.connect(lp).withdraw(_A(255), lp, lp)).not.to.be.reverted;
  });

  it("Allows accumulated withdrawals up to the daily limit and prevents exceeding it", async () => {
    const { deployVault, lp, currency, admin } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

    await helpers.time.increase(3600 * 24 * 15);

    await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(299), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(3600 * 24 - 1);
    await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(3600 * 24);

    await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(499), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;
  });

  it("Sets and resets delta using LOM__resetDelta correctly", async () => {
    const { deployVault, admin } = await helpers.loadFixture(setUp);

    const { lom } = await deployVault(2);
    const lomContract = await ethers.getContractAt("LimitOutflowModifier", lom);

    const slotSize = 3600 * 24;
    const currentTimestamp = await ethers.provider.getBlock("latest").then((block) => block.timestamp);
    const currentSlot = Math.floor(currentTimestamp / slotSize);

    const slotIndex = `${currentSlot}0000000000000000${slotSize}`;

    const newDelta = _A(1500);
    const initialDelta = _A(1000);
    await lomContract.connect(admin).LOM__resetDelta(slotIndex, initialDelta);
    await expect(lomContract.connect(admin).LOM__resetDelta(slotIndex, newDelta))
      .to.emit(lomContract, "DeltaManuallySet")
      .withArgs(slotIndex, initialDelta, newDelta);
  });
});
