const { expect } = require("chai");
const { _A, getRole } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { encodeDummyStorage, dummyStorage, tagit, makeAllViewsPublic, mergeFragments, setupAMRole } = require("./utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = hre.ethers;

const MAX_STRATEGIES = 32;
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

  return {
    currency,
    MultiStrategyERC4626,
    DummyInvestStrategy,
    strategies,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
  };
}

const variants = [
  {
    name: "MultiStrategyERC4626",
    tagit: tagit,
    accessError: "revertedWithACError",
    fixture: async () => {
      const ret = await setUp();
      const { strategies, MultiStrategyERC4626, adminAddr, currency, admin } = ret;
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
        return hre.upgrades.deployProxy(
          MultiStrategyERC4626,
          [
            NAME,
            SYMB,
            adminAddr,
            await ethers.resolveAddress(currency),
            await Promise.all(strategies_.map(ethers.resolveAddress)),
            initStrategyDatas,
            depositQueue,
            withdrawQueue,
          ],
          {
            kind: "uups",
            unsafeAllow: ["delegatecall"],
          }
        );
      }

      async function grantRole(vault, role, user) {
        await vault.connect(admin).grantRole(getRole(role), user);
      }

      async function grantForwardToStrategy(vault, strategyIndex, method, user) {
        await vault.connect(admin).grantRole(getRole("FORWARD_TO_STRATEGY_ROLE"), user);
        const specificRole = await vault.getForwardToStrategyRole(strategyIndex, method);
        await vault.connect(admin).grantRole(specificRole, user);
      }

      return {
        deployVault,
        grantRole,
        grantForwardToStrategy,
        ...ret,
      };
    },
  },
  {
    name: "AMProxy+LOM-AccessManagedMSV",
    tagit: tagit,
    accessManaged: true,
    accessError: "revertedWithAMError",
    fixture: async () => {
      const ret = await setUp();
      const { strategies, admin, currency } = ret;
      const AccessManagedMSV = await ethers.getContractFactory("AccessManagedMSV");
      const LimitOutflowModifier = await ethers.getContractFactory("LimitOutflowModifier");
      const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");
      const AccessManager = await ethers.getContractFactory("AccessManager");
      const acMgr = await AccessManager.deploy(admin);
      const msv = await AccessManagedMSV.deploy();
      const lom = await LimitOutflowModifier.deploy(msv);
      const combinedABI = mergeFragments(
        AccessManagedMSV.interface.fragments,
        mergeFragments(LimitOutflowModifier.interface.fragments, AccessManagedProxy.interface.fragments)
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
        const proxy = await AccessManagedProxy.deploy(lom, initializeData, acMgr);
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

        await vault.connect(admin).LOM__setLimit(3600 * 24, _A(1));

        return vault;
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
        AccessManagedMSV,
        ...ret,
      };
    },
  },
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

        await vault.connect(admin).setupOutflowLimit(3600 * 24, _A(1));

        return vault;
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

async function invariantChecks(vault) {
  const strategies = await vault.strategies();
  const withdrawQ = await vault.withdrawQueue();
  const depositQ = await vault.depositQueue();
  const stratCount = strategies.filter((x) => x !== ZeroAddress).length;
  expect(strategies).to.deep.equal(
    strategies.slice(0, stratCount).concat(Array(MAX_STRATEGIES - stratCount).fill(ZeroAddress)),
    "All the ZeroAddress must be at the end"
  );
  expect(withdrawQ).to.deep.equal(
    withdrawQ.slice(0, stratCount).concat(Array(MAX_STRATEGIES - stratCount).fill(0)),
    "All the 0 must be at the end"
  );
  expect(depositQ).to.deep.equal(
    depositQ.slice(0, stratCount).concat(Array(MAX_STRATEGIES - stratCount).fill(0)),
    "All the 0 must be at the end"
  );
  // Check there are no duplicates in depositQ and withdrawQ
  expect(new Set(depositQ.slice(0, stratCount)).size).to.equal(stratCount, "Error in depositQueue");
  expect(new Set(withdrawQ.slice(0, stratCount)).size).to.equal(stratCount, "Error in withdrawQueue");
  // Check the values are between 1 and stratCount + 1
  expect(withdrawQ.slice(0, stratCount).some((x) => x < 1 || x > stratCount)).to.equal(false);
  expect(depositQ.slice(0, stratCount).some((x) => x < 1 || x > stratCount)).to.equal(false);
}

variants.forEach((variant) => {
  describe(`${variant.name} contract tests`, function () {
    variant.tagit("Checks vault constructs with disabled initializer [MultiStrategyERC4626]", async () => {
      const { MultiStrategyERC4626, adminAddr, currency, strategies } = await helpers.loadFixture(variant.fixture);
      const newVault = await MultiStrategyERC4626.deploy();
      await expect(newVault.deploymentTransaction()).to.emit(newVault, "Initialized");
      await expect(
        newVault.initialize(
          "foo",
          "bar",
          adminAddr,
          await ethers.resolveAddress(currency),
          [strategies[0]],
          [encodeDummyStorage({})],
          [0],
          [0]
        )
      ).to.be.revertedWithCustomError(MultiStrategyERC4626, "InvalidInitialization");
    });

    variant.tagit("Checks vault constructs with disabled initializer [!MultiStrategyERC4626]", async () => {
      const { AccessManagedMSV, OutflowLimitedAMMSV, currency, strategies } = await helpers.loadFixture(
        variant.fixture
      );
      const factory = AccessManagedMSV || OutflowLimitedAMMSV;
      const newVault = await factory.deploy();
      await expect(newVault.deploymentTransaction()).to.emit(newVault, "Initialized");
      await expect(
        newVault.initialize(
          "foo",
          "bar",
          await ethers.resolveAddress(currency),
          [strategies[0]],
          [encodeDummyStorage({})],
          [0],
          [0]
        )
      ).to.be.revertedWithCustomError(factory, "InvalidInitialization");
    });

    variant.tagit("Initializes the vault correctly", async () => {
      const { deployVault, currency, strategies } = await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(1);
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

    variant.tagit("Initialization fails if strategy connect fails", async () => {
      const { deployVault, DummyInvestStrategy } = await helpers.loadFixture(variant.fixture);
      let vault = deployVault(1, [encodeDummyStorage({ failConnect: true })]);
      await expect(vault).to.be.revertedWithCustomError(DummyInvestStrategy, "Fail").withArgs("connect");
      // Test that happens the same if any of the strategies fail
      for (let i = 2; i <= MAX_STRATEGIES; i++) {
        vault = deployVault(
          i,
          Array(i - 1)
            .fill(encodeDummyStorage({}))
            .concat([encodeDummyStorage({ failConnect: true })])
        );
        await expect(vault).to.be.revertedWithCustomError(DummyInvestStrategy, "Fail").withArgs("connect");
      }
    });

    variant.tagit("It checks calls to forwardToStrategy require permission [MultiStrategyERC4626]", async () => {
      const { deployVault, strategies, anon, grantRole } = await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(3);
      await expect(vault.connect(anon).forwardToStrategy(4, 0, encodeDummyStorage({}))).to.be.revertedWithACError(
        vault,
        anon,
        "FORWARD_TO_STRATEGY_ROLE"
      );

      await grantRole(vault, "FORWARD_TO_STRATEGY_ROLE", anon);
      let specificRole = await vault.getForwardToStrategyRole(4, 0);
      await expect(vault.connect(anon).forwardToStrategy(4, 0, encodeDummyStorage({}))).to.be.revertedWithACError(
        vault,
        anon,
        specificRole
      );
      await grantRole(vault, specificRole, anon);

      await expect(vault.connect(anon).forwardToStrategy(4, 0, encodeDummyStorage({}))).to.be.revertedWithCustomError(
        vault,
        "InvalidStrategy"
      );

      for (let i = 0; i < 3; i++) {
        let strategy = strategies[i];
        let failConfig = {};
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        failConfig = { failDisconnect: true };
        specificRole = await vault.getForwardToStrategyRole(i, 0);
        await expect(
          vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage(failConfig))
        ).to.be.revertedWithACError(vault, anon, specificRole);
        await grantRole(vault, specificRole, anon);
        await expect(vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        failConfig = { failConnect: true };
        await expect(vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        await expect(vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage({}))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage({}));

        failConfig = { failWithdraw: true };
        await expect(vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        expect(await vault.getBytesSlot(await strategy.storageSlot())).to.be.equal(encodeDummyStorage(failConfig));
        await expect(vault.getBytesSlot(ethers.zeroPadValue(ethers.toQuantity(123), 32))).to.be.revertedWithCustomError(
          vault,
          "OnlyStrategyStorageExposed"
        );
      }
    });

    variant.tagit("It checks calls to forwardToStrategy require permission [!MultiStrategyERC4626]", async () => {
      const { deployVault, strategies, anon, grantRole, acMgr, admin } = await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(3);
      await expect(vault.connect(anon).forwardToStrategy(4, 0, encodeDummyStorage({}))).to.be.revertedWithAMError(
        vault,
        anon
      );

      await grantRole(vault, "FORWARD_TO_STRATEGY_ROLE", anon);
      let specificSelector = await vault.getForwardToStrategySelector(4, 0);
      // Still fails because missing the specific permission
      await expect(vault.connect(anon).forwardToStrategy(4, 0, encodeDummyStorage({}))).to.be.revertedWithAMError(
        vault,
        anon
      );

      // Grant the specific permission
      await acMgr.connect(admin).setTargetFunctionRole(vault, [specificSelector], specificSelector);
      await grantRole(vault, specificSelector, anon);

      await expect(vault.connect(anon).forwardToStrategy(4, 0, encodeDummyStorage({}))).to.be.revertedWithCustomError(
        vault,
        "InvalidStrategy"
      );

      for (let i = 0; i < 3; i++) {
        let strategy = strategies[i];
        let failConfig = {};
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        failConfig = { failDisconnect: true };
        specificSelector = await vault.getForwardToStrategySelector(i, 0);
        await expect(
          vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage(failConfig))
        ).to.be.revertedWithAMError(vault, anon);

        await acMgr.connect(admin).setTargetFunctionRole(vault, [specificSelector], specificSelector);
        await grantRole(vault, specificSelector, anon);
        await expect(vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        failConfig = { failConnect: true };
        await expect(vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        await expect(vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage({}))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage({}));

        failConfig = { failWithdraw: true };
        await expect(vault.connect(anon).forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        expect(await vault.getBytesSlot(await strategy.storageSlot())).to.be.equal(encodeDummyStorage(failConfig));
        await expect(vault.getBytesSlot(ethers.zeroPadValue(ethers.toQuantity(123), 32))).to.be.revertedWithCustomError(
          vault,
          "OnlyStrategyStorageExposed"
        );
      }
    });

    variant.tagit("It sets and reads the right value from strategy storage", async () => {
      const { deployVault, strategies, grantForwardToStrategy, anon } = await helpers.loadFixture(variant.fixture);
      const vault = (await deployVault(3)).connect(anon);
      await grantForwardToStrategy(vault, 4, 0, anon);
      await expect(vault.forwardToStrategy(4, 0, encodeDummyStorage({}))).to.be.revertedWithCustomError(
        vault,
        "InvalidStrategy"
      );

      for (let i = 0; i < 3; i++) {
        let strategy = strategies[i];
        let failConfig = {};
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        failConfig = { failDisconnect: true };
        await grantForwardToStrategy(vault, i, 0, anon);
        await expect(vault.forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        failConfig = { failConnect: true };
        await expect(vault.forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        await expect(vault.forwardToStrategy(i, 0, encodeDummyStorage({}))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage({}));

        failConfig = { failWithdraw: true };
        await expect(vault.forwardToStrategy(i, 0, encodeDummyStorage(failConfig))).not.to.be.reverted;
        expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

        expect(await vault.getBytesSlot(await strategy.storageSlot())).to.be.equal(encodeDummyStorage(failConfig));
        await expect(vault.getBytesSlot(ethers.zeroPadValue(ethers.toQuantity(123), 32))).to.be.revertedWithCustomError(
          vault,
          "OnlyStrategyStorageExposed"
        );
      }
    });

    variant.tagit("It fails when initialized with wrong parameters", async () => {
      const { strategies, MultiStrategyERC4626, deployVault } = await helpers.loadFixture(variant.fixture);
      // Sending 0 strategies fails
      await expect(deployVault(0)).to.be.revertedWithCustomError(MultiStrategyERC4626, "InvalidStrategiesLength");
      // Sending 33 strategies fail
      await expect(deployVault(strategies.concat([strategies[0]]))).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "InvalidStrategiesLength"
      );
      // Sending different length arrays fail
      await expect(deployVault(1, Array(2).fill(encodeDummyStorage({})))).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "InvalidStrategiesLength"
      );
      await expect(deployVault(2, undefined, [0])).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "InvalidStrategiesLength"
      );
      await expect(deployVault(3, undefined, undefined, [1, 0])).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "InvalidStrategiesLength"
      );
      await expect(deployVault([ZeroAddress])).to.be.revertedWithCustomError(MultiStrategyERC4626, "InvalidStrategy");
      await expect(deployVault([strategies[0], strategies[1], strategies[0]])).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "DuplicatedStrategy"
      );
      await expect(deployVault(2, undefined, [3, 2])).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "InvalidStrategyInDepositQueue"
      );
      await expect(deployVault(2, undefined, undefined, [3, 2])).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "InvalidStrategyInWithdrawQueue"
      );
      await expect(deployVault(2, undefined, [1, 1])).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "InvalidStrategyInDepositQueue"
      );
      await expect(deployVault(2, undefined, undefined, [1, 1])).to.be.revertedWithCustomError(
        MultiStrategyERC4626,
        "InvalidStrategyInWithdrawQueue"
      );
      // Successful initialization emits DepositQueueChanged, WithdrawQueueChanged
      const vault = await deployVault(3, undefined, [2, 1, 0], [1, 0, 2]);
      const deploymentTransaction = vault.deploymentTransaction();
      await expect(deploymentTransaction)
        .to.emit(vault, "StrategyAdded")
        .withArgs(strategies[0], 0)
        .to.emit(vault, "StrategyAdded")
        .withArgs(strategies[1], 1)
        .to.emit(vault, "StrategyAdded")
        .withArgs(strategies[2], 2)
        .to.emit(vault, "DepositQueueChanged")
        .withArgs([2, 1, 0])
        .to.emit(vault, "WithdrawQueueChanged")
        .withArgs([1, 0, 2]);
      await invariantChecks(vault);
    });

    variant.tagit("It respects the order of deposit and withdrawal queues", async () => {
      const { deployVault, lp, lp2, currency, grantRole, grantForwardToStrategy, strategies } =
        await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);
      await currency.connect(lp).approve(vault, MaxUint256);

      if (variant.accessManaged) {
        await expect(vault.connect(lp).deposit(_A(100), lp)).to.be.revertedWithAMError(vault, lp);
        await expect(vault.connect(lp).mint(_A(100), lp)).to.be.revertedWithAMError(vault, lp);
      } else {
        await expect(vault.connect(lp).deposit(_A(100), lp)).to.be.revertedWithCustomError(
          vault,
          "ERC4626ExceededMaxDeposit"
        );
        await expect(vault.connect(lp).mint(_A(100), lp)).to.be.revertedWithCustomError(
          vault,
          "ERC4626ExceededMaxMint"
        );
      }

      await grantRole(vault, "LP_ROLE", lp);
      await expect(vault.connect(lp).deposit(_A(100), lp)).not.to.be.reverted;

      expect(await vault.totalAssets()).to.be.equal(_A(100));
      // Check money went to strategy[3]
      expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(100));

      await grantForwardToStrategy(vault, 0, 0, lp);
      await grantForwardToStrategy(vault, 2, 0, lp);
      await grantForwardToStrategy(vault, 3, 0, lp);
      // Then disable deposits on 3
      await vault.connect(lp).forwardToStrategy(3, 0, encodeDummyStorage({ failDeposit: true }));
      await vault.connect(lp).forwardToStrategy(2, 0, encodeDummyStorage({ failDeposit: true }));

      expect(await vault.maxWithdraw(lp)).to.equal(_A(100));
      expect(await vault.maxRedeem(lp)).to.equal(_A(100));
      expect(await vault.maxWithdraw(lp2)).to.equal(_A(0));
      expect(await vault.maxRedeem(lp2)).to.equal(_A(0));

      await vault.connect(lp).forwardToStrategy(3, 0, encodeDummyStorage({ failDeposit: true, failWithdraw: true }));
      expect(await vault.maxWithdraw(lp)).to.equal(_A(0));
      expect(await vault.maxRedeem(lp)).to.equal(_A(0));

      await vault.connect(lp).forwardToStrategy(0, 0, encodeDummyStorage({ failDeposit: true }));
      expect(await vault.maxDeposit(lp)).to.equal(MaxUint256);
      expect(await vault.maxMint(lp)).to.equal(MaxUint256);
      await vault.connect(lp).forwardToStrategy(0, 0, encodeDummyStorage({}));

      await expect(vault.connect(lp).deposit(_A(200), lp)).not.to.be.reverted;
      expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(200));
      expect(await vault.totalAssets()).to.be.equal(_A(300));

      await vault.connect(lp).forwardToStrategy(3, 0, encodeDummyStorage({ failDeposit: true }));

      await expect(vault.connect(lp).transfer(lp2, _A(150))).not.to.be.reverted;
      if (variant.accessManaged) {
        await grantRole(vault, "LP_ROLE", lp2); // In accessManaged LPs require permissions if they have tokens
      }
      await expect(vault.connect(lp2).redeem(_A(150), lp2, lp2)).not.to.be.reverted;
      expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(0));
      expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(150));

      await expect(vault.connect(lp).redeem(_A(150), lp, lp)).not.to.be.reverted;
      expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(0));
      expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(0));
      expect(await vault.totalAssets()).to.be.equal(_A(0));
    });

    variant.tagit("It respects the order of deposit and authorized user can rebalance", async () => {
      const { deployVault, lp, lp2, currency, grantRole, grantForwardToStrategy, strategies } =
        await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);
      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);
      await expect(vault.connect(lp).deposit(_A(100), lp)).not.to.be.reverted;

      expect(await vault.totalAssets()).to.be.equal(_A(100));
      // Check money went to strategy[3]
      expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(100));

      await expect(vault.connect(lp2).rebalance(3, 1, _A(50))).to.be[variant.accessError](
        vault,
        lp2,
        "REBALANCER_ROLE"
      );

      await grantRole(vault, "REBALANCER_ROLE", lp2);

      await expect(vault.connect(lp2).rebalance(33, 1, _A(50))).to.be.revertedWithCustomError(vault, "InvalidStrategy");
      await expect(vault.connect(lp2).rebalance(1, 33, _A(50))).to.be.revertedWithCustomError(vault, "InvalidStrategy");
      await expect(vault.connect(lp2).rebalance(5, 1, _A(50))).to.be.revertedWithCustomError(vault, "InvalidStrategy");
      await expect(vault.connect(lp2).rebalance(1, 5, _A(50))).to.be.revertedWithCustomError(vault, "InvalidStrategy");
      await expect(vault.connect(lp2).rebalance(3, 1, _A(200)))
        .to.be.revertedWithCustomError(vault, "RebalanceAmountExceedsMaxWithdraw")
        .withArgs(_A(100));

      await grantForwardToStrategy(vault, 2, 0, lp);
      await vault.connect(lp).forwardToStrategy(2, 0, encodeDummyStorage({ failDeposit: true }));
      await expect(vault.connect(lp2).rebalance(3, 2, _A(20)))
        .to.be.revertedWithCustomError(vault, "RebalanceAmountExceedsMaxDeposit")
        .withArgs(_A(0));

      await expect(vault.connect(lp2).rebalance(3, 1, _A(40)))
        .to.emit(vault, "Rebalance")
        .withArgs(strategies[3], strategies[1], _A(40));

      expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(60));
      expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(40));

      await expect(vault.connect(lp2).rebalance(3, 0, MaxUint256))
        .to.emit(vault, "Rebalance")
        .withArgs(strategies[3], strategies[0], _A(60));

      expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(0));
      expect(await currency.balanceOf(await strategies[0].other())).to.be.equal(_A(60));
      expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(40));

      await expect(vault.connect(lp2).rebalance(3, 0, MaxUint256)).not.to.emit(vault, "Rebalance");
    });

    variant.tagit("It can addStrategy and is added at the bottom of the queues", async () => {
      const { deployVault, lp, lp2, currency, grantRole, strategies } = await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);
      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);
      await expect(vault.connect(lp).deposit(_A(100), lp)).not.to.be.reverted;
      await invariantChecks(vault);

      expect(await vault.totalAssets()).to.be.equal(_A(100));
      // Check money went to strategy[1]
      expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(100));

      expect(await vault.depositQueue()).to.deep.equal([2, 1, 3].concat(Array(MAX_STRATEGIES - 3).fill(0)));
      expect(await vault.withdrawQueue()).to.deep.equal([3, 1, 2].concat(Array(MAX_STRATEGIES - 3).fill(0)));

      await expect(vault.connect(lp2).addStrategy(strategies[5], encodeDummyStorage({}))).to.be[variant.accessError](
        vault,
        lp2,
        "STRATEGY_ADMIN_ROLE"
      );

      await grantRole(vault, "STRATEGY_ADMIN_ROLE", lp2);

      await expect(vault.connect(lp2).addStrategy(ZeroAddress, encodeDummyStorage({}))).to.be.revertedWithCustomError(
        vault,
        "InvalidStrategy"
      );

      await expect(vault.connect(lp2).addStrategy(strategies[1], encodeDummyStorage({}))).to.be.revertedWithCustomError(
        vault,
        "DuplicatedStrategy"
      );

      await expect(
        vault.connect(lp2).addStrategy(strategies[5], encodeDummyStorage({ failConnect: true }))
      ).to.be.revertedWithCustomError(strategies[5], "Fail");

      await expect(vault.connect(lp2).addStrategy(strategies[5], encodeDummyStorage({})))
        .to.emit(vault, "StrategyAdded")
        .withArgs(strategies[5], 3);
      expect(await vault.depositQueue()).to.deep.equal([2, 1, 3, 4].concat(Array(MAX_STRATEGIES - 4).fill(0)));
      expect(await vault.withdrawQueue()).to.deep.equal([3, 1, 2, 4].concat(Array(MAX_STRATEGIES - 4).fill(0)));
      await invariantChecks(vault);
    });

    variant.tagit("It can add up to 32 strategies", async () => {
      const { deployVault, lp2, DummyInvestStrategy, currency, grantRole, strategies } = await helpers.loadFixture(
        variant.fixture
      );
      const vault = await deployVault(30);
      await invariantChecks(vault);
      await grantRole(vault, "STRATEGY_ADMIN_ROLE", lp2);

      // Add 31 works fine
      await expect(vault.connect(lp2).addStrategy(strategies[30], encodeDummyStorage({})))
        .to.emit(vault, "StrategyAdded")
        .withArgs(strategies[30], 30);
      await invariantChecks(vault);

      // Add 32 works fine
      await expect(vault.connect(lp2).addStrategy(strategies[31], encodeDummyStorage({})))
        .to.emit(vault, "StrategyAdded")
        .withArgs(strategies[31], 31);
      await invariantChecks(vault);

      const strategy33 = await DummyInvestStrategy.deploy(currency);

      // Another one fails
      await expect(vault.connect(lp2).addStrategy(strategy33, encodeDummyStorage({}))).to.be.revertedWithCustomError(
        vault,
        "InvalidStrategiesLength"
      );
      await invariantChecks(vault);
    });

    variant.tagit("It can removeStrategy only if doesn't have funds", async () => {
      const { deployVault, lp, lp2, currency, grantRole, grantForwardToStrategy, strategies } =
        await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);
      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);
      await expect(vault.connect(lp).mint(_A(100), lp)).not.to.be.reverted;
      await invariantChecks(vault);

      expect(await vault.totalAssets()).to.be.equal(_A(100));
      // Check money went to strategy[3]
      expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(100));

      await expect(vault.connect(lp2).removeStrategy(0, false)).to.be[variant.accessError](
        vault,
        lp2,
        "STRATEGY_ADMIN_ROLE"
      );

      await grantRole(vault, "STRATEGY_ADMIN_ROLE", lp2);

      await expect(vault.connect(lp2).removeStrategy(33, false)).to.be.revertedWithCustomError(
        vault,
        "InvalidStrategy"
      );
      await expect(vault.connect(lp2).removeStrategy(5, false)).to.be.revertedWithCustomError(vault, "InvalidStrategy");
      await expect(vault.connect(lp2).removeStrategy(1, false)).to.be.revertedWithCustomError(
        vault,
        "CannotRemoveStrategyWithAssets"
      );

      await expect(vault.connect(lp2).removeStrategy(0, false))
        .to.emit(vault, "StrategyRemoved")
        .withArgs(strategies[0], 0);
      await invariantChecks(vault);

      // Indexes changed but kept in the same order
      expect(await vault.depositQueue()).to.deep.equal([1, 2].concat(Array(MAX_STRATEGIES - 2).fill(0)));
      expect(await vault.withdrawQueue()).to.deep.equal([2, 1].concat(Array(MAX_STRATEGIES - 2).fill(0)));

      await grantForwardToStrategy(vault, 1, 0, lp);
      await expect(vault.connect(lp).forwardToStrategy(1, 0, encodeDummyStorage({ failDisconnect: true }))).not.to.be
        .reverted;

      await expect(vault.connect(lp2).removeStrategy(1, false)).to.be.revertedWithCustomError(strategies[2], "Fail");
      await invariantChecks(vault);
      await expect(vault.connect(lp2).removeStrategy(1, true))
        .to.emit(vault, "StrategyRemoved")
        .withArgs(strategies[2], 1);
      await invariantChecks(vault);

      expect(await vault.depositQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));
      expect(await vault.withdrawQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));

      await expect(vault.connect(lp).redeem(_A(100), lp, lp)).not.to.be.reverted;

      await expect(vault.connect(lp2).removeStrategy(0, false)).to.be.revertedWithCustomError(
        vault,
        "InvalidStrategiesLength"
      );
    });

    variant.tagit("It can removeStrategy in different order", async () => {
      const { deployVault, lp2, grantRole, strategies } = await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);

      await grantRole(vault, "STRATEGY_ADMIN_ROLE", lp2);

      await expect(vault.connect(lp2).removeStrategy(1, false))
        .to.emit(vault, "StrategyRemoved")
        .withArgs(strategies[1], 1);
      await invariantChecks(vault);

      // Indexes changed but kept in the same order
      expect(await vault.depositQueue()).to.deep.equal([1, 2].concat(Array(MAX_STRATEGIES - 2).fill(0)));
      expect(await vault.withdrawQueue()).to.deep.equal([2, 1].concat(Array(MAX_STRATEGIES - 2).fill(0)));

      await expect(vault.connect(lp2).removeStrategy(1, false))
        .to.emit(vault, "StrategyRemoved")
        .withArgs(strategies[2], 1);
      await invariantChecks(vault);

      expect(await vault.depositQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));
      expect(await vault.withdrawQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));

      await expect(vault.connect(lp2).removeStrategy(0, false)).to.be.revertedWithCustomError(
        vault,
        "InvalidStrategiesLength"
      );
    });

    variant.tagit("It can change the depositQueue if authorized", async () => {
      const { deployVault, lp2, grantRole } = await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);
      expect(await vault.depositQueue()).to.deep.equal([2, 1, 3].concat(Array(MAX_STRATEGIES - 3).fill(0)));

      await expect(vault.connect(lp2).changeDepositQueue([0, 1, 2])).to.be[variant.accessError](
        vault,
        lp2,
        "QUEUE_ADMIN_ROLE"
      );
      await grantRole(vault, "QUEUE_ADMIN_ROLE", lp2);

      await expect(vault.connect(lp2).changeDepositQueue([1, 1, 2]))
        .to.be.revertedWithCustomError(vault, "InvalidQueueIndexDuplicated")
        .withArgs(1);
      await expect(vault.connect(lp2).changeDepositQueue([0, 1, 3])).to.be.revertedWithCustomError(
        vault,
        "InvalidQueue"
      );
      await expect(vault.connect(lp2).changeDepositQueue([0, 32, 2])).to.be.revertedWithCustomError(
        vault,
        "InvalidQueue"
      );
      await expect(vault.connect(lp2).changeDepositQueue([0, 1])).to.be.revertedWithCustomError(
        vault,
        "InvalidQueueLength"
      );

      await expect(vault.connect(lp2).changeDepositQueue([2, 1, 0]))
        .to.emit(vault, "DepositQueueChanged")
        .withArgs([2, 1, 0]);
      await invariantChecks(vault);

      const vault32 = await deployVault(32);
      await grantRole(vault32, "QUEUE_ADMIN_ROLE", lp2);
      await expect(vault.connect(lp2).changeDepositQueue([...Array(33).keys()])).to.be.revertedWithCustomError(
        vault,
        "InvalidQueue"
      );
    });

    variant.tagit("It can change the withdrawQueue if authorized", async () => {
      const { deployVault, lp2, grantRole } = await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);
      expect(await vault.withdrawQueue()).to.deep.equal([3, 1, 2].concat(Array(MAX_STRATEGIES - 3).fill(0)));

      await expect(vault.connect(lp2).changeWithdrawQueue([0, 1, 2])).to.be[variant.accessError](
        vault,
        lp2,
        "QUEUE_ADMIN_ROLE"
      );
      await grantRole(vault, "QUEUE_ADMIN_ROLE", lp2);

      await expect(vault.connect(lp2).changeWithdrawQueue([1, 1, 2]))
        .to.be.revertedWithCustomError(vault, "InvalidQueueIndexDuplicated")
        .withArgs(1);
      await expect(vault.connect(lp2).changeWithdrawQueue([0, 1, 3])).to.be.revertedWithCustomError(
        vault,
        "InvalidQueue"
      );
      await expect(vault.connect(lp2).changeWithdrawQueue([0, 32, 2])).to.be.revertedWithCustomError(
        vault,
        "InvalidQueue"
      );
      await expect(vault.connect(lp2).changeWithdrawQueue([0, 1])).to.be.revertedWithCustomError(
        vault,
        "InvalidQueueLength"
      );

      await expect(vault.connect(lp2).changeWithdrawQueue([2, 1, 0]))
        .to.emit(vault, "WithdrawQueueChanged")
        .withArgs([2, 1, 0]);
      await invariantChecks(vault);

      const vault32 = await deployVault(32);
      await grantRole(vault32, "QUEUE_ADMIN_ROLE", lp2);
      await expect(vault.connect(lp2).changeWithdrawQueue([...Array(33).keys()])).to.be.revertedWithCustomError(
        vault,
        "InvalidQueue"
      );
    });

    variant.tagit("It can replaceStrategy if authorized", async () => {
      const { deployVault, lp, lp2, currency, grantRole, grantForwardToStrategy, strategies } =
        await helpers.loadFixture(variant.fixture);
      const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);

      await expect(vault.connect(lp2).replaceStrategy(0, strategies[5], encodeDummyStorage({}), false)).to.be[
        variant.accessError
      ](vault, lp2, "STRATEGY_ADMIN_ROLE");

      await grantRole(vault, "STRATEGY_ADMIN_ROLE", lp2);

      await expect(vault.connect(lp2).replaceStrategy(33, strategies[5], encodeDummyStorage({}), false)).to.be.reverted;

      await expect(
        vault.connect(lp2).replaceStrategy(4, strategies[5], encodeDummyStorage({}), false)
      ).to.be.revertedWithCustomError(vault, "InvalidStrategy");

      // Deposit some funds to make it more interesting
      await currency.connect(lp).approve(vault, MaxUint256);
      await grantRole(vault, "LP_ROLE", lp);
      await expect(vault.connect(lp).deposit(_A(100), lp)).not.to.be.reverted;
      expect(await vault.totalAssets()).to.equal(_A(100));
      await invariantChecks(vault);

      await grantForwardToStrategy(vault, 1, 0, lp);
      await vault.connect(lp).forwardToStrategy(1, 0, encodeDummyStorage({ failWithdraw: true }));
      await expect(
        vault.connect(lp2).replaceStrategy(1, strategies[5], encodeDummyStorage({}), false)
      ).to.be.revertedWithCustomError(strategies[1], "Fail");

      await expect(vault.connect(lp2).replaceStrategy(1, strategies[5], encodeDummyStorage({}), true))
        .to.emit(vault, "StrategyChanged")
        .withArgs(strategies[1], strategies[5])
        .to.emit(vault, "WithdrawFailed");
      expect(await vault.totalAssets()).to.equal(_A(0)); // Funds lost in the disconnected strategy

      await expect(vault.connect(lp2).replaceStrategy(1, strategies[1], encodeDummyStorage({}), true))
        .to.emit(vault, "StrategyChanged")
        .withArgs(strategies[5], strategies[1]);
      expect(await vault.totalAssets()).to.equal(_A(100)); // Funds recovered

      await invariantChecks(vault);

      await expect(
        vault.connect(lp2).replaceStrategy(1, strategies[5], encodeDummyStorage({ failConnect: true }), true)
      ).to.revertedWithCustomError(strategies[5], "Fail");

      await expect(
        vault.connect(lp2).replaceStrategy(1, strategies[5], encodeDummyStorage({ failDeposit: true }), false)
      ).to.revertedWithCustomError(strategies[5], "Fail");

      await expect(
        vault.connect(lp2).replaceStrategy(1, strategies[5], encodeDummyStorage({ failDeposit: true }), true)
      )
        .to.emit(vault, "StrategyChanged")
        .withArgs(strategies[1], strategies[5])
        .to.emit(vault, "DepositFailed");

      expect(await vault.totalAssets()).to.equal(_A(0)); // Funds were not deposited to the strategy

      await expect(vault.connect(lp2).replaceStrategy(1, strategies[6], encodeDummyStorage({}), false))
        .to.emit(vault, "StrategyChanged")
        .withArgs(strategies[5], strategies[6]);

      expect(await vault.totalAssets()).to.equal(_A(100)); // replaceStrategy recovers the funds in the contract

      // Can't replace with an strategy that's present already
      await expect(vault.connect(lp2).replaceStrategy(1, strategies[0], encodeDummyStorage({}), false))
        .to.be.revertedWithCustomError(vault, "DuplicatedStrategy")
        .withArgs(strategies[0]);

      // But can replace with the same strategy (might be necessary in some case)
      await expect(vault.connect(lp2).replaceStrategy(1, strategies[6], encodeDummyStorage({}), false))
        .to.emit(vault, "StrategyChanged")
        .withArgs(strategies[6], strategies[6]);
    });

    variant.tagit("Initialization fails if any strategy and vault have different assets", async () => {
      const { MultiStrategyERC4626, DummyInvestStrategy, adminAddr, currency } = await helpers.loadFixture(
        variant.fixture
      );

      const differentCurrency = await initCurrency(
        { name: "Different USDC", symbol: "DUSDC", decimals: 6, initial_supply: _A(50000), extraArgs: [adminAddr] },
        []
      );

      const differentStrategy = await DummyInvestStrategy.deploy(differentCurrency);
      await expect(
        hre.upgrades.deployProxy(
          MultiStrategyERC4626,
          [
            NAME,
            SYMB,
            adminAddr,
            await ethers.resolveAddress(currency),
            [await ethers.resolveAddress(differentStrategy)],
            [encodeDummyStorage({})],
            [0],
            [0],
          ],
          {
            kind: "uups",
            unsafeAllow: ["delegatecall"],
          }
        )
      ).to.be.revertedWithCustomError(MultiStrategyERC4626, "InvalidStrategyAsset");
    });

    variant.tagit("Fails to add strategy to vault if assets are different", async () => {
      const { deployVault, DummyInvestStrategy, grantRole, admin, MultiStrategyERC4626 } = await helpers.loadFixture(
        variant.fixture
      );

      const vault = await deployVault(3, undefined, [0, 1, 2], [0, 1, 2]);

      const differentCurrency = await initCurrency(
        { name: "Different USDC", symbol: "DUSDC", decimals: 6, initial_supply: _A(50000), extraArgs: [admin] },
        []
      );

      const differentStrategy = await DummyInvestStrategy.deploy(differentCurrency);

      await grantRole(vault, "STRATEGY_ADMIN_ROLE", admin);

      await expect(
        vault.connect(admin).addStrategy(differentStrategy, encodeDummyStorage({}))
      ).to.be.revertedWithCustomError(MultiStrategyERC4626, "InvalidStrategyAsset");
    });

    variant.tagit("Fails to replace strategy to vault if assets are different", async () => {
      // Obtener instancias necesarias para el test (contract, roles, etc.)
      const { deployVault, DummyInvestStrategy, grantRole, admin, MultiStrategyERC4626 } = await helpers.loadFixture(
        variant.fixture
      );

      const vault = await deployVault(3, undefined, [0, 1, 2], [0, 1, 2]);

      const differentCurrency = await initCurrency(
        { name: "Different USDC", symbol: "DUSDC", decimals: 6, initial_supply: _A(50000), extraArgs: [admin] },
        []
      );

      const differentStrategy = await DummyInvestStrategy.deploy(differentCurrency);

      await grantRole(vault, "STRATEGY_ADMIN_ROLE", admin);

      await expect(
        vault.connect(admin).replaceStrategy(0, differentStrategy, encodeDummyStorage({}), false)
      ).to.be.revertedWithCustomError(MultiStrategyERC4626, "InvalidStrategyAsset");
    });
  });
});
