const { expect } = require("chai");
const { amountFunction, getRole } = require("@ensuro/utils/js/utils");
const { WEEK, DAY } = require("@ensuro/utils/js/constants");
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

    // Use getContractAt instead of attach to avoid errors with emit assertions
    const vaultAsLOM = await ethers.getContractAt("LimitOutflowModifier", await ethers.resolveAddress(proxy));
    await vaultAsLOM.LOM__setLimit(DAY, _A(1000));

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
    const { vault, lom } = await deployVault(1);
    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.withdrawQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));
    expect(await vault.depositQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));
    expect(await vault.strategies()).to.deep.equal(
      [await ethers.resolveAddress(strategies[0])].concat(Array(MAX_STRATEGIES - 1).fill(ZeroAddress))
    );
    expect(await vault.asset()).to.equal(currency);
    expect(await vault.totalAssets()).to.equal(0);
    expect(await lom.LOM__getLimit()).to.equal(_A(1000));
  });

  it("Handles withdrawal limits correctly for multiple LPs and ensures limits are respected across time periods", async () => {
    const { deployVault, lp, lp2, currency, admin } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(800), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;

    // Limit happens before the underlying vault limits, so in this case fails with LimitReached even when
    // it will fail anyway because lack of funds
    await expect(vault.connect(lp).withdraw(_A(5600), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await currency.connect(lp2).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp2);

    await expect(vault.connect(lp2).deposit(_A(2000), lp2)).not.to.be.reverted;
    await expect(vault.connect(lp2).withdraw(_A(400), lp2, lp2)).not.to.be.reverted;

    await expect(vault.connect(lp2).withdraw(_A(6700), lp2, lp2)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(WEEK);

    // Balance Of and other methods work as always
    expect(await vault.balanceOf(lp2)).to.equal(_A(1600));
    expect(await vault.convertToAssets(vault.balanceOf(lp))).to.equal(_A(3900));

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

    await helpers.time.increase(WEEK);

    await expect(vault.connect(lp).withdraw(_A(100), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(970), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await expect(vault.connect(lp).withdraw(_A(830), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(80), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(DAY);

    await expect(vault.connect(lp).withdraw(_A(80), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(DAY);
    // After two times the time slot, the first day withdrawals disapear

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

    await helpers.time.increase(WEEK);

    await expect(vault.connect(lp).withdraw(_A(1001), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).withdraw(_A(1000), lp, lp)).not.to.be.reverted;

    await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(DAY);

    await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(DAY);

    await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).not.to.be.reverted;

    await helpers.time.increase(DAY);

    await expect(vault.connect(lp).withdraw(_A(745), lp, lp)).not.to.be.reverted;

    await helpers.time.increase(DAY);

    await expect(vault.connect(lp).withdraw(_A(275), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await expect(vault.connect(lp).withdraw(_A(255), lp, lp)).not.to.be.reverted;
  });

  it("Prevents withdrawal for consecutive daily limits, but forgets two days ago withdrawals", async () => {
    const { deployVault, lp, currency, admin } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

    await helpers.time.increase(WEEK);

    await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
    await helpers.time.increase(DAY);
    await expect(vault.connect(lp).withdraw(_A(800), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).withdraw(_A(600), lp, lp)).not.to.be.reverted;
    // Fails because it reached the limit in the last two days
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(DAY);
    await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(100), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
  });

  it("Checks that change in slot size resets the limits", async () => {
    const { deployVault, lp, currency, admin } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

    await helpers.time.increase(WEEK);

    await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
    await helpers.time.increase(DAY);
    await expect(vault.connect(lp).withdraw(_A(600), lp, lp)).not.to.be.reverted;
    // Fails because it reached the limit in the last two days

    await expect(lom.LOM__setLimit(DAY / 2, _A(500)))
      .to.emit(lom, "LimitChanged")
      .withArgs(DAY / 2, _A(500));
    expect(await lom.LOM__getLimit()).to.equal(_A(500));
    expect(await lom.LOM__getSlotSize()).to.equal(DAY / 2);
    // Changing the slotSize resets the limits, so now we can withdraw
    await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await helpers.time.increase(DAY / 2);
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await helpers.time.increase(DAY / 2);
    await expect(vault.connect(lp).withdraw(_A(5), lp, lp)).not.to.be.reverted;
  });

  it("Allows accumulated withdrawals up to the daily limit and prevents exceeding it", async () => {
    const { deployVault, lp, currency, admin } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    const slotSize = DAY;
    let now = await helpers.time.latest();
    await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(5000));

    await helpers.time.increase(DAY * 15);

    now = await helpers.time.latest();

    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(0);

    await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(299), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(-999));

    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(-1000));
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    // This fails because the limit extends for TWO slots
    await helpers.time.increase(DAY);
    await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(DAY);

    await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(499), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;
  });

  it("Allows accumulated withdrawals up to the daily limit and prevents exceeding it - mint/redeem", async () => {
    const { deployVault, lp, currency, admin, strategies } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    const slotSize = DAY;
    let now = await helpers.time.latest();
    await expect(vault.connect(lp).mint(_A(5000), lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(5000));

    await currency.connect(lp).transfer(await strategies[0].other(), _A(2500)); // Give 2500 for free to the vault, now 1 share = 1.5 assets

    await helpers.time.increase(DAY * 15);

    now = await helpers.time.latest();

    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(0);

    await expect(vault.connect(lp).redeem(_A(300), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-450), 1n);
    await expect(vault.connect(lp).redeem(_A(400), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).redeem(_A(200), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).redeem(_A(166), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-999), 1n);

    await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    // This fails because the limit extends for TWO slots
    await helpers.time.increase(DAY);
    await expect(vault.connect(lp).redeem(_A(500), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    now = await helpers.time.latest();
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(0), 1n);

    await helpers.time.increase(DAY);
    now = await helpers.time.latest();

    await expect(vault.connect(lp).redeem(_A(500), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(-750));
    await expect(vault.connect(lp).redeem(_A(165), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-997.5), 1n);
    await expect(vault.connect(lp).redeem(_A(1), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-999), 1n);
  });

  it("Allows accumulated withdrawals up to the daily limit and prevents exceeding it - mint/redeem/deposit/withdraw", async () => {
    const { deployVault, lp, currency, admin, strategies } = await helpers.loadFixture(setUp);
    const { vault, lom } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);

    const slotSize = DAY;
    let now = await helpers.time.latest();
    await expect(vault.connect(lp).deposit(_A(3000), lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(3000));

    await helpers.time.increase(DAY * 15);

    now = await helpers.time.latest();

    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(0);
    // Mixing withdraws and redeems when ratio is 1 share = 1 asset
    await expect(vault.connect(lp).redeem(_A(300), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(-300));
    await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).redeem(_A(299), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(-999));

    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(-1000));
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await expect(vault.connect(lp).mint(_A(3000), lp)).not.to.be.reverted;
    // Minted _A(3000), actual slot is _A(3000) + (_A(-1000)) = _A(2000)
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(2000));
    await currency.connect(lp).transfer(await strategies[0].other(), _A(2500)); // Give 2500 for free to the vault, now 1 share = 1.5 assets

    await helpers.time.increase(DAY * 7);

    now = await helpers.time.latest();

    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(0);

    await expect(vault.connect(lp).redeem(_A(300), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-450), 1n);
    await expect(vault.connect(lp).redeem(_A(400), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).withdraw(_A(549), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-999), 1n);
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;

    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-1000), 1n);
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    // This fails because the limit extends for TWO slots
    await helpers.time.increase(DAY);
    await expect(vault.connect(lp).redeem(_A(500), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    await helpers.time.increase(DAY);

    now = await helpers.time.latest();

    await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;
    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.equal(_A(-300));
    await expect(vault.connect(lp).redeem(_A(500), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");
    await expect(vault.connect(lp).redeem(_A(300), lp, lp)).not.to.be.reverted;

    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-750), 1n);

    await expect(vault.connect(lp).withdraw(_A(249), lp, lp)).not.to.be.reverted;
    await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(lom, "LimitReached");

    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-999), 1n);

    await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;

    expect(await lom.LOM__getAssetsDelta(await lom.LOM__makeSlot(slotSize, now))).to.closeTo(_A(-1000), 1n);
  });

  it("Sets and resets delta using LOM__changeDelta correctly", async () => {
    const { deployVault, admin } = await helpers.loadFixture(setUp);

    const { lom } = await deployVault(2);
    const lomContract = await ethers.getContractAt("LimitOutflowModifier", lom);

    const slotSize = DAY;
    const currentTimestamp = await helpers.time.latest();

    const slotIndex = await lom.LOM__makeSlot(slotSize, currentTimestamp);

    await expect(lomContract.connect(admin).LOM__changeDelta(slotIndex, _A(1500)))
      .to.emit(lomContract, "DeltaManuallySet")
      .withArgs(slotIndex, 0, _A(1500));
    await expect(lomContract.connect(admin).LOM__changeDelta(slotIndex, _A(-250)))
      .to.emit(lomContract, "DeltaManuallySet")
      .withArgs(slotIndex, _A(1500), _A(1250));
  });
});
