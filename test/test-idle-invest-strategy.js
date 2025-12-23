const { expect } = require("chai");
const { amountFunction, getRole, makeAllViewsPublic, setupAMRole } = require("@ensuro/utils/js/utils");
const { encodeDummyStorage } = require("./utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { deploy: ozUpgradesDeploy } = require("@openzeppelin/hardhat-upgrades/dist/utils");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Single Strategy Vault";
const SYMB = "SSV";

const CENT = _A("0.01");
const MCENT = CENT / 1000n;

const OverrideOption = {
  deposit: 0,
  mint: 1,
  withdraw: 2,
  redeem: 3,
};

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();

  const USDC = await initCurrency(
    {
      name: "Test Currency with 6 decimals",
      symbol: "USDC",
      decimals: 6,
      initial_supply: _A(50000),
      extraArgs: [admin],
    },
    [lp, lp2],
    [_A(INITIAL), _A(INITIAL)]
  );

  const adminAddr = await ethers.resolveAddress(admin);
  const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
  const IdleInvestStrategy = await ethers.getContractFactory("IdleInvestStrategy");
  const AaveV3InvestStrategy = await ethers.getContractFactory("AaveV3InvestStrategy");
  const ERC4626InvestStrategy = await ethers.getContractFactory("ERC4626InvestStrategy");
  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const investVault = await TestERC4626.deploy("Some vault", "VAULT", USDC);

  // Grant roles to the test vault, so it can mint/burn earnings/losses
  await USDC.connect(admin).grantRole(getRole("MINTER_ROLE"), investVault);
  await USDC.connect(admin).grantRole(getRole("BURNER_ROLE"), investVault);

  const AccessManagedMSV = await ethers.getContractFactory("AccessManagedMSV");
  const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");
  const AccessManager = await ethers.getContractFactory("AccessManager");
  const acMgr = await AccessManager.deploy(admin);
  const roles = {
    LP_ROLE: 1,
    LOM_ADMIN: 2,
    REBALANCER_ROLE: 3,
    STRATEGY_ADMIN_ROLE: 4,
    QUEUE_ADMIN_ROLE: 5,
    FORWARD_TO_STRATEGY_ROLE: 6,
  };

  async function setupVault(asset, strategies_, initStrategyDatas, depositQueue, withdrawQueue) {
    const vault = await hre.upgrades.deployProxy(
      AccessManagedMSV,
      [
        NAME,
        SYMB,
        await ethers.resolveAddress(asset),
        await Promise.all(strategies_.map(ethers.resolveAddress)),
        initStrategyDatas,
        depositQueue,
        withdrawQueue,
      ],
      {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
        proxyFactory: AccessManagedProxy,
        deployFunction: async (hre, opts, factory, ...args) => ozUpgradesDeploy(hre, opts, factory, ...args, acMgr),
      }
    );
    await makeAllViewsPublic(acMgr.connect(admin), vault);
    await setupAMRole(acMgr.connect(admin), vault, roles, "LP_ROLE", [
      "withdraw",
      "deposit",
      "mint",
      "redeem",
      "transfer",
    ]);
    // Whitelist LPs
    await asset.connect(lp).approve(vault, MaxUint256);
    await asset.connect(lp2).approve(vault, MaxUint256);
    await acMgr.connect(admin).grantRole(roles.LP_ROLE, lp, 0);
    await acMgr.connect(admin).grantRole(roles.LP_ROLE, lp2, 0);
    return vault;
  }

  return {
    USDC,
    IdleInvestStrategy,
    AaveV3InvestStrategy,
    ERC4626InvestStrategy,
    DummyInvestStrategy,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    investVault,
    setupVault,
  };
}

async function setUpIdleOnly() {
  const ret = await helpers.loadFixture(setUp);
  const strategy = await ret.IdleInvestStrategy.deploy(ret.USDC);
  const vault = await ret.setupVault(ret.USDC, [strategy], [ethers.toUtf8Bytes("")], [0], [0]);
  return { ...ret, vault, strategy };
}

async function setUpMultiStrategies() {
  const ret = await helpers.loadFixture(setUp);
  const strategy = await ret.IdleInvestStrategy.deploy(ret.USDC);
  const erc4626strategy = await ret.ERC4626InvestStrategy.deploy(ret.investVault);
  const vault = await ret.setupVault(
    ret.USDC,
    [erc4626strategy, strategy],
    [ethers.toUtf8Bytes(""), ethers.toUtf8Bytes("")],
    [0, 1],
    [1, 0] // withdraw first from strategy
  );
  return { ...ret, vault, strategy, erc4626strategy };
}

describe("IdleInvestStrategy contract tests", function () {
  it("Initializes the vault correctly", async () => {
    const { USDC, vault, strategy } = await setUpIdleOnly();
    expect(await vault.name()).to.equal(NAME);
    expect(await vault.symbol()).to.equal(SYMB);
    expect(await vault.asset()).to.equal(USDC);
    expect(await vault.totalAssets()).to.equal(0);
    expect(await strategy.asset(vault)).to.equal(USDC);
    expect(await strategy.totalAssets(vault)).to.equal(0);
  });

  it("Deposit and withdrawal works", async () => {
    const { USDC, vault, lp, strategy } = await setUpIdleOnly();
    const lpBalance = await USDC.balanceOf(lp);
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await vault.totalAssets()).to.equal(_A(100));
    await vault.connect(lp).withdraw(_A(30), lp, lp);
    expect(await vault.totalAssets()).to.equal(_A(70));
    expect(await USDC.balanceOf(lp)).to.equal(lpBalance - _A(70));
    expect(await strategy.maxDeposit(vault)).to.equal(MaxUint256);
    expect(await strategy.maxWithdraw(vault)).to.equal(_A(70));

    await USDC.connect(lp).transfer(vault, _A(10));
    expect(await strategy.maxWithdraw(vault)).to.equal(_A(80));
    expect(await strategy.totalAssets(vault)).to.equal(_A(80));
  });

  it("Can be combined with ERC4626InvestStrategy", async () => {
    const { USDC, vault, lp, strategy, admin } = await setUpMultiStrategies();

    const lpBalance = await USDC.balanceOf(lp);
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await vault.totalAssets()).to.equal(_A(100));

    await vault.connect(lp).withdraw(_A(30), lp, lp);
    expect(await vault.totalAssets()).to.equal(_A(70));

    expect(await strategy.maxWithdraw(vault)).to.equal(_A(0));
    await vault.connect(admin).rebalance(0, 1, _A(20));

    await vault.connect(lp).withdraw(_A(10), lp, lp);
    await vault.connect(lp).withdraw(_A(40), lp, lp);

    expect(await USDC.balanceOf(lp)).to.equal(lpBalance - _A(20));
  });

  it("Can be removed", async () => {
    const { USDC, vault, lp, strategy, admin } = await setUpMultiStrategies();

    const lpBalance = await USDC.balanceOf(lp);
    await vault.connect(lp).deposit(_A(100), lp);
    expect(await vault.totalAssets()).to.equal(_A(100));

    await vault.connect(admin).rebalance(0, 1, _A(80));
    expect(await strategy.totalAssets(vault)).equal(_A(80));

    await expect(vault.connect(admin).removeStrategy(1, false)).to.be.revertedWithCustomError(
      vault,
      "CannotRemoveStrategyWithAssets"
    );
    await expect(vault.connect(admin).removeStrategy(1, true)).not.to.be.reverted;
    expect(await vault.totalAssets()).to.equal(_A(20));
    expect(await strategy.totalAssets(vault)).equal(_A(80));
    await expect(
      vault.connect(admin).addStrategy(strategy, ethers.toUtf8Bytes("foobar"))
    ).to.be.revertedWithCustomError(strategy, "NoExtraDataAllowed");
    await expect(vault.connect(admin).addStrategy(strategy, ethers.toUtf8Bytes(""))).not.to.be.reverted;
    expect(await vault.totalAssets()).to.equal(_A(100));
  });

  it("Checks methods can't be called directly", async () => {
    const { strategy } = await setUpIdleOnly();

    await expect(strategy.getFunction("connect")(ethers.toUtf8Bytes(""))).to.be.revertedWithCustomError(
      strategy,
      "CanBeCalledOnlyThroughDelegateCall"
    );

    await expect(strategy.disconnect(false)).to.be.revertedWithCustomError(
      strategy,
      "CanBeCalledOnlyThroughDelegateCall"
    );

    await expect(strategy.deposit(123)).to.be.revertedWithCustomError(strategy, "CanBeCalledOnlyThroughDelegateCall");

    await expect(strategy.withdraw(123)).to.be.revertedWithCustomError(strategy, "CanBeCalledOnlyThroughDelegateCall");

    await expect(strategy.forwardEntryPoint(1, ethers.toUtf8Bytes(""))).to.be.revertedWithCustomError(
      strategy,
      "CanBeCalledOnlyThroughDelegateCall"
    );
  });

  it("Checks forwardToStrategy fails with any input", async () => {
    const { vault, admin } = await setUpIdleOnly();
    await expect(vault.connect(admin).forwardToStrategy(0, 123, ethers.toUtf8Bytes(""))).to.be.reverted;
  });
});
