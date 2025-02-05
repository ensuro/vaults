const { expect } = require("chai");
const { amountFunction, getRole } = require("@ensuro/utils/js/utils");
const { WEEK, DAY } = require("@ensuro/utils/js/constants");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { encodeDummyStorage, tagit, makeAllViewsPublic, mergeFragments, setupAMRole } = require("./utils");
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
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");

  return {
    currency,
    strategies,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    ERC1967Proxy,
    AccessManagedProxy,
  };
}

const variants = [
  {
    name: "AMProxy+OutflowLimitedAMMSV",
    tagit: tagit,
    accessManaged: true,
    accessError: "revertedWithAMError",
    fixture: async () => {
      const ret = await setUp();
      const { strategies, admin, currency } = ret;
      const OutflowLimitedAMMSV = await ethers.getContractFactory("OutflowLimitedAMMSV");
      const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");
      const AccessManager = await ethers.getContractFactory("AccessManager");
      const acMgr = await AccessManager.deploy(admin);
      const msv = await OutflowLimitedAMMSV.deploy();
      const combinedABI = mergeFragments(
        OutflowLimitedAMMSV.interface.fragments,
        AccessManagedProxy.interface.fragments
      );
      const roles = {
        LP_ROLE: 1,
        LOM_ADMIN: 2,
        REBALANCER_ROLE: 3,
        STRATEGY_ADMIN_ROLE: 4,
        QUEUE_ADMIN_ROLE: 5,
        FORWARD_TO_STRATEGY_ROLE: 6,
      };

      async function deployVault(strategies_, initStrategyDatas, depositQueue, withdrawQueue) {
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
          await ethers.resolveAddress(currency),
          await Promise.all(strategies_.map(ethers.resolveAddress)),
          initStrategyDatas,
          depositQueue,
          withdrawQueue,
        ]);
        const proxy = await AccessManagedProxy.deploy(msv, initializeData, acMgr);
        const deploymentTransaction = proxy.deploymentTransaction();
        const vault = await ethers.getContractAt(combinedABI, await ethers.resolveAddress(proxy));
        vault.deploymentTransaction = () => deploymentTransaction;
        await makeAllViewsPublic(acMgr.connect(admin), vault);

        await setupAMRole(acMgr.connect(admin), vault, roles, "LP_ROLE", [
          "withdraw",
          "deposit",
          "mint",
          "redeem",
          "transfer",
        ]);
        await setupAMRole(acMgr.connect(admin), vault, roles, "STRATEGY_ADMIN_ROLE", [
          "addStrategy",
          "replaceStrategy",
          "removeStrategy",
        ]);

        await setupAMRole(acMgr.connect(admin), vault, roles, "QUEUE_ADMIN_ROLE", [
          "changeDepositQueue",
          "changeWithdrawQueue",
        ]);

        await setupAMRole(acMgr.connect(admin), vault, roles, "REBALANCER_ROLE", ["rebalance"]);

        await setupAMRole(acMgr.connect(admin), vault, roles, "FORWARD_TO_STRATEGY_ROLE", ["forwardToStrategy"]);

        await vault.connect(admin).setupOutflowLimit(3600 * 24, _A(1000));

        return {
          vault,
        };
      }

      async function grantRole(_, role, user) {
        const roleId = role.startsWith("0x") ? role : roles[role];
        if (roleId === undefined) throw new Error(`Unknown role ${role}`);
        await acMgr.connect(admin).grantRole(roleId, user, 0);
      }

      async function grantForwardToStrategy(vault, strategyIndex, method, user) {
        await acMgr.connect(admin).grantRole(roles.FORWARD_TO_STRATEGY_ROLE, user, 0);
        const specificSelector = await vault.getForwardToStrategySelector(strategyIndex, method);
        await acMgr.connect(admin).setTargetFunctionRole(vault, [specificSelector], specificSelector);
        await acMgr.connect(admin).grantRole(specificSelector, user, 0);
      }

      return {
        deployVault,
        grantRole,
        grantForwardToStrategy,
        acMgr,
        OutflowLimitedAMMSV,
        ...ret,
      };
    },
  },
];

variants.forEach((variant) => {
  describe(`${variant.name} contract tests`, function () {
    it("Initializes the vault correctly", async () => {
      const { deployVault, currency, strategies } = await helpers.loadFixture(variant.fixture);
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
      expect(await vault.getOutflowLimit()).to.equal(_A(1000));
    });

    it("Handles withdrawal limits correctly for multiple LPs and ensures limits are respected across time periods", async () => {
      const { deployVault, lp, lp2, currency, grantRole } = await helpers.loadFixture(variant.fixture);
      const { vault } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);

      await expect(vault.connect(lp).deposit(_A(4000), lp)).not.to.be.reverted;

      await helpers.time.increase(WEEK);
      await expect(vault.connect(lp).deposit(_A(2000), lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(800), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;
      // So far: +900 Flow / +4900 total
      await expect(vault.connect(lp).withdraw(_A(2000), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await currency.connect(lp2).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp2);

      await expect(vault.connect(lp2).deposit(_A(2000), lp2)).not.to.be.reverted;
      await expect(vault.connect(lp2).withdraw(_A(400), lp2, lp2)).not.to.be.reverted;
      // So far: +2500 Flow / +6500
      await expect(vault.connect(lp).withdraw(_A(3501), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await helpers.time.increase(WEEK);

      // Balance Of and other methods work as always
      expect(await vault.balanceOf(lp2)).to.equal(_A(1600));
      expect(await vault.convertToAssets(vault.balanceOf(lp))).to.equal(_A(4900));

      await expect(vault.connect(lp).withdraw(_A(320), lp, lp)).not.to.be.reverted;

      await expect(vault.connect(lp2).withdraw(_A(680), lp2, lp2)).not.to.be.reverted;

      await expect(vault.connect(lp).withdraw(_A(700), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp2).withdraw(_A(800), lp2, lp2)).to.be.revertedWithCustomError(vault, "LimitReached");
    });

    it("Respects withdrawal limits and resets daily limit after time advancement", async () => {
      const { deployVault, lp, currency, grantRole } = await helpers.loadFixture(variant.fixture);
      const { vault } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);

      await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

      await helpers.time.increase(WEEK);

      await expect(vault.connect(lp).withdraw(_A(100), lp, lp)).not.to.be.reverted;

      await expect(vault.connect(lp).withdraw(_A(970), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await expect(vault.connect(lp).withdraw(_A(830), lp, lp)).not.to.be.reverted;

      await expect(vault.connect(lp).withdraw(_A(80), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await helpers.time.increase(DAY);

      await expect(vault.connect(lp).withdraw(_A(80), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await helpers.time.increase(DAY);
      // After two times the time slot, the first day withdrawals disapear

      await expect(vault.connect(lp).withdraw(_A(80), lp, lp)).not.to.be.reverted;

      await expect(vault.connect(lp).withdraw(_A(920), lp, lp)).not.to.be.reverted;

      await expect(vault.connect(lp).withdraw(_A(65), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
    });

    it("Prevents withdrawal when combined daily limits from consecutive slots are surpassed", async () => {
      const { deployVault, lp, currency, grantRole } = await helpers.loadFixture(variant.fixture);
      const { vault } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);

      await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

      await helpers.time.increase(WEEK);

      await expect(vault.connect(lp).withdraw(_A(1001), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).withdraw(_A(1000), lp, lp)).not.to.be.reverted;

      await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await helpers.time.increase(DAY);

      await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await helpers.time.increase(DAY);

      await expect(vault.connect(lp).withdraw(_A(165), lp, lp)).not.to.be.reverted;

      await helpers.time.increase(DAY);

      await expect(vault.connect(lp).withdraw(_A(745), lp, lp)).not.to.be.reverted;

      await helpers.time.increase(DAY);

      await expect(vault.connect(lp).withdraw(_A(275), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await expect(vault.connect(lp).withdraw(_A(255), lp, lp)).not.to.be.reverted;
    });

    it("Prevents withdrawal for consecutive daily limits, but forgets two days ago withdrawals", async () => {
      const { deployVault, lp, currency, grantRole } = await helpers.loadFixture(variant.fixture);
      const { vault } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);

      await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

      await helpers.time.increase(WEEK);

      await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
      await helpers.time.increase(DAY);
      await expect(vault.connect(lp).withdraw(_A(800), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).withdraw(_A(600), lp, lp)).not.to.be.reverted;
      // Fails because it reached the limit in the last two days
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await helpers.time.increase(DAY);
      await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(100), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
    });

    it("Checks that change in slot size resets the limits", async () => {
      const { deployVault, lp, currency, grantRole, admin } = await helpers.loadFixture(variant.fixture);
      const { vault } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);

      await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;

      await helpers.time.increase(WEEK);

      await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
      await helpers.time.increase(DAY);
      await expect(vault.connect(lp).withdraw(_A(600), lp, lp)).not.to.be.reverted;
      // Fails because it reached the limit in the last two days
      await expect(vault.connect(admin).setupOutflowLimit(DAY / 2, _A(500)))
        .to.emit(vault, "LimitChanged")
        .withArgs(DAY / 2, _A(500));
      expect(await vault.getOutflowLimit()).to.equal(_A(500));
      expect(await vault.getOutflowLimitSlotSize()).to.equal(DAY / 2);
      // Changing the slotSize resets the limits, so now we can withdraw
      await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await helpers.time.increase(DAY / 2);
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await helpers.time.increase(DAY / 2);
      await expect(vault.connect(lp).withdraw(_A(5), lp, lp)).not.to.be.reverted;
    });

    it("Allows accumulated withdrawals up to the daily limit and prevents exceeding it", async () => {
      const { deployVault, lp, currency, grantRole } = await helpers.loadFixture(variant.fixture);
      const { vault } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);

      const slotSize = DAY;
      let now = await helpers.time.latest();
      await expect(vault.connect(lp).deposit(_A(5000), lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(5000));

      await helpers.time.increase(DAY * 15);

      now = await helpers.time.latest();

      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(0);

      await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(299), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(-999));

      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(-1000));
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      // This fails because the limit extends for TWO slots
      await helpers.time.increase(DAY);
      await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await helpers.time.increase(DAY);

      await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(499), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;
    });

    it("Allows accumulated withdrawals up to the daily limit and prevents exceeding it - mint/redeem", async () => {
      const { deployVault, lp, currency, grantRole, strategies } = await helpers.loadFixture(variant.fixture);
      const { vault } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);

      const slotSize = DAY;
      let now = await helpers.time.latest();
      await expect(vault.connect(lp).mint(_A(5000), lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(5000));
      await currency.connect(lp).transfer(await strategies[0].other(), _A(2500)); // Give 2500 for free to the vault, now 1 share = 1.5 assets

      await helpers.time.increase(DAY * 15);

      now = await helpers.time.latest();

      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(0);
      await expect(vault.connect(lp).redeem(_A(300), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-450), 1n);
      await expect(vault.connect(lp).redeem(_A(400), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).redeem(_A(200), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).redeem(_A(166), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-999), 1n);
      await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      // This fails because the limit extends for TWO slots
      await helpers.time.increase(DAY);
      await expect(vault.connect(lp).redeem(_A(500), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      now = await helpers.time.latest();
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(0), 1n);
      await helpers.time.increase(DAY);
      now = await helpers.time.latest();

      await expect(vault.connect(lp).redeem(_A(500), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(-750));
      await expect(vault.connect(lp).redeem(_A(165), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-997.5), 1n);
      await expect(vault.connect(lp).redeem(_A(1), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-999), 1n);
    });

    it("Allows accumulated withdrawals up to the daily limit and prevents exceeding it - mint/redeem/deposit/withdraw", async () => {
      const { deployVault, lp, currency, grantRole, strategies } = await helpers.loadFixture(variant.fixture);
      const { vault } = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);

      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);

      const slotSize = DAY;
      let now = await helpers.time.latest();
      await expect(vault.connect(lp).deposit(_A(3000), lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(3000));
      await helpers.time.increase(DAY * 15);

      now = await helpers.time.latest();

      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(0);
      // Mixing withdraws and redeems when ratio is 1 share = 1 asset
      await expect(vault.connect(lp).redeem(_A(300), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(-300));
      await expect(vault.connect(lp).withdraw(_A(400), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).redeem(_A(299), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(-999));

      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(-1000));
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await expect(vault.connect(lp).mint(_A(3000), lp)).not.to.be.reverted;
      // Minted _A(3000), actual slot is _A(3000) + (_A(-1000)) = _A(2000)
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(2000));
      await currency.connect(lp).transfer(await strategies[0].other(), _A(2500)); // Give 2500 for free to the vault, now 1 share = 1.5 assets

      await helpers.time.increase(DAY * 7);

      now = await helpers.time.latest();

      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(0);

      await expect(vault.connect(lp).redeem(_A(300), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-450), 1n);
      await expect(vault.connect(lp).redeem(_A(400), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).withdraw(_A(549), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-999), 1n);
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;

      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-1000), 1n);
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      // This fails because the limit extends for TWO slots
      await helpers.time.increase(DAY);
      await expect(vault.connect(lp).redeem(_A(500), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).withdraw(_A(500), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      await helpers.time.increase(DAY);

      now = await helpers.time.latest();

      await expect(vault.connect(lp).withdraw(_A(300), lp, lp)).not.to.be.reverted;
      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.equal(_A(-300));
      await expect(vault.connect(lp).redeem(_A(500), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");
      await expect(vault.connect(lp).redeem(_A(300), lp, lp)).not.to.be.reverted;

      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-750), 1n);

      await expect(vault.connect(lp).withdraw(_A(249), lp, lp)).not.to.be.reverted;
      await expect(vault.connect(lp).redeem(_A(1), lp, lp)).to.be.revertedWithCustomError(vault, "LimitReached");

      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-999), 1n);

      await expect(vault.connect(lp).withdraw(_A(1), lp, lp)).not.to.be.reverted;

      expect(await vault.getAssetsDelta(await vault.makeOutflowSlot(slotSize, now))).to.closeTo(_A(-1000), 1n);
    });

    it("Sets and resets delta using LOM__changeDelta correctly", async () => {
      const { deployVault, admin } = await helpers.loadFixture(variant.fixture);

      const { vault } = await deployVault(2);

      const slotSize = DAY;
      const currentTimestamp = await helpers.time.latest();
      const slotIndex = await vault.makeOutflowSlot(slotSize, currentTimestamp);

      await expect(vault.connect(admin).changeDelta(slotIndex, _A(1500)))
        .to.emit(vault, "DeltaManuallySet")
        .withArgs(slotIndex, 0, _A(1500));
      await expect(vault.connect(admin).changeDelta(slotIndex, _A(-250)))
        .to.emit(vault, "DeltaManuallySet")
        .withArgs(slotIndex, _A(1500), _A(1250));
    });
  });
});
