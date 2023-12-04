const { expect } = require("chai");
const { amountFunction } = require("@ensuro/core/js/utils");
const { initCurrency, deployPool } = require("@ensuro/core/js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { AddressZero } = ethers.constants;

describe("SharedSmartVault contract tests", function () {
  let _A;
  let addInv, cust, guardian, lp, lp2, owner, remInv;
  const NAME = "Shared Vault";
  const SYMB = "ssVault";

  beforeEach(async () => {
    [, lp, lp2, cust, addInv, remInv, owner, guardian] = await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
      [lp, lp2, cust, owner],
      [_A(10000), _A(10000), _A(2000), _A(1000)]
    );

    const pool = await deployPool({
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    const SmartVaultMock = await ethers.getContractFactory("SmartVaultMock");
    const sv = await SmartVaultMock.deploy();

    const CollectorMock = await ethers.getContractFactory("CollectorMock");
    const collector = await CollectorMock.deploy(sv.address);

    const WithdrawerMock = await ethers.getContractFactory("WithdrawerMock");
    const withdrawer = await WithdrawerMock.deploy(sv.address);

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock"); // mock
    const investment1 = await InvestmentMock.deploy("AAVE", "aaveInv", currency.address);

    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");
    const sharedSmartVault = await hre.upgrades.deployProxy(
      SharedSmartVault,
      [NAME, SYMB, collector.address, withdrawer.address, [investment1.address], currency.address],
      {
        kind: "uups",
        constructorArgs: [sv.address],
      }
    );

    await sharedSmartVault.grantRole(await sharedSmartVault.LP_ROLE(), lp.address);
    await sharedSmartVault.grantRole(await sharedSmartVault.ADD_INVESTMENT_ROLE(), addInv.address);
    await sharedSmartVault.grantRole(await sharedSmartVault.REMOVE_INVESTMENT_ROLE(), remInv.address);
    await sharedSmartVault.grantRole(await sharedSmartVault.GUARDIAN_ROLE(), guardian.address);

    return { currency, pool, accessManager, sv, investment1, collector, withdrawer, sharedSmartVault };
  }

  it("SharedSmartVault init", async () => {
    const { collector, withdrawer, sv, sharedSmartVault, currency } = await helpers.loadFixture(deployPoolFixture);

    expect(await sharedSmartVault.name()).to.equal(NAME);
    expect(await sharedSmartVault.symbol()).to.equal(SYMB);
    expect(await sharedSmartVault.smartVault()).to.equal(sv.address);
    expect(await sharedSmartVault.collector()).to.equal(collector.address);
    expect(await sharedSmartVault.withdrawer()).to.equal(withdrawer.address);
    expect(await sharedSmartVault.asset()).to.equal(currency.address);
    expect(await sharedSmartVault.totalAssets()).to.equal(0);
  });

  it("SharedSmartVault InvalidSmartVault error", async () => {
    const { collector, withdrawer, investment1, currency } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // Invalid Withdrawer
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, collector.address, withdrawer.address, [investment1.address], currency.address],
        {
          kind: "uups",
          constructorArgs: [AddressZero],
        }
      )
    )
      .to.be.revertedWithCustomError(SharedSmartVault, "InvalidSmartVault")
      .withArgs(AddressZero);
  });

  it("SharedSmartVault InvalidCollector error", async () => {
    const { withdrawer, sv, investment1, currency } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // Invalid Collector
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, AddressZero, withdrawer.address, [investment1.address], currency.address],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SharedSmartVault, "InvalidCollector")
      .withArgs(AddressZero);
  });

  it("SharedSmartVault InvalidWithdrawer error", async () => {
    const { collector, sv, investment1, currency } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // Invalid Withdrawer
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, collector.address, AddressZero, [investment1.address], currency.address],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SharedSmartVault, "InvalidWithdrawer")
      .withArgs(AddressZero);
  });

  it("SharedSmartVault InvalidAsset error", async () => {
    const { collector, withdrawer, sv, investment1 } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // Invalid Asset
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, collector.address, withdrawer.address, [investment1.address], AddressZero],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SharedSmartVault, "InvalidAsset")
      .withArgs(AddressZero);
  });
});
