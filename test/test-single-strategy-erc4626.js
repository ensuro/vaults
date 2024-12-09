const { expect } = require("chai");
const { amountFunction, getRole } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
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
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000), extraArgs: [admin] },
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
  await vault.connect(admin).grantRole(getRole("GUARDIAN_ROLE"), guardian);

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
    await expect(
      vault.connect(anon).setStrategy(strategy, encodeDummyStorage({}), false)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), anon);
    await expect(vault.connect(anon).setStrategy(strategy, encodeDummyStorage({}), false))
      .to.be.revertedWithCustomError(strategy, "Fail")
      .withArgs("disconnect");
    await expect(vault.connect(anon).setStrategy(strategy, encodeDummyStorage({}), true)).to.emit(
      vault,
      "DisconnectFailed"
    );
  });

  it("Initialization fails if strategy and vault have different assets", async () => {
    const { SingleStrategyERC4626, DummyInvestStrategy, adminAddr, currency, admin } = await helpers.loadFixture(setUp);

    const differentCurrency = await initCurrency(
      { name: "Different USDC", symbol: "DUSDC", decimals: 6, initial_supply: _A(50000), extraArgs: [admin] },
      []
    );

    const differentStrategy = await DummyInvestStrategy.deploy(differentCurrency);

    await expect(
      hre.upgrades.deployProxy(
        SingleStrategyERC4626,
        [
          NAME,
          SYMB,
          adminAddr,
          await ethers.resolveAddress(currency),
          await ethers.resolveAddress(differentStrategy),
          encodeDummyStorage({}),
        ],
        {
          kind: "uups",
          unsafeAllow: ["delegatecall"],
        }
      )
    ).to.be.revertedWithCustomError(SingleStrategyERC4626, "InvalidStrategyAsset");
  });

  it("Fails to add strategy to vault if assets are different", async () => {
    const { vault, DummyInvestStrategy, admin, SingleStrategyERC4626 } = await helpers.loadFixture(setUp);

    const differentCurrency = await initCurrency(
      { name: "Different USDC", symbol: "DUSDC", decimals: 6, initial_supply: _A(50000), extraArgs: [admin] },
      []
    );

    const differentStrategy = await DummyInvestStrategy.deploy(differentCurrency);

    await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), admin);

    await expect(
      vault.connect(admin).setStrategy(differentStrategy, encodeDummyStorage({}), false)
    ).to.be.revertedWithCustomError(SingleStrategyERC4626, "InvalidStrategyAsset");
  });

  it("Checks only GUARDIAN_ROLE can upgrade", async () => {
    const { vault, admin, guardian, SingleStrategyERC4626 } = await helpers.loadFixture(setUp);
    const newImpl = await SingleStrategyERC4626.deploy();

    await expect(vault.connect(admin).upgradeToAndCall(newImpl, "0x")).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
    await expect(vault.connect(guardian).upgradeToAndCall(newImpl, "0x")).to.emit(vault, "Upgraded");
  });

  it("Checks only DEFAULT_ADMIN_ROLE can setRoleAdmin, then others can set specific roles", async () => {
    const { vault, admin, guardian } = await helpers.loadFixture(setUp);

    await expect(
      vault.connect(guardian).setRoleAdmin(getRole("LP_ROLE"), getRole("LP_ROLE_ADMIN"))
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

    await expect(vault.connect(admin).setRoleAdmin(getRole("LP_ROLE"), getRole("LP_ROLE_ADMIN")))
      .to.emit(vault, "RoleAdminChanged")
      .withArgs(getRole("LP_ROLE"), getRole("DEFAULT_ADMIN_ROLE"), getRole("LP_ROLE_ADMIN"));

    await expect(vault.connect(admin).grantRole(getRole("LP_ROLE"), guardian)).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );

    await vault.connect(admin).grantRole(getRole("LP_ROLE_ADMIN"), guardian);

    await expect(vault.connect(guardian).grantRole(getRole("LP_ROLE"), guardian)).to.emit(vault, "RoleGranted");
  });
});
