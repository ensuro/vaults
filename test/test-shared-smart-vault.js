const { expect } = require("chai");
const { amountFunction, accessControlMessage } = require("@ensuro/core/js/utils");
const { initCurrency, deployPool } = require("@ensuro/core/js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { AddressZero } = ethers.constants;

describe("SharedSmartVault contract tests", function () {
  let _A;
  let addInv, anon, cust, guardian, lp, lp2, owner, remInv;
  const NAME = "Shared Vault";
  const SYMB = "ssVault";

  beforeEach(async () => {
    [, lp, lp2, cust, addInv, remInv, owner, anon, guardian] = await ethers.getSigners();

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

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock");
    const inv = await InvestmentMock.deploy("AAVE", "aaveInv", currency.address);

    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");
    const sharedSmartVault = await hre.upgrades.deployProxy(
      SharedSmartVault,
      [NAME, SYMB, collector.address, withdrawer.address, [inv.address], currency.address],
      {
        kind: "uups",
        constructorArgs: [sv.address],
      }
    );

    await sharedSmartVault.grantRole(await sharedSmartVault.LP_ROLE(), lp.address);
    await sharedSmartVault.grantRole(await sharedSmartVault.ADD_INVESTMENT_ROLE(), addInv.address);
    await sharedSmartVault.grantRole(await sharedSmartVault.REMOVE_INVESTMENT_ROLE(), remInv.address);
    await sharedSmartVault.grantRole(await sharedSmartVault.GUARDIAN_ROLE(), guardian.address);

    return { currency, pool, accessManager, sv, inv, collector, withdrawer, sharedSmartVault };
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
    const { collector, withdrawer, inv, currency } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // Invalid Withdrawer
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, collector.address, withdrawer.address, [inv.address], currency.address],
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
    const { withdrawer, sv, inv, currency } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // Invalid Collector
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, AddressZero, withdrawer.address, [inv.address], currency.address],
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
    const { collector, sv, inv, currency } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // Invalid Withdrawer
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, collector.address, AddressZero, [inv.address], currency.address],
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
    const { collector, withdrawer, sv, inv } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // Invalid Asset
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, collector.address, withdrawer.address, [inv.address], AddressZero],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SharedSmartVault, "InvalidAsset")
      .withArgs(AddressZero);
  });

  it("SharedSmartVault EmptyInvestments error", async () => {
    const { collector, withdrawer, sv, currency } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    // EmptyInvestments
    await expect(
      hre.upgrades.deployProxy(
        SharedSmartVault,
        [NAME, SYMB, collector.address, withdrawer.address, [], currency.address],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SharedSmartVault, "EmptyInvestments")
      .withArgs(0);
  });

  it("Only GUARDIAN_ROLE can upgrade", async () => {
    const { sv, sharedSmartVault } = await helpers.loadFixture(deployPoolFixture);
    expect(await sharedSmartVault.smartVault()).to.equal(sv.address);

    const SmartVaultMock = await ethers.getContractFactory("SmartVaultMock");
    const newSV = await SmartVaultMock.deploy();
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");
    const newImpl = await SharedSmartVault.deploy(newSV.address);

    await expect(sharedSmartVault.connect(anon).upgradeTo(newImpl.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "GUARDIAN_ROLE")
    );
    // same SV
    expect(await sharedSmartVault.smartVault()).to.equal(sv.address);
    // correct upgrade
    await sharedSmartVault.connect(guardian).upgradeTo(newImpl.address);
    // upgraded SV
    expect(await sharedSmartVault.smartVault()).to.equal(newSV.address);
  });

  it("Only ADD_INVESTMENT_ROLE can add an investment", async () => {
    const { sharedSmartVault, currency } = await helpers.loadFixture(deployPoolFixture);
    // anyone can add zero address investment
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");
    await expect(sharedSmartVault.connect(addInv).addInvestment(AddressZero))
      .to.be.revertedWithCustomError(SharedSmartVault, "InvalidInvestment")
      .withArgs(AddressZero);

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock");
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", currency.address);

    await expect(sharedSmartVault.connect(anon).addInvestment(newInvestment.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "ADD_INVESTMENT_ROLE")
    );

    await sharedSmartVault.connect(addInv).addInvestment(newInvestment.address);

    // trying to add again the same investment
    await expect(sharedSmartVault.connect(addInv).addInvestment(newInvestment.address))
      .to.be.revertedWithCustomError(SharedSmartVault, "InvestmentAlreadyExists")
      .withArgs(newInvestment.address);
  });

  it("Can't add investment with different asset", async () => {
    const { sharedSmartVault, currency } = await helpers.loadFixture(deployPoolFixture);
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");

    const newAsset = await initCurrency({
      name: "Other Asset",
      symbol: "OTHER",
      decimals: 6,
      initial_supply: _A(50000),
    });

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock");
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", newAsset.address);

    // trying to add again the same investment
    await expect(sharedSmartVault.connect(addInv).addInvestment(newInvestment.address))
      .to.be.revertedWithCustomError(SharedSmartVault, "DifferentAsset")
      .withArgs(newAsset.address, currency.address);
  });

  it("Only REMOVE_INVESTMENT_ROLE can remove an investment", async () => {
    const { sharedSmartVault, inv, currency } = await helpers.loadFixture(deployPoolFixture);
    // can't remove zero address
    const SharedSmartVault = await ethers.getContractFactory("SharedSmartVault");
    await expect(sharedSmartVault.connect(remInv).removeInvestment(AddressZero))
      .to.be.revertedWithCustomError(SharedSmartVault, "InvalidInvestment")
      .withArgs(AddressZero);

    await expect(sharedSmartVault.connect(anon).removeInvestment(inv.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "REMOVE_INVESTMENT_ROLE")
    );

    // cannot be deleted if there is only one investment
    await expect(sharedSmartVault.connect(remInv).removeInvestment(inv.address))
      .to.be.revertedWithCustomError(SharedSmartVault, "EmptyInvestments")
      .withArgs(1);

    // I'll add new investment to remove the firstone
    const InvestmentMock = await ethers.getContractFactory("InvestmentMock"); // mock
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", currency.address);
    await sharedSmartVault.connect(addInv).addInvestment(newInvestment.address);

    const randomInv = await InvestmentMock.deploy("Random", "rdm", currency.address);
    await expect(sharedSmartVault.connect(remInv).removeInvestment(randomInv.address))
      .to.be.revertedWithCustomError(SharedSmartVault, "InvestmentNotFound")
      .withArgs(randomInv.address);

    // now I can remove
    await sharedSmartVault.connect(remInv).removeInvestment(inv.address);
  });
});
