const { expect } = require("chai");
const { amountFunction, getRole, accessControlMessage } = require("@ensuro/core/js/utils");
const { initCurrency } = require("@ensuro/core/js/test-utils");
const { encodeDummyStorage, dummyStorage } = require("./utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { ZeroAddress } = hre.ethers;

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

describe("MultiStrategyERC4626 contract tests", function () {
  it("Initializes the vault correctly", async () => {
    const { deployVault, currency, strategies } = await helpers.loadFixture(setUp);
    const vault = await deployVault(1);
    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.getWithdrawQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));
    expect(await vault.getDepositQueue()).to.deep.equal([1].concat(Array(MAX_STRATEGIES - 1).fill(0)));
    expect(await vault.getStrategies()).to.deep.equal(
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
  });
});
