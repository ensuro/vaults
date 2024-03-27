const { expect } = require("chai");
const { amountFunction, getRole, accessControlMessage } = require("@ensuro/core/js/utils");
const { initCurrency } = require("@ensuro/core/js/test-utils");
const { encodeDummyStorage, dummyStorage } = require("./utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Single Strategy Vault";
const SYMB = "SSV";

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
    [lp, lp2],
    [_A(INITIAL), _A(INITIAL)]
  );

  const adminAddr = await ethers.resolveAddress(admin);
  const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
  const strategy = await DummyInvestStrategy.deploy(currency);
  const SingleStrategyERC4626 = await ethers.getContractFactory("SingleStrategyERC4626");
  const vault = await hre.upgrades.deployProxy(
    SingleStrategyERC4626,
    [
      NAME,
      SYMB,
      adminAddr,
      await ethers.resolveAddress(currency),
      await ethers.resolveAddress(strategy),
      encodeDummyStorage({}),
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

  return {
    currency,
    SingleStrategyERC4626,
    DummyInvestStrategy,
    vault,
    strategy,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
  };
}

describe("SingleStrategyERC4626 contract tests", function () {
  it("Initializes the vault correctly", async () => {
    const { vault, strategy, currency } = await helpers.loadFixture(setUp);

    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.strategy()).to.equal(strategy);
    expect(await vault.asset()).to.equal(currency);
    expect(await vault.totalAssets()).to.equal(0);
  });

  it("Initialization fails if strategy connect fails", async () => {
    const { SingleStrategyERC4626, strategy, currency, adminAddr, DummyInvestStrategy } =
      await helpers.loadFixture(setUp);
    const otherVault = hre.upgrades.deployProxy(
      SingleStrategyERC4626,
      [
        NAME,
        SYMB,
        adminAddr,
        await ethers.resolveAddress(currency),
        await ethers.resolveAddress(strategy),
        encodeDummyStorage({ failConnect: true }),
      ],
      {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
      }
    );
    await expect(otherVault).to.be.revertedWithCustomError(DummyInvestStrategy, "Fail").withArgs("connect");
  });

  it("Initialization fails if extra data is sent", async () => {
    const { SingleStrategyERC4626, strategy, currency, adminAddr, DummyInvestStrategy } =
      await helpers.loadFixture(setUp);
    const otherVault = hre.upgrades.deployProxy(
      SingleStrategyERC4626,
      [
        NAME,
        SYMB,
        adminAddr,
        await ethers.resolveAddress(currency),
        await ethers.resolveAddress(strategy),
        encodeDummyStorage({}) + "f".repeat(64),
      ],
      {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
      }
    );
    await expect(otherVault).to.be.revertedWithCustomError(DummyInvestStrategy, "NoExtraDataAllowed");
  });

  it("It sets and reads the right value from strategy storage", async () => {
    const { vault, strategy } = await helpers.loadFixture(setUp);
    let failConfig = {};
    expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

    failConfig = { failDisconnect: true };
    await expect(vault.forwardToStrategy(0, encodeDummyStorage(failConfig))).not.to.be.reverted;
    expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

    failConfig = { failConnect: true };
    await expect(vault.forwardToStrategy(0, encodeDummyStorage(failConfig))).not.to.be.reverted;
    expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

    await expect(vault.forwardToStrategy(0, encodeDummyStorage({}))).not.to.be.reverted;
    expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage({}));

    failConfig = { failWithdraw: true };
    await expect(vault.forwardToStrategy(0, encodeDummyStorage(failConfig))).not.to.be.reverted;
    expect(await strategy.getFail(vault)).to.be.deep.equal(dummyStorage(failConfig));

    expect(await vault.getBytesSlot(await strategy.storageSlot())).to.be.equal(encodeDummyStorage(failConfig));
    await expect(vault.getBytesSlot(ethers.zeroPadValue(ethers.toQuantity(123), 32))).to.be.revertedWithCustomError(
      vault,
      "OnlyStrategyStorageExposed"
    );
  });

  it("If disconnect fails it can't change the strategy unless forced", async () => {
    const { vault, strategy, admin, anon } = await helpers.loadFixture(setUp);
    await expect(vault.forwardToStrategy(0, encodeDummyStorage({ failDisconnect: true }))).not.to.be.reverted;
    await expect(vault.connect(anon).setStrategy(strategy, encodeDummyStorage({}), false)).to.be.revertedWith(
      accessControlMessage(anon, null, "SET_STRATEGY_ROLE")
    );
    await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), anon);
    await expect(vault.connect(anon).setStrategy(strategy, encodeDummyStorage({}), false))
      .to.be.revertedWithCustomError(strategy, "Fail")
      .withArgs("disconnect");
    await expect(vault.connect(anon).setStrategy(strategy, encodeDummyStorage({}), true)).to.emit(
      vault,
      "DisconnectFailed"
    );
  });
});
