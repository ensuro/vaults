const { expect } = require("chai");
const { amountFunction, getRole, accessControlMessage } = require("@ensuro/core/js/utils");
const { initCurrency } = require("@ensuro/core/js/test-utils");
const { encodeDummyStorage, dummyStorage } = require("./utils");
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
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
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

  return {
    currency,
    MultiStrategyERC4626,
    DummyInvestStrategy,
    strategies,
    adminAddr,
    deployVault,
    lp,
    lp2,
    anon,
    guardian,
    admin,
  };
}

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

describe("MultiStrategyERC4626 contract tests", function () {
  it("Initializes the vault correctly", async () => {
    const { deployVault, currency, strategies } = await helpers.loadFixture(setUp);
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

  it("Initialization fails if strategy connect fails", async () => {
    const { deployVault, DummyInvestStrategy } = await helpers.loadFixture(setUp);
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

  it("It sets and reads the right value from strategy storage", async () => {
    const { deployVault, strategies } = await helpers.loadFixture(setUp);
    const vault = await deployVault(3);
    await expect(vault.forwardToStrategy(4, 0, encodeDummyStorage({}))).to.be.revertedWithCustomError(
      vault,
      "InvalidStrategy"
    );
    for (let i = 0; i < 3; i++) {
      let strategy = strategies[i];
      let failConfig = {};
      expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

      failConfig = { failDisconnect: true };
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

  it("It fails when initialized with wrong parameters", async () => {
    const { deployVault, strategies, MultiStrategyERC4626 } = await helpers.loadFixture(setUp);
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
    await expect(vault.deploymentTransaction())
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

  it("It respects the order of deposit and withdrawal queues", async () => {
    const { deployVault, lp, lp2, currency, admin, strategies } = await helpers.loadFixture(setUp);
    const vault = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);
    await currency.connect(lp).approve(vault, MaxUint256);

    await expect(vault.connect(lp).deposit(_A(100), lp)).to.be.revertedWith("ERC4626: deposit more than max");
    await expect(vault.connect(lp).mint(_A(100), lp)).to.be.revertedWith("ERC4626: mint more than max");

    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
    await expect(vault.connect(lp).deposit(_A(100), lp)).not.to.be.reverted;

    expect(await vault.totalAssets()).to.be.equal(_A(100));
    // Check money went to strategy[3]
    expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(100));

    // Then disable deposits on 3
    await vault.forwardToStrategy(3, 0, encodeDummyStorage({ failDeposit: true }));
    await vault.forwardToStrategy(2, 0, encodeDummyStorage({ failDeposit: true }));

    expect(await vault.maxWithdraw(lp)).to.equal(_A(100));
    expect(await vault.maxRedeem(lp)).to.equal(_A(100));
    expect(await vault.maxWithdraw(lp2)).to.equal(_A(0));
    expect(await vault.maxRedeem(lp2)).to.equal(_A(0));

    await vault.forwardToStrategy(3, 0, encodeDummyStorage({ failDeposit: true, failWithdraw: true }));
    expect(await vault.maxWithdraw(lp)).to.equal(_A(0));
    expect(await vault.maxRedeem(lp)).to.equal(_A(0));

    await expect(vault.connect(lp).deposit(_A(200), lp)).not.to.be.reverted;
    expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(200));
    expect(await vault.totalAssets()).to.be.equal(_A(300));

    await vault.forwardToStrategy(3, 0, encodeDummyStorage({ failDeposit: true }));

    await expect(vault.connect(lp).transfer(lp2, _A(150))).not.to.be.reverted;
    await expect(vault.connect(lp2).redeem(_A(150), lp2, lp2)).not.to.be.reverted;
    expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(0));
    expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(150));

    await expect(vault.connect(lp).redeem(_A(150), lp, lp)).not.to.be.reverted;
    expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(0));
    expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(0));
    expect(await vault.totalAssets()).to.be.equal(_A(0));
  });

  it("It respects the order of deposit and authorized user can rebalance", async () => {
    const { deployVault, lp, lp2, currency, admin, strategies } = await helpers.loadFixture(setUp);
    const vault = await deployVault(4, undefined, [3, 2, 1, 0], [2, 0, 3, 1]);
    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
    await expect(vault.connect(lp).deposit(_A(100), lp)).not.to.be.reverted;

    expect(await vault.totalAssets()).to.be.equal(_A(100));
    // Check money went to strategy[3]
    expect(await currency.balanceOf(await strategies[3].other())).to.be.equal(_A(100));

    await expect(vault.connect(lp2).rebalance(3, 1, _A(50))).to.be.revertedWith(
      accessControlMessage(lp2, null, "REBALANCER_ROLE")
    );

    await vault.connect(admin).grantRole(getRole("REBALANCER_ROLE"), lp2);

    await expect(vault.connect(lp2).rebalance(33, 1, _A(50))).to.be.revertedWithCustomError(vault, "InvalidStrategy");
    await expect(vault.connect(lp2).rebalance(1, 33, _A(50))).to.be.revertedWithCustomError(vault, "InvalidStrategy");
    await expect(vault.connect(lp2).rebalance(5, 1, _A(50))).to.be.revertedWithCustomError(vault, "InvalidStrategy");
    await expect(vault.connect(lp2).rebalance(1, 5, _A(50))).to.be.revertedWithCustomError(vault, "InvalidStrategy");
    await expect(vault.connect(lp2).rebalance(3, 1, _A(200)))
      .to.be.revertedWithCustomError(vault, "RebalanceAmountExceedsMaxWithdraw")
      .withArgs(_A(100));

    await vault.forwardToStrategy(2, 0, encodeDummyStorage({ failDeposit: true }));
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

  it("It can addStrategy and is added at the bottom of the queues", async () => {
    const { deployVault, lp, lp2, currency, admin, strategies } = await helpers.loadFixture(setUp);
    const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);
    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
    await expect(vault.connect(lp).deposit(_A(100), lp)).not.to.be.reverted;
    await invariantChecks(vault);

    expect(await vault.totalAssets()).to.be.equal(_A(100));
    // Check money went to strategy[3]
    expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(100));

    expect(await vault.depositQueue()).to.deep.equal([2, 1, 3].concat(Array(MAX_STRATEGIES - 3).fill(0)));
    expect(await vault.withdrawQueue()).to.deep.equal([3, 1, 2].concat(Array(MAX_STRATEGIES - 3).fill(0)));

    await expect(vault.connect(lp2).addStrategy(strategies[5], encodeDummyStorage({}))).to.be.revertedWith(
      accessControlMessage(lp2, null, "STRATEGY_ADMIN_ROLE")
    );

    await vault.connect(admin).grantRole(getRole("STRATEGY_ADMIN_ROLE"), lp2);

    await expect(vault.connect(lp2).addStrategy(ZeroAddress, encodeDummyStorage({}))).to.be.revertedWith(
      "Address: call to non-contract"
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

  it("It can add up to 32 strategies", async () => {
    const { deployVault, lp2, DummyInvestStrategy, currency, admin, strategies } = await helpers.loadFixture(setUp);
    const vault = await deployVault(30);
    await invariantChecks(vault);
    await vault.connect(admin).grantRole(getRole("STRATEGY_ADMIN_ROLE"), lp2);

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

  it("It can removeStrategy only if doesn't have funds", async () => {
    const { deployVault, lp, lp2, currency, admin, strategies } = await helpers.loadFixture(setUp);
    const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);
    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
    await expect(vault.connect(lp).mint(_A(100), lp)).not.to.be.reverted;
    await invariantChecks(vault);

    expect(await vault.totalAssets()).to.be.equal(_A(100));
    // Check money went to strategy[3]
    expect(await currency.balanceOf(await strategies[1].other())).to.be.equal(_A(100));

    await expect(vault.connect(lp2).removeStrategy(0, false)).to.be.revertedWith(
      accessControlMessage(lp2, null, "STRATEGY_ADMIN_ROLE")
    );

    await vault.connect(admin).grantRole(getRole("STRATEGY_ADMIN_ROLE"), lp2);

    await expect(vault.connect(lp2).removeStrategy(33, false)).to.be.revertedWithCustomError(vault, "InvalidStrategy");
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

    await expect(vault.forwardToStrategy(1, 0, encodeDummyStorage({ failDisconnect: true }))).not.to.be.reverted;

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

  it("It can change the depositQueue if authorized", async () => {
    const { deployVault, lp2, admin } = await helpers.loadFixture(setUp);
    const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);
    expect(await vault.depositQueue()).to.deep.equal([2, 1, 3].concat(Array(MAX_STRATEGIES - 3).fill(0)));

    await expect(vault.connect(lp2).changeDepositQueue([0, 1, 2])).to.be.revertedWith(
      accessControlMessage(lp2, null, "QUEUE_ADMIN_ROLE")
    );
    await vault.connect(admin).grantRole(getRole("QUEUE_ADMIN_ROLE"), lp2);

    await expect(vault.connect(lp2).changeDepositQueue([1, 1, 2]))
      .to.be.revertedWithCustomError(vault, "InvalidQueueIndexDuplicated")
      .withArgs(1);
    await expect(vault.connect(lp2).changeDepositQueue([0, 1, 3])).to.be.revertedWithCustomError(vault, "InvalidQueue");
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
    await vault32.connect(admin).grantRole(getRole("QUEUE_ADMIN_ROLE"), lp2);
    await expect(vault.connect(lp2).changeDepositQueue([...Array(33).keys()])).to.be.revertedWithCustomError(
      vault,
      "InvalidQueue"
    );
  });

  it("It can change the withdrawQueue if authorized", async () => {
    const { deployVault, lp2, admin } = await helpers.loadFixture(setUp);
    const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);
    expect(await vault.withdrawQueue()).to.deep.equal([3, 1, 2].concat(Array(MAX_STRATEGIES - 3).fill(0)));

    await expect(vault.connect(lp2).changeWithdrawQueue([0, 1, 2])).to.be.revertedWith(
      accessControlMessage(lp2, null, "QUEUE_ADMIN_ROLE")
    );
    await vault.connect(admin).grantRole(getRole("QUEUE_ADMIN_ROLE"), lp2);

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
    await vault32.connect(admin).grantRole(getRole("QUEUE_ADMIN_ROLE"), lp2);
    await expect(vault.connect(lp2).changeWithdrawQueue([...Array(33).keys()])).to.be.revertedWithCustomError(
      vault,
      "InvalidQueue"
    );
  });

  it("It can replaceStrategy if authorized", async () => {
    const { deployVault, lp, lp2, currency, admin, strategies } = await helpers.loadFixture(setUp);
    const vault = await deployVault(3, undefined, [1, 0, 2], [2, 0, 1]);

    await expect(
      vault.connect(lp2).replaceStrategy(0, strategies[5], encodeDummyStorage({}), false)
    ).to.be.revertedWith(accessControlMessage(lp2, null, "STRATEGY_ADMIN_ROLE"));

    await vault.connect(admin).grantRole(getRole("STRATEGY_ADMIN_ROLE"), lp2);

    await expect(vault.connect(lp2).replaceStrategy(33, strategies[5], encodeDummyStorage({}), false)).to.be.reverted;

    await expect(
      vault.connect(lp2).replaceStrategy(4, strategies[5], encodeDummyStorage({}), false)
    ).to.be.revertedWithCustomError(vault, "InvalidStrategy");

    // Deposit some funds to make it more interesting
    await currency.connect(lp).approve(vault, MaxUint256);
    await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
    await expect(vault.connect(lp).deposit(_A(100), lp)).not.to.be.reverted;
    expect(await vault.totalAssets()).to.equal(_A(100));
    await invariantChecks(vault);

    await vault.forwardToStrategy(1, 0, encodeDummyStorage({ failWithdraw: true }));
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

    await expect(vault.connect(lp2).replaceStrategy(1, strategies[5], encodeDummyStorage({ failDeposit: true }), true))
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
});
