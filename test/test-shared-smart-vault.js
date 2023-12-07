const { expect } = require("chai");
const { amountFunction, accessControlMessage } = require("@ensuro/core/js/utils");
const { initCurrency } = require("@ensuro/core/js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers.constants;
const { AddressZero } = ethers.constants;

describe("SharedSmartVault contract tests", function () {
  let _A;
  let addInv, admin, anon, cust, guardian, lp, lp2, owner, remInv;
  const NAME = "Shared Vault";
  const SYMB = "ssVault";

  beforeEach(async () => {
    [, lp, lp2, cust, addInv, remInv, owner, anon, guardian, admin] = await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
      [lp, lp2, cust, owner],
      [_A(10000), _A(10000), _A(2000), _A(1000)]
    );

    const SmartVaultMock = await ethers.getContractFactory("SmartVaultMock");
    const sv = await SmartVaultMock.deploy();

    const CollectorMock = await ethers.getContractFactory("CollectorMock");
    const collector = await CollectorMock.deploy(sv.address);

    const WithdrawerMock = await ethers.getContractFactory("WithdrawerMock");
    const withdrawer = await WithdrawerMock.deploy(sv.address);

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock");
    const inv = await InvestmentMock.deploy("AAVE", "aaveInv", currency.address);

    const SSVContract = await ethers.getContractFactory("SharedSmartVault");
    return { currency, sv, inv, collector, withdrawer, SSVContract };
  }

  async function deployFixtureSSVDeployed() {
    const { collector, withdrawer, sv, inv, SSVContract, currency } = await helpers.loadFixture(deployFixture);

    const sharedSmartVault = await hre.upgrades.deployProxy(
      SSVContract,
      [NAME, SYMB, admin.address, collector.address, withdrawer.address, [inv.address], currency.address],
      {
        kind: "uups",
        constructorArgs: [sv.address],
      }
    );

    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.LP_ROLE(), lp.address);
    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.LP_ROLE(), lp2.address);
    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.ADD_INVESTMENT_ROLE(), addInv.address);
    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.REMOVE_INVESTMENT_ROLE(), remInv.address);
    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.GUARDIAN_ROLE(), guardian.address);

    return { currency, sv, inv, collector, withdrawer, sharedSmartVault, SSVContract };
  }

  it("SharedSmartVault init", async () => {
    const { collector, withdrawer, sv, inv, sharedSmartVault, currency } =
      await helpers.loadFixture(deployFixtureSSVDeployed);

    expect(await sharedSmartVault.name()).to.equal(NAME);
    expect(await sharedSmartVault.symbol()).to.equal(SYMB);
    expect(await sharedSmartVault.smartVault()).to.equal(sv.address);
    expect(await sharedSmartVault.collector()).to.equal(collector.address);
    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(inv.address);
    expect(await sharedSmartVault.withdrawer()).to.equal(withdrawer.address);
    expect(await sharedSmartVault.asset()).to.equal(currency.address);
    expect(await sharedSmartVault.totalAssets()).to.equal(0);
  });

  it("SharedSmartVault InvalidSmartVault error", async () => {
    const { collector, withdrawer, inv, currency, SSVContract } = await helpers.loadFixture(deployFixture);

    // Invalid Withdrawer
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, admin.address, collector.address, withdrawer.address, [inv.address], currency.address],
        {
          kind: "uups",
          constructorArgs: [AddressZero],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "InvalidSmartVault")
      .withArgs(AddressZero);
  });

  it("SharedSmartVault InvalidCollector error", async () => {
    const { withdrawer, sv, inv, currency, SSVContract } = await helpers.loadFixture(deployFixture);

    // Invalid Collector
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, admin.address, AddressZero, withdrawer.address, [inv.address], currency.address],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "InvalidCollector")
      .withArgs(AddressZero);
  });

  it("SharedSmartVault InvalidWithdrawer error", async () => {
    const { collector, sv, inv, currency, SSVContract } = await helpers.loadFixture(deployFixture);

    // Invalid Withdrawer
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, admin.address, collector.address, AddressZero, [inv.address], currency.address],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "InvalidWithdrawer")
      .withArgs(AddressZero);
  });

  it("SharedSmartVault InvalidAsset error", async () => {
    const { collector, withdrawer, sv, inv, SSVContract } = await helpers.loadFixture(deployFixture);

    // Invalid Asset
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, admin.address, collector.address, withdrawer.address, [inv.address], AddressZero],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "InvalidAsset")
      .withArgs(AddressZero);
  });

  it("SharedSmartVault EmptyInvestments error", async () => {
    const { collector, withdrawer, sv, currency, SSVContract } = await helpers.loadFixture(deployFixture);
    // EmptyInvestments
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, admin.address, collector.address, withdrawer.address, [], currency.address],
        {
          kind: "uups",
          constructorArgs: [sv.address],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "EmptyInvestments")
      .withArgs(0);
  });

  it("Only ADMIN can grant roles", async () => {
    const { collector, withdrawer, sv, inv, SSVContract, currency } = await helpers.loadFixture(deployFixture);

    const sharedSmartVault = await hre.upgrades.deployProxy(
      SSVContract,
      [NAME, SYMB, admin.address, collector.address, withdrawer.address, [inv.address], currency.address],
      {
        kind: "uups",
        constructorArgs: [sv.address],
      }
    );

    await expect(
      sharedSmartVault.connect(anon).grantRole(await sharedSmartVault.LP_ROLE(), lp.address)
    ).to.be.revertedWith(accessControlMessage(anon.address, null, "DEFAULT_ADMIN_ROLE"));

    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.LP_ROLE(), lp.address);
  });

  it("Only GUARDIAN_ROLE can upgrade", async () => {
    const { sv, sharedSmartVault, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);
    expect(await sharedSmartVault.smartVault()).to.equal(sv.address);

    const SmartVaultMock = await ethers.getContractFactory("SmartVaultMock");
    const newSV = await SmartVaultMock.deploy();
    const newImpl = await SSVContract.deploy(newSV.address);

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
    const { sharedSmartVault, currency, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);
    // anyone can add zero address investment
    await expect(sharedSmartVault.connect(addInv).addInvestment(AddressZero))
      .to.be.revertedWithCustomError(SSVContract, "InvalidInvestment")
      .withArgs(AddressZero);

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock");
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", currency.address);

    await expect(sharedSmartVault.connect(anon).addInvestment(newInvestment.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "ADD_INVESTMENT_ROLE")
    );

    await sharedSmartVault.connect(addInv).addInvestment(newInvestment.address);

    // trying to add again the same investment
    await expect(sharedSmartVault.connect(addInv).addInvestment(newInvestment.address))
      .to.be.revertedWithCustomError(SSVContract, "InvestmentAlreadyExists")
      .withArgs(newInvestment.address);
  });

  it("Can't add investment with different asset", async () => {
    const { sharedSmartVault, currency, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);
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
      .to.be.revertedWithCustomError(SSVContract, "DifferentAsset")
      .withArgs(newAsset.address, currency.address);
  });

  it("Only REMOVE_INVESTMENT_ROLE can remove an investment", async () => {
    const { sharedSmartVault, inv, currency, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);
    // can't remove zero address
    await expect(sharedSmartVault.connect(remInv).removeInvestment(AddressZero))
      .to.be.revertedWithCustomError(SSVContract, "InvalidInvestment")
      .withArgs(AddressZero);

    await expect(sharedSmartVault.connect(anon).removeInvestment(inv.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "REMOVE_INVESTMENT_ROLE")
    );

    // cannot be deleted if there is only one investment
    await expect(sharedSmartVault.connect(remInv).removeInvestment(inv.address))
      .to.be.revertedWithCustomError(SSVContract, "EmptyInvestments")
      .withArgs(1);

    // I'll add new investment to remove the firstone
    const InvestmentMock = await ethers.getContractFactory("InvestmentMock"); // mock
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", currency.address);
    await sharedSmartVault.connect(addInv).addInvestment(newInvestment.address);

    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(inv.address);
    expect(await sharedSmartVault.getInvestmentByIndex(1)).to.equal(newInvestment.address);

    const randomInv = await InvestmentMock.deploy("Random", "rdm", currency.address);
    await expect(sharedSmartVault.connect(remInv).removeInvestment(randomInv.address))
      .to.be.revertedWithCustomError(SSVContract, "InvestmentNotFound")
      .withArgs(randomInv.address);

    // now I can remove
    await sharedSmartVault.connect(remInv).removeInvestment(inv.address);
    // now the first investment is the newInvestment
    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(newInvestment.address);
  });

  it("REMOVE_INVESTMENT_ROLE remove the last investment in the array", async () => {
    const { sharedSmartVault, inv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock"); // mock
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", currency.address);
    await sharedSmartVault.connect(addInv).addInvestment(newInvestment.address);

    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(inv.address);
    expect(await sharedSmartVault.getInvestmentByIndex(1)).to.equal(newInvestment.address);

    await sharedSmartVault.connect(remInv).removeInvestment(newInvestment.address);
    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(inv.address);

    // newInvestment not exists
    expect(await sharedSmartVault.getInvestmentIndex(newInvestment.address)).to.equal(MaxUint256);
  });

  it("Address without LP_ROLE can't deposit/mint/withdraw/redeem", async () => {
    const { sharedSmartVault, sv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    // Without LP_ROLE can't deposit/mint
    await expect(sharedSmartVault.connect(anon).deposit(_A(800), anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );
    await expect(sharedSmartVault.connect(anon).mint(_A(800), anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );

    // LP_ROLE can deposit and mint
    await currency.connect(lp).approve(sharedSmartVault.address, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp.address);
    await sharedSmartVault.connect(lp).mint(_A(1000), lp.address);
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(2000));

    // Without LP_ROLE can't withdraw/mint
    await expect(sharedSmartVault.connect(anon).withdraw(_A(800), lp.address, lp.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );
    await expect(sharedSmartVault.connect(anon).redeem(_A(800), lp.address, lp.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );

    // LP_ROLE can withdraw and redeem
    await sharedSmartVault.connect(lp).withdraw(_A(1200), lp.address, lp.address);
    await sharedSmartVault.connect(lp).redeem(_A(800), lp.address, lp.address);
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(0));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(0));
  });

  it("SharedSmartVault deposit and check balances", async () => {
    const { sharedSmartVault, sv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    expect(await sharedSmartVault.totalAssets()).to.equal(0);

    await currency.connect(lp).approve(sharedSmartVault.address, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp.address);

    expect(await sharedSmartVault.totalAssets()).to.equal(_A(1000));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(1000));
  });

  it("SharedSmartVault withdraw and check balances", async () => {
    const { sharedSmartVault, sv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    expect(await sharedSmartVault.totalAssets()).to.equal(0);
    expect(await currency.balanceOf(lp.address)).to.equal(_A(10000));

    await currency.connect(lp).approve(sharedSmartVault.address, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp.address);

    expect(await currency.balanceOf(lp.address)).to.equal(_A(9000));
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(1000));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(1000));

    expect(await sharedSmartVault.maxWithdraw(lp.address)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxRedeem(lp.address)).to.equal(_A(1000));
    await sharedSmartVault.connect(lp).withdraw(_A(1000), lp.address, lp.address);

    expect(await currency.balanceOf(lp.address)).to.equal(_A(10000));
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(0));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(0));
  });

  it("SharedSmartVault deposit and invest in the investments", async () => {
    const { sharedSmartVault, sv, inv, currency, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);

    await currency.connect(lp).approve(sharedSmartVault.address, _A(5000));
    await currency.connect(lp2).approve(sharedSmartVault.address, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp.address);
    await sharedSmartVault.connect(lp2).deposit(_A(1000), lp2.address);

    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(2000));
    expect(await sharedSmartVault.maxWithdraw(lp.address)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxWithdraw(lp2.address)).to.equal(_A(1000));

    // SV invest all in the inv
    await sv.invest(inv.address, currency.address, _A(2000));
    expect(await inv.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(inv.address)).to.equal(_A(2000));

    // try to remove the investment with funds
    await expect(sharedSmartVault.connect(remInv).removeInvestment(inv.address))
      .to.be.revertedWithCustomError(SSVContract, "InvestmentWithFunds")
      .withArgs(inv.address, _A(2000));

    // TotalAssets should be the same but the balance of the SV is 0 now
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(0));

    // no liquid money
    expect(await sharedSmartVault.maxWithdraw(lp.address)).to.equal(_A(0));
    expect(await sharedSmartVault.maxWithdraw(lp2.address)).to.equal(_A(0));
  });

  it("SharedSmartVault invest, deinvest and withdraw", async () => {
    const { sharedSmartVault, sv, inv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    await currency.connect(lp).approve(sharedSmartVault.address, _A(5000));
    await currency.connect(lp2).approve(sharedSmartVault.address, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp.address);
    await sharedSmartVault.connect(lp2).deposit(_A(1000), lp2.address);
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(2000));
    expect(await sharedSmartVault.maxWithdraw(lp.address)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxWithdraw(lp2.address)).to.equal(_A(1000));

    // SV invest only 1500 in the investment
    await sv.invest(inv.address, currency.address, _A(1500));
    expect(await inv.totalAssets()).to.equal(_A(1500));
    expect(await currency.balanceOf(inv.address)).to.equal(_A(1500));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(500));

    // TotalAssets should be the same but the balance of the SV is 0 now
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await sharedSmartVault.maxWithdraw(lp.address)).to.equal(_A(500));
    expect(await sharedSmartVault.maxRedeem(lp2.address)).to.equal(_A(500));

    await sv.deinvest(inv.address, _A(500));
    expect(await inv.totalAssets()).to.equal(_A(1000));
    expect(await currency.balanceOf(inv.address)).to.equal(_A(1000));
    expect(await currency.balanceOf(sv.address)).to.equal(_A(1000));
  });
});
