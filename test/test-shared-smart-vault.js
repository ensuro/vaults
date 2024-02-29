const { expect } = require("chai");
const { amountFunction, accessControlMessage, getDefaultSigner } = require("@ensuro/core/js/utils");
const { initCurrency } = require("@ensuro/core/js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers;
const { ZeroAddress } = ethers;

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
    const currencyAddr = await ethers.resolveAddress(currency);

    const SmartVaultMock = await ethers.getContractFactory("SmartVaultMock");
    const sv = await SmartVaultMock.deploy();
    const svAddr = await ethers.resolveAddress(sv);

    const CollectorMock = await ethers.getContractFactory("CollectorMock");
    const collector = await CollectorMock.deploy(sv);
    const collectorAddr = await ethers.resolveAddress(collector);

    const WithdrawerMock = await ethers.getContractFactory("WithdrawerMock");
    const withdrawer = await WithdrawerMock.deploy(sv);
    const withdrawerAddr = await ethers.resolveAddress(withdrawer);

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock");
    const inv = await InvestmentMock.deploy("AAVE", "aaveInv", currency);
    const invAddr = await ethers.resolveAddress(inv);

    const SSVContract = await ethers.getContractFactory("SharedSmartVault");
    return {
      currency,
      sv,
      inv,
      collector,
      withdrawer,
      SSVContract,
      svAddr,
      collectorAddr,
      withdrawerAddr,
      invAddr,
      currencyAddr,
    };
  }

  async function deployFixtureSSVDeployed() {
    const { svAddr, collectorAddr, withdrawerAddr, invAddr, currencyAddr, SSVContract, ...extraArgs } =
      await helpers.loadFixture(deployFixture);

    const adminAddr = await ethers.resolveAddress(admin);
    const sharedSmartVault = await hre.upgrades.deployProxy(
      SSVContract,
      [NAME, SYMB, adminAddr, collectorAddr, withdrawerAddr, [invAddr], currencyAddr],
      {
        kind: "uups",
        constructorArgs: [svAddr],
      }
    );

    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.LP_ROLE(), lp);
    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.LP_ROLE(), lp2);
    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.ADD_INVESTMENT_ROLE(), addInv);
    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.REMOVE_INVESTMENT_ROLE(), remInv);
    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.GUARDIAN_ROLE(), guardian);

    return {
      svAddr,
      collectorAddr,
      withdrawerAddr,
      invAddr,
      currencyAddr,
      sharedSmartVault,
      SSVContract,
      ...extraArgs,
    };
  }

  it("SharedSmartVault init", async () => {
    const { collector, withdrawer, sv, inv, sharedSmartVault, currency } =
      await helpers.loadFixture(deployFixtureSSVDeployed);

    expect(await sharedSmartVault.name()).to.equal(NAME);
    expect(await sharedSmartVault.symbol()).to.equal(SYMB);
    expect(await sharedSmartVault.smartVault()).to.equal(sv);
    expect(await sharedSmartVault.collector()).to.equal(collector);
    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(inv);
    expect(await sharedSmartVault.withdrawer()).to.equal(withdrawer);
    expect(await sharedSmartVault.asset()).to.equal(currency);
    expect(await sharedSmartVault.totalAssets()).to.equal(0);
  });

  it("SharedSmartVault InvalidSmartVault error", async () => {
    const { collectorAddr, withdrawerAddr, invAddr, currencyAddr, SSVContract } =
      await helpers.loadFixture(deployFixture);

    // Invalid SV
    const adminAddr = await ethers.resolveAddress(admin);
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, adminAddr, collectorAddr, withdrawerAddr, [invAddr], currencyAddr],
        {
          kind: "uups",
          constructorArgs: [ZeroAddress],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "InvalidSmartVault")
      .withArgs(ZeroAddress);
  });

  it("SharedSmartVault InvalidCollector error", async () => {
    const { svAddr, withdrawerAddr, invAddr, currencyAddr, SSVContract } = await helpers.loadFixture(deployFixture);

    // Invalid Collector
    const adminAddr = await ethers.resolveAddress(admin);
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, adminAddr, ZeroAddress, withdrawerAddr, [invAddr], currencyAddr],
        {
          kind: "uups",
          constructorArgs: [svAddr],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "InvalidCollector")
      .withArgs(ZeroAddress);
  });

  it("SharedSmartVault InvalidWithdrawer error", async () => {
    const { svAddr, collectorAddr, invAddr, currencyAddr, SSVContract } = await helpers.loadFixture(deployFixture);

    // Invalid Withdrawer
    const adminAddr = await ethers.resolveAddress(admin);
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, adminAddr, collectorAddr, ZeroAddress, [invAddr], currencyAddr],
        {
          kind: "uups",
          constructorArgs: [svAddr],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "InvalidWithdrawer")
      .withArgs(ZeroAddress);
  });

  it("SharedSmartVault InvalidAsset error", async () => {
    const { svAddr, collectorAddr, withdrawerAddr, invAddr, SSVContract } = await helpers.loadFixture(deployFixture);

    // Invalid Asset
    const adminAddr = await ethers.resolveAddress(admin);
    await expect(
      hre.upgrades.deployProxy(
        SSVContract,
        [NAME, SYMB, adminAddr, collectorAddr, withdrawerAddr, [invAddr], ZeroAddress],
        {
          kind: "uups",
          constructorArgs: [svAddr],
        }
      )
    )
      .to.be.revertedWithCustomError(SSVContract, "InvalidAsset")
      .withArgs(ZeroAddress);
  });

  it("SharedSmartVault EmptyInvestments error", async () => {
    const { svAddr, collectorAddr, withdrawerAddr, currencyAddr, SSVContract } =
      await helpers.loadFixture(deployFixture);
    // EmptyInvestments
    const adminAddr = await ethers.resolveAddress(admin);
    await expect(
      hre.upgrades.deployProxy(SSVContract, [NAME, SYMB, adminAddr, collectorAddr, withdrawerAddr, [], currencyAddr], {
        kind: "uups",
        constructorArgs: [svAddr],
      })
    )
      .to.be.revertedWithCustomError(SSVContract, "EmptyInvestments")
      .withArgs(0);
  });

  it("Only ADMIN can grant roles", async () => {
    const { svAddr, collectorAddr, withdrawerAddr, invAddr, currencyAddr, SSVContract } =
      await helpers.loadFixture(deployFixture);

    const adminAddr = await ethers.resolveAddress(admin);
    const sharedSmartVault = await hre.upgrades.deployProxy(
      SSVContract,
      [NAME, SYMB, adminAddr, collectorAddr, withdrawerAddr, [invAddr], currencyAddr],
      {
        kind: "uups",
        constructorArgs: [svAddr],
      }
    );

    const deployer = await getDefaultSigner(hre);

    // Check the deployer account doesn't have grant role permission
    await expect(sharedSmartVault.grantRole(await sharedSmartVault.LP_ROLE(), lp)).to.be.revertedWith(
      accessControlMessage(deployer, null, "DEFAULT_ADMIN_ROLE")
    );

    await expect(sharedSmartVault.connect(anon).grantRole(await sharedSmartVault.LP_ROLE(), lp)).to.be.revertedWith(
      accessControlMessage(anon, null, "DEFAULT_ADMIN_ROLE")
    );

    await sharedSmartVault.connect(admin).grantRole(await sharedSmartVault.LP_ROLE(), lp);
  });

  it("Should never allow reinitialization", async () => {
    const { sharedSmartVault, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    await expect(sharedSmartVault.initialize("Another Name", "SYMB", lp, lp, lp, [], currency)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Only GUARDIAN_ROLE can upgrade", async () => {
    const { sv, sharedSmartVault, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);
    expect(await sharedSmartVault.smartVault()).to.equal(sv);

    const SmartVaultMock = await ethers.getContractFactory("SmartVaultMock");
    const newSV = await SmartVaultMock.deploy();
    const newImpl = await SSVContract.deploy(newSV);

    await expect(sharedSmartVault.connect(anon).upgradeTo(newImpl)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "GUARDIAN_ROLE")
    );
    // same SV
    expect(await sharedSmartVault.smartVault()).to.equal(sv);
    // correct upgrade
    await sharedSmartVault.connect(guardian).upgradeTo(newImpl);
    // upgraded SV
    expect(await sharedSmartVault.smartVault()).to.equal(newSV);
  });

  it("Only ADD_INVESTMENT_ROLE can add an investment", async () => {
    const { sharedSmartVault, currency, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);
    // anyone can add zero address investment
    await expect(sharedSmartVault.connect(addInv).addInvestment(ZeroAddress))
      .to.be.revertedWithCustomError(SSVContract, "InvalidInvestment")
      .withArgs(ZeroAddress);

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock");
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", currency);

    await expect(sharedSmartVault.connect(anon).addInvestment(newInvestment)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "ADD_INVESTMENT_ROLE")
    );

    await sharedSmartVault.connect(addInv).addInvestment(newInvestment);

    // trying to add again the same investment
    await expect(sharedSmartVault.connect(addInv).addInvestment(newInvestment))
      .to.be.revertedWithCustomError(SSVContract, "InvestmentAlreadyExists")
      .withArgs(newInvestment);
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
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", newAsset);

    // trying to add again the same investment
    await expect(sharedSmartVault.connect(addInv).addInvestment(newInvestment))
      .to.be.revertedWithCustomError(SSVContract, "DifferentAsset")
      .withArgs(newAsset, currency);
  });

  it("Only REMOVE_INVESTMENT_ROLE can remove an investment", async () => {
    const { sharedSmartVault, inv, currency, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);
    // can't remove zero address
    await expect(sharedSmartVault.connect(remInv).removeInvestment(ZeroAddress))
      .to.be.revertedWithCustomError(SSVContract, "InvalidInvestment")
      .withArgs(ZeroAddress);

    await expect(sharedSmartVault.connect(anon).removeInvestment(inv)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "REMOVE_INVESTMENT_ROLE")
    );

    // cannot be deleted if there is only one investment
    await expect(sharedSmartVault.connect(remInv).removeInvestment(inv))
      .to.be.revertedWithCustomError(SSVContract, "EmptyInvestments")
      .withArgs(1);

    // I'll add new investment to remove the firstone
    const InvestmentMock = await ethers.getContractFactory("InvestmentMock"); // mock
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", currency);
    await sharedSmartVault.connect(addInv).addInvestment(newInvestment);

    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(inv);
    expect(await sharedSmartVault.getInvestmentByIndex(1)).to.equal(newInvestment);

    const randomInv = await InvestmentMock.deploy("Random", "rdm", currency);
    await expect(sharedSmartVault.connect(remInv).removeInvestment(randomInv))
      .to.be.revertedWithCustomError(SSVContract, "InvestmentNotFound")
      .withArgs(randomInv);

    // now I can remove
    await sharedSmartVault.connect(remInv).removeInvestment(inv);
    // now the first investment is the newInvestment
    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(newInvestment);
  });

  it("REMOVE_INVESTMENT_ROLE remove the last investment in the array", async () => {
    const { sharedSmartVault, inv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    const InvestmentMock = await ethers.getContractFactory("InvestmentMock"); // mock
    const newInvestment = await InvestmentMock.deploy("Compound", "COMP", currency);
    await sharedSmartVault.connect(addInv).addInvestment(newInvestment);

    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(inv);
    expect(await sharedSmartVault.getInvestmentByIndex(1)).to.equal(newInvestment);

    await sharedSmartVault.connect(remInv).removeInvestment(newInvestment);
    expect(await sharedSmartVault.getInvestmentByIndex(0)).to.equal(inv);

    // newInvestment not exists
    expect(await sharedSmartVault.getInvestmentIndex(newInvestment)).to.equal(MaxUint256);
  });

  it("Address without LP_ROLE can't deposit/mint/withdraw/redeem", async () => {
    const { sharedSmartVault, sv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    // Without LP_ROLE can't deposit/mint
    await expect(sharedSmartVault.connect(anon).deposit(_A(800), anon)).to.be.revertedWith(
      "ERC4626: deposit more than max"
    );
    await expect(sharedSmartVault.connect(anon).mint(_A(800), anon)).to.be.revertedWith("ERC4626: mint more than max");

    // LP_ROLE can deposit and mint
    await currency.connect(lp).approve(sharedSmartVault, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp);
    await sharedSmartVault.connect(lp).mint(_A(1000), lp);
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv)).to.equal(_A(2000));

    // Anons can redeem on behalf of lp if have allowance
    await expect(sharedSmartVault.connect(anon).withdraw(_A(800), lp, lp)).to.be.revertedWith(
      "ERC20: insufficient allowance"
    );
    await expect(sharedSmartVault.connect(anon).redeem(_A(800), lp, lp)).to.be.revertedWith(
      "ERC20: insufficient allowance"
    );

    await sharedSmartVault.connect(lp).approve(anon, _A(800));
    await sharedSmartVault.connect(anon).redeem(_A(800), anon, lp);
    expect(await currency.balanceOf(anon)).to.be.equal(_A(800));

    // LP_ROLE can withdraw and redeem
    await sharedSmartVault.connect(lp).withdraw(_A(1200), lp, lp);
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(0));
    expect(await currency.balanceOf(sv)).to.equal(_A(0));
  });

  it("SharedSmartVault deposit and check balances", async () => {
    const { sharedSmartVault, sv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    expect(await sharedSmartVault.totalAssets()).to.equal(0);

    await currency.connect(lp).approve(sharedSmartVault, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp);

    expect(await sharedSmartVault.totalAssets()).to.equal(_A(1000));
    expect(await currency.balanceOf(sv)).to.equal(_A(1000));
  });

  it("SharedSmartVault withdraw and check balances", async () => {
    const { sharedSmartVault, sv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    expect(await sharedSmartVault.totalAssets()).to.equal(0);
    expect(await currency.balanceOf(lp)).to.equal(_A(10000));

    await currency.connect(lp).approve(sharedSmartVault, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp);

    expect(await currency.balanceOf(lp)).to.equal(_A(9000));
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(1000));
    expect(await currency.balanceOf(sv)).to.equal(_A(1000));

    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxRedeem(lp)).to.equal(_A(1000));
    await sharedSmartVault.connect(lp).withdraw(_A(1000), lp, lp);

    expect(await currency.balanceOf(lp)).to.equal(_A(10000));
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(0));
    expect(await currency.balanceOf(sv)).to.equal(_A(0));
  });

  it("Fails on faulty collector", async () => {
    const { sharedSmartVault, SSVContract, currency, collector } = await helpers.loadFixture(deployFixtureSSVDeployed);

    await collector.setFaulty(true);

    await currency.connect(lp).approve(sharedSmartVault, _A(5000));
    await expect(sharedSmartVault.connect(lp).deposit(_A(1000), lp))
      .to.be.revertedWithCustomError(SSVContract, "DifferentBalance")
      .withArgs(_A(1000), _A(0));
  });

  it("Fails on faulty withdrawer", async () => {
    const { sharedSmartVault, currency, withdrawer } = await helpers.loadFixture(deployFixtureSSVDeployed);

    await withdrawer.setFaulty(true);

    await currency.connect(lp).approve(sharedSmartVault, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp);

    await expect(sharedSmartVault.connect(lp).withdraw(_A(1000), lp, lp)).to.be.revertedWith(
      "ERC20: transfer amount exceeds balance"
    );
  });

  it("SharedSmartVault deposit and invest in the investments", async () => {
    const { sharedSmartVault, sv, inv, currency, SSVContract } = await helpers.loadFixture(deployFixtureSSVDeployed);

    await currency.connect(lp).approve(sharedSmartVault, _A(5000));
    await currency.connect(lp2).approve(sharedSmartVault, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp);
    await sharedSmartVault.connect(lp2).deposit(_A(1000), lp2);

    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv)).to.equal(_A(2000));
    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxWithdraw(lp2)).to.equal(_A(1000));

    // SV invest all in the inv
    await sv.invest(inv, currency, _A(2000));
    expect(await inv.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(inv)).to.equal(_A(2000));

    // try to remove the investment with funds
    await expect(sharedSmartVault.connect(remInv).removeInvestment(inv))
      .to.be.revertedWithCustomError(SSVContract, "InvestmentWithFunds")
      .withArgs(inv, _A(2000));

    // TotalAssets should be the same but the balance of the SV is 0 now
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv)).to.equal(_A(0));

    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxWithdraw(lp2)).to.equal(_A(1000));
  });

  it("SharedSmartVault invest, deinvest and withdraw", async () => {
    const { sharedSmartVault, sv, inv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    await currency.connect(lp).approve(sharedSmartVault, _A(5000));
    await currency.connect(lp2).approve(sharedSmartVault, _A(5000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp);
    await sharedSmartVault.connect(lp2).deposit(_A(1000), lp2);
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv)).to.equal(_A(2000));
    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxWithdraw(lp2)).to.equal(_A(1000));

    // SV invest only 1500 in the investment
    await sv.invest(inv, currency, _A(1500));
    expect(await inv.totalAssets()).to.equal(_A(1500));
    expect(await currency.balanceOf(inv)).to.equal(_A(1500));
    expect(await currency.balanceOf(sv)).to.equal(_A(500));

    // TotalAssets should be the same but the balance of the SV is 500 now
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxRedeem(lp2)).to.equal(_A(1000));

    await sv.deinvest(inv, _A(500));
    expect(await inv.totalAssets()).to.equal(_A(1000));
    expect(await currency.balanceOf(inv)).to.equal(_A(1000));
    expect(await currency.balanceOf(sv)).to.equal(_A(1000));
  });

  it("SharedSmartVault with notLiquidFunds", async () => {
    const { sharedSmartVault, sv, inv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    sv.setInvestments([inv]);

    await currency.connect(lp).approve(sharedSmartVault, _A(1000));
    await currency.connect(lp2).approve(sharedSmartVault, _A(1000));
    await sharedSmartVault.connect(lp).deposit(_A(1000), lp);
    await sharedSmartVault.connect(lp2).deposit(_A(1000), lp2);
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv)).to.equal(_A(2000));
    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxWithdraw(lp2)).to.equal(_A(1000));

    // SV invest only 1500 in the investment
    await sv.invest(inv, currency, _A(1500));
    expect(await inv.totalAssets()).to.equal(_A(1500));
    expect(await currency.balanceOf(inv)).to.equal(_A(1500));
    expect(await currency.balanceOf(sv)).to.equal(_A(500));

    // TotalAssets should be the same but the balance of the SV is 500 now
    expect(await sharedSmartVault.totalAssets()).to.equal(_A(2000));
    expect(await currency.balanceOf(sv)).to.equal(_A(500));
    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(1000));
    expect(await sharedSmartVault.maxRedeem(lp2)).to.equal(_A(1000));

    await inv.setNotLiquidFunds(_A(1500)); // no liquid funds

    expect(await inv.totalAssets()).to.equal(_A(1500)); // don't change

    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(500));
    expect(await sharedSmartVault.maxRedeem(lp2)).to.equal(_A(500));

    await inv.setNotLiquidFunds(_A(1200)); // liquid: 300

    await sharedSmartVault.connect(lp).withdraw(_A(800), lp, lp);
  });

  it("SharedSmartVault with earnings", async () => {
    const { sharedSmartVault, sv, inv, currency } = await helpers.loadFixture(deployFixtureSSVDeployed);

    await currency.connect(lp).approve(sharedSmartVault, _A(100));
    await currency.connect(lp2).approve(sharedSmartVault, _A(80));
    await currency.connect(anon).approve(inv, _A(80));

    await sharedSmartVault.connect(lp).deposit(_A(100), lp);
    await sharedSmartVault.connect(lp2).deposit(_A(80), lp2);

    expect(await sharedSmartVault.maxWithdraw(lp)).to.equal(_A(100));
    expect(await sharedSmartVault.maxWithdraw(lp2)).to.equal(_A(80));

    await sv.invest(inv, currency, _A(180));

    await currency.connect(owner).transfer(sv, _A(18));
    expect(await sharedSmartVault.maxWithdraw(lp)).to.be.closeTo(_A(110), _A(0.01));
    expect(await sharedSmartVault.maxWithdraw(lp2)).to.be.closeTo(_A(88), _A(0.01));
  });
});
