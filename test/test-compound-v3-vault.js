const { expect } = require("chai");
const { amountFunction, _W, getRole, accessControlMessage, getTransactionEvent } = require("@ensuro/core/js/utils");
const { initForkCurrency, setupChain } = require("@ensuro/core/js/test-utils");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig, encodeDummyStorage } = require("./utils");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256, ZeroAddress } = hre.ethers;

const ADDRESSES = {
  // polygon mainnet addresses
  UNISWAP: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDCWhale: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  cUSDCv3: "0xF25212E676D1F7F89Cd72fFEe66158f541246445",
  REWARDS: "0x45939657d1CA34A8FA39A924B71D28Fe8431e581",
  COMP: "0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c",
  cUSDCv3_GUARDIAN: "0x8Ab717CAC3CbC4934E63825B88442F5810aAF6e5",
};

const CometABI = [
  {
    inputs: [
      { internalType: "bool", name: "supplyPaused", type: "bool" },
      { internalType: "bool", name: "transferPaused", type: "bool" },
      { internalType: "bool", name: "withdrawPaused", type: "bool" },
      { internalType: "bool", name: "absorbPaused", type: "bool" },
      { internalType: "bool", name: "buyPaused", type: "bool" },
    ],
    name: "pause",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [], name: "Paused", type: "error" },
];

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const TEST_BLOCK = 54090000;
const MCENT = 10n; // 1/1000 of a cent
const CENT = _A("0.01");
const HOUR = 3600;
const DAY = HOUR * 24;
const MONTH = DAY * 30;
const INITIAL = 10000;
const NAME = "Compound USDCv3 Vault";
const SYMB = "ecUSDCv3";

const FEETIER = 3000;

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();
  const currency = await initForkCurrency(ADDRESSES.USDC, ADDRESSES.USDCWhale, [lp, lp2], [_A(INITIAL), _A(INITIAL)]);

  const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
  const swapLibrary = await SwapLibrary.deploy();

  const swapConfig = buildUniswapConfig(_W("0.00001"), FEETIER, ADDRESSES.UNISWAP);
  const adminAddr = await ethers.resolveAddress(admin);
  return {
    currency,
    swapConfig,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    swapLibrary,
  };
}

const tagRegExp = new RegExp("\\[(?<neg>[!])?(?<variant>[a-zA-Z0-9]+)\\]", "gu");

function tagit(testDescription, test) {
  let any = false;
  for (const m of testDescription.matchAll(tagRegExp)) {
    if (m === undefined) break;
    const neg = m.groups.neg !== undefined;
    any = any || !neg;
    if (m.groups.variant === this.name) {
      if (!neg) {
        // If tag found and not negated, run the it
        it(testDescription, test);
        return;
      }
      // If tag found and negated, don't run the it
      return;
    }
  }
  // If no positive tags, run the it
  if (!any) it(testDescription, test);
}

const CompoundV3StrategyMethods = {
  harvestRewards: 0,
  setSwapConfig: 1,
};

const variants = [
  {
    name: "CompoundV3ERC4626",
    tagit: tagit,
    fixture: async () => {
      const { currency, swapLibrary, adminAddr, swapConfig, admin, lp, lp2, guardian, anon } = await setUp();
      const CompoundV3ERC4626 = await ethers.getContractFactory("CompoundV3ERC4626", {
        libraries: {
          SwapLibrary: await ethers.resolveAddress(swapLibrary),
        },
      });
      const vault = await hre.upgrades.deployProxy(CompoundV3ERC4626, [NAME, SYMB, adminAddr, swapConfig], {
        kind: "uups",
        constructorArgs: [ADDRESSES.cUSDCv3, ADDRESSES.REWARDS],
        unsafeAllow: ["external-library-linking"],
      });
      await currency.connect(lp).approve(vault, MaxUint256);
      await currency.connect(lp2).approve(vault, MaxUint256);
      await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp);
      await vault.connect(admin).grantRole(getRole("LP_ROLE"), lp2);

      return {
        currency,
        CompoundV3ERC4626,
        swapConfig,
        vault,
        adminAddr,
        lp,
        lp2,
        anon,
        guardian,
        admin,
      };
    },
    harvestRewards: async (vault, amount) => vault.harvestRewards(amount),
    accessControlCheck: async (action, user, role) =>
      expect(action).to.be.revertedWith(accessControlMessage(user, null, role)),
    getSwapConfig: async (vault) => vault.getSwapConfig(),
    setSwapConfig: async (vault, swapConfig) => vault.setSwapConfig(swapConfig),
  },
  {
    name: "CompoundV3Strategy",
    tagit: tagit,
    fixture: async () => {
      const { currency, swapLibrary, adminAddr, swapConfig, admin, lp, lp2, guardian, anon } = await setUp();
      const CompoundV3InvestStrategy = await ethers.getContractFactory("CompoundV3InvestStrategy", {
        libraries: {
          SwapLibrary: await ethers.resolveAddress(swapLibrary),
        },
      });
      const strategy = await CompoundV3InvestStrategy.deploy(ADDRESSES.cUSDCv3, ADDRESSES.REWARDS);
      const SingleStrategyERC4626 = await ethers.getContractFactory("SingleStrategyERC4626");
      const vault = await hre.upgrades.deployProxy(
        SingleStrategyERC4626,
        [NAME, SYMB, adminAddr, ADDRESSES.USDC, await ethers.resolveAddress(strategy), encodeSwapConfig(swapConfig)],
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
        CompoundV3InvestStrategy,
        swapConfig,
        vault,
        strategy,
        adminAddr,
        lp,
        lp2,
        anon,
        guardian,
        admin,
      };
    },
    harvestRewards: async (vault, amount) =>
      vault.forwardToStrategy(
        CompoundV3StrategyMethods.harvestRewards,
        ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [amount])
      ),
    accessControlCheck: async (action, user, role, contract) =>
      expect(action)
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(user, getRole(role)),
    getSwapConfig: async (vault, strategy) => strategy.getSwapConfig(vault),
    setSwapConfig: async (vault, swapConfig) =>
      vault.forwardToStrategy(CompoundV3StrategyMethods.setSwapConfig, encodeSwapConfig(swapConfig)),
  },
];

variants.forEach((variant) => {
  describe(`${variant.name} contract tests`, function () {
    before(async () => {
      await setupChain(TEST_BLOCK);
    });

    variant.tagit("Checks vault inititializes correctly", async () => {
      const { currency, vault, admin, anon } = await helpers.loadFixture(variant.fixture);

      expect(await vault.name()).to.equal(NAME);
      expect(await vault.symbol()).to.equal(SYMB);
      expect(await vault.asset()).to.equal(currency);
      expect(await vault.totalAssets()).to.equal(0);
      expect(await vault.hasRole(getRole("DEFAULT_ADMIN_ROLE"), admin)).to.equal(true);
      expect(await vault.hasRole(getRole("DEFAULT_ADMIN_ROLE"), anon)).to.equal(false);
    });

    variant.tagit("Checks vault constructs with disabled initializer [CompoundV3ERC4626]", async () => {
      const { CompoundV3ERC4626, adminAddr, swapConfig } = await helpers.loadFixture(variant.fixture);
      const newVault = await CompoundV3ERC4626.deploy(ADDRESSES.cUSDCv3, ADDRESSES.REWARDS);
      await expect(newVault.deploymentTransaction()).to.emit(newVault, "Initialized");
      await expect(newVault.initialize("foo", "bar", adminAddr, swapConfig)).to.be.revertedWith(
        "Initializable: contract is already initialized"
      );
    });

    variant.tagit("Checks vault constructs with disabled initializer [CompoundV3Strategy]", async () => {
      const { SingleStrategyERC4626, adminAddr, swapConfig, strategy } = await helpers.loadFixture(variant.fixture);
      const newVault = await SingleStrategyERC4626.deploy();
      await expect(newVault.deploymentTransaction()).to.emit(newVault, "Initialized");
      await expect(
        newVault.initialize(
          "foo",
          "bar",
          adminAddr,
          ADDRESSES.USDC,
          await ethers.resolveAddress(strategy),
          encodeSwapConfig(swapConfig)
        )
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    variant.tagit("Checks reverts if extraData is sent on initialization [CompoundV3Strategy]", async () => {
      const { SingleStrategyERC4626, adminAddr, swapConfig, strategy, CompoundV3InvestStrategy } =
        await helpers.loadFixture(variant.fixture);
      await expect(
        hre.upgrades.deployProxy(
          SingleStrategyERC4626,
          [
            NAME,
            SYMB,
            adminAddr,
            ADDRESSES.USDC,
            await ethers.resolveAddress(strategy),
            encodeSwapConfig(swapConfig) + "f".repeat(64),
          ],
          {
            kind: "uups",
            unsafeAllow: ["delegatecall"],
          }
        )
      ).to.be.revertedWithCustomError(CompoundV3InvestStrategy, "NoExtraDataAllowed");
    });

    variant.tagit("Checks entering the vault is permissioned, exit isn't", async () => {
      const { currency, vault, anon, lp } = await helpers.loadFixture(variant.fixture);

      await expect(vault.connect(anon).deposit(_A(100), anon)).to.be.revertedWith("ERC4626: deposit more than max");

      await expect(vault.connect(anon).mint(_A(100), anon)).to.be.revertedWith("ERC4626: mint more than max");

      await expect(vault.connect(lp).deposit(_A(100), lp))
        .to.emit(vault, "Deposit")
        .withArgs(lp, lp, _A(100), _A(100))
        .to.emit(currency, "Transfer")
        .withArgs(lp, vault, _A(100))
        .to.emit(currency, "Transfer")
        .withArgs(vault, ADDRESSES.cUSDCv3, _A(100));

      // Nothing stays in the vault
      expect(await currency.balanceOf(vault)).to.equal(0);

      await expect(vault.connect(anon).withdraw(_A(100), anon, anon)).to.be.revertedWith(
        "ERC4626: withdraw more than max"
      );

      await vault.connect(lp).transfer(anon, _A(50));

      await expect(vault.connect(anon).withdraw(_A(50), anon, anon))
        .to.emit(vault, "Withdraw")
        .withArgs(anon, anon, anon, _A(50), anyUint)
        .to.emit(currency, "Transfer")
        .withArgs(ADDRESSES.cUSDCv3, vault, _A(50))
        .to.emit(currency, "Transfer")
        .withArgs(vault, anon, _A(50));
    });

    it("Checks vault accrues compound earnings", async () => {
      const { currency, vault, lp, lp2 } = await helpers.loadFixture(variant.fixture);

      await expect(vault.connect(lp).mint(_A(1000), lp))
        .to.emit(vault, "Deposit")
        .withArgs(lp, lp, _A(1000), _A(1000))
        .to.emit(currency, "Transfer")
        .withArgs(lp, vault, _A(1000))
        .to.emit(currency, "Transfer")
        .withArgs(vault, ADDRESSES.cUSDCv3, _A(1000));

      expect(await vault.totalAssets()).to.be.closeTo(_A(1000), MCENT);

      await helpers.time.increase(MONTH);
      expect(await vault.totalAssets()).to.be.closeTo(_A("1009.522026"), MCENT);

      expect(await vault.balanceOf(lp)).to.be.equal(_A("1000"));
      expect(await vault.totalSupply()).to.be.equal(_A("1000"));
      expect(await vault.convertToAssets(_A(100))).to.be.closeTo(_A("100.9522"), MCENT);

      // Another LP deposits 2000 and gets less shares
      await expect(vault.connect(lp2).deposit(_A(2000), lp2))
        .to.emit(vault, "Deposit")
        .withArgs(lp2, lp2, _A(2000), anyUint)
        .to.emit(currency, "Transfer")
        .withArgs(lp2, vault, _A(2000))
        .to.emit(currency, "Transfer")
        .withArgs(vault, ADDRESSES.cUSDCv3, _A(2000));

      const lp2balance = await vault.balanceOf(lp2);
      expect(lp2balance).to.be.closeTo(_A("1981.13"), CENT);

      // Withdraws all the funds
      await vault.connect(lp).redeem(_A("1000"), lp, lp);
      await vault.connect(lp2).redeem(lp2balance, lp2, lp2);

      expect(await vault.totalAssets()).to.be.equal(0);

      expect(await currency.balanceOf(lp)).to.closeTo(_A("10009.522"), CENT);
      expect(await currency.balanceOf(lp2)).to.closeTo(_A(INITIAL), CENT);
    });

    it("Checks rewards can be harvested", async () => {
      const { currency, vault, admin, anon, lp, lp2, strategy } = await helpers.loadFixture(variant.fixture);

      await expect(vault.connect(lp).mint(_A(1000), lp)).not.to.be.reverted;
      await expect(vault.connect(lp2).mint(_A(2000), lp2)).not.to.be.reverted;

      expect(await vault.totalAssets()).to.be.closeTo(_A(3000), MCENT);

      await variant.accessControlCheck(
        variant.harvestRewards(vault.connect(anon), _A(100)),
        anon,
        "HARVEST_ROLE",
        strategy
      );

      await vault.connect(admin).grantRole(getRole("HARVEST_ROLE"), anon);

      await expect(variant.harvestRewards(vault.connect(anon), _A(100))).to.be.revertedWith("AS");

      await helpers.time.increase(MONTH);
      const assets = await vault.totalAssets();
      expect(assets).to.be.closeTo(_A("3028.53"), CENT);

      // Dex Rate 0.011833165 - MaxSlippage initially ~0%
      await expect(variant.harvestRewards(vault.connect(anon), _W("0.011"))).to.be.revertedWith("Too little received");

      const tx = await variant.harvestRewards(vault.connect(anon), _W("0.011833165"));
      await expect(tx).not.to.be.reverted;

      const receipt = await tx.wait();
      const evt = getTransactionEvent((strategy || vault).interface, receipt, "RewardsClaimed");

      expect(evt).not.equal(null);

      expect(evt.args.token).to.equal(ADDRESSES.COMP);
      expect(evt.args.rewards).to.equal(_W("0.126432"));
      expect(evt.args.receivedInAsset).to.equal(_A("10.684546"));

      await expect(tx).to.emit(currency, "Transfer").withArgs(vault, ADDRESSES.cUSDCv3, _A("10.684546"));

      expect(await vault.totalAssets()).to.be.closeTo(assets + _A("10.684546"), CENT);

      // No new shares minted, so rewards are accrued for current LPs
      expect(await vault.totalSupply()).to.be.equal(_A(3000));
    });

    it("Checks only authorized user can change swap config", async () => {
      const { currency, vault, admin, anon, lp, swapConfig, strategy } = await helpers.loadFixture(variant.fixture);

      expect(await variant.getSwapConfig(vault, strategy)).to.deep.equal(swapConfig);
      await expect(vault.connect(lp).mint(_A(3000), lp)).not.to.be.reverted;

      await vault.connect(admin).grantRole(getRole("HARVEST_ROLE"), anon);

      await helpers.time.increase(MONTH);
      const assets = await vault.totalAssets();
      expect(assets).to.be.closeTo(_A("3028.53"), CENT);

      // Dex Rate 0.011833165 - MaxSlippage initially ~0%
      await expect(variant.harvestRewards(vault.connect(anon), _W("0.0118"))).to.be.revertedWith("Too little received");

      await variant.accessControlCheck(
        variant.setSwapConfig(vault.connect(anon), swapConfig),
        anon,
        "SWAP_ADMIN_ROLE",
        strategy
      );

      await vault.connect(admin).grantRole(getRole("SWAP_ADMIN_ROLE"), anon);

      // Check validates new config
      await expect(
        variant.setSwapConfig(vault.connect(anon), buildUniswapConfig(0, FEETIER, ADDRESSES.UNISWAP))
      ).to.be.revertedWith("SwapLibrary: maxSlippage cannot be zero");

      const newSwapConfig = buildUniswapConfig(_W("0.05"), FEETIER, ADDRESSES.UNISWAP);

      let tx = await variant.setSwapConfig(vault.connect(anon), newSwapConfig);
      let receipt = await tx.wait();
      let evt = getTransactionEvent((strategy || vault).interface, receipt, "SwapConfigChanged");

      expect(evt).not.equal(null);

      expect(evt.args.oldConfig).to.deep.equal(swapConfig);
      expect(evt.args.newConfig).to.deep.equal(newSwapConfig);

      expect(await variant.getSwapConfig(vault, strategy)).to.deep.equal(newSwapConfig);

      tx = await variant.harvestRewards(vault.connect(anon), _W("0.0118"));
      receipt = await tx.wait();
      evt = getTransactionEvent((strategy || vault).interface, receipt, "RewardsClaimed");

      expect(evt).not.equal(null);

      expect(evt.args.token).to.equal(ADDRESSES.COMP);
      expect(evt.args.rewards).to.equal(_W("0.126432"));
      expect(evt.args.receivedInAsset).to.equal(_A("10.684546"));

      await expect(tx).to.emit(currency, "Transfer").withArgs(vault, ADDRESSES.cUSDCv3, _A("10.684546"));

      expect(await vault.totalAssets()).to.be.closeTo(assets + _A("10.684546"), CENT);
    });

    it("Checks can't deposit or withdraw when Compound is paused", async () => {
      const { vault, lp, currency } = await helpers.loadFixture(variant.fixture);

      await helpers.impersonateAccount(ADDRESSES.cUSDCv3_GUARDIAN);
      await helpers.setBalance(ADDRESSES.cUSDCv3_GUARDIAN, ethers.parseEther("100"));
      const compGuardian = await ethers.getSigner(ADDRESSES.cUSDCv3_GUARDIAN);

      const cUSDCv3 = await ethers.getContractAt(CometABI, ADDRESSES.cUSDCv3);

      expect(await vault.maxMint(lp)).to.equal(MaxUint256);
      expect(await vault.maxDeposit(lp)).to.equal(MaxUint256);

      // If I pause supply, maxMint / maxDeposit becomes 0 and can't deposit or mint
      await cUSDCv3.connect(compGuardian).pause(true, false, false, false, false);

      expect(await vault.maxMint(lp)).to.equal(0);
      expect(await vault.maxDeposit(lp)).to.equal(0);
      await expect(vault.connect(lp).mint(_A(3000), lp)).to.be.revertedWith("ERC4626: mint more than max");
      await expect(vault.connect(lp).deposit(_A(3000), lp)).to.be.revertedWith("ERC4626: deposit more than max");

      // Then I unpause deposit
      await cUSDCv3.connect(compGuardian).pause(false, false, false, false, false);

      await expect(vault.connect(lp).mint(_A(3000), lp)).not.to.be.reverted;

      expect(await vault.totalAssets()).to.closeTo(_A(3000), MCENT);
      expect(await vault.maxRedeem(lp)).to.closeTo(_A(3000), MCENT);
      expect(await vault.maxWithdraw(lp)).to.closeTo(_A(3000), MCENT);

      // If I pause withdraw, maxRedeem / maxWithdraw becomes 0 and can't withdraw or redeem
      await cUSDCv3.connect(compGuardian).pause(false, false, true, false, false);

      expect(await vault.maxRedeem(lp)).to.equal(0);
      expect(await vault.maxWithdraw(lp)).to.equal(0);

      await expect(vault.connect(lp).redeem(_A(1000), lp, lp)).to.be.revertedWith("ERC4626: redeem more than max");
      await expect(vault.connect(lp).withdraw(_A(1000), lp, lp)).to.be.revertedWith("ERC4626: withdraw more than max");

      // Then I unpause everythin
      await cUSDCv3.connect(compGuardian).pause(false, false, false, false, false);

      await expect(vault.connect(lp).redeem(_A(3000), lp, lp)).not.to.be.reverted;
      expect(await vault.totalAssets()).to.closeTo(0, MCENT);
      // Check LP has more or less the same initial funds
      expect(await currency.balanceOf(lp)).to.closeTo(_A(INITIAL), MCENT * 10n);
    });

    variant.tagit("Checks only authorized can setStrategy [CompoundV3Strategy]", async () => {
      const { currency, vault, lp, swapConfig, strategy, anon, admin, CompoundV3InvestStrategy } =
        await helpers.loadFixture(variant.fixture);

      expect(await vault.strategy()).to.equal(strategy);
      await expect(vault.connect(lp).mint(_A(3000), lp)).not.to.be.reverted;

      expect(await vault.totalAssets()).to.closeTo(_A(3000), MCENT);
      expect(await vault.maxRedeem(lp)).to.closeTo(_A(3000), MCENT);
      expect(await vault.maxWithdraw(lp)).to.closeTo(_A(3000), MCENT);

      await expect(
        vault.connect(anon).setStrategy(ZeroAddress, encodeSwapConfig(swapConfig), false)
      ).to.be.revertedWith(accessControlMessage(anon, null, "SET_STRATEGY_ROLE"));
      await vault.connect(admin).grantRole(getRole("SET_STRATEGY_ROLE"), anon);

      await expect(vault.connect(anon).setStrategy(ZeroAddress, encodeSwapConfig(swapConfig), false)).to.be.reverted;

      // If I pause withdraw, it can't withdraw and setStrategy fails
      await helpers.impersonateAccount(ADDRESSES.cUSDCv3_GUARDIAN);
      await helpers.setBalance(ADDRESSES.cUSDCv3_GUARDIAN, ethers.parseEther("100"));
      const compGuardian = await ethers.getSigner(ADDRESSES.cUSDCv3_GUARDIAN);

      const cUSDCv3 = await ethers.getContractAt(CometABI, ADDRESSES.cUSDCv3);
      await cUSDCv3.connect(compGuardian).pause(false, false, true, false, false);

      expect(await vault.maxRedeem(lp)).to.equal(0);
      expect(await vault.maxWithdraw(lp)).to.equal(0);

      await expect(
        vault.connect(anon).setStrategy(strategy, encodeSwapConfig(swapConfig), false)
      ).to.be.revertedWithCustomError(cUSDCv3, "Paused");

      const DummyInvestStrategy = await ethers.getContractFactory("DummyInvestStrategy");
      const otherStrategy = await CompoundV3InvestStrategy.deploy(ADDRESSES.cUSDCv3, ADDRESSES.REWARDS);
      const dummyStrategy = await DummyInvestStrategy.deploy(ADDRESSES.USDC);

      // But if I force, it works
      await expect(vault.connect(anon).setStrategy(otherStrategy, encodeSwapConfig(swapConfig), true))
        .to.emit(vault, "StrategyChanged")
        .withArgs(strategy, otherStrategy)
        .to.emit(vault, "WithdrawFailed")
        .withArgs("0x9e87fac8"); // First chars keccak256("Paused()")

      expect(await vault.totalAssets()).to.closeTo(_A(3000), CENT);

      // Setting a dummyStrategy returns totalAssets == 0 because can't see the assets in Compound
      let tx = await vault.connect(anon).setStrategy(dummyStrategy, encodeDummyStorage({}), true);
      await expect(tx)
        .to.emit(vault, "StrategyChanged")
        .withArgs(otherStrategy, dummyStrategy)
        .to.emit(vault, "WithdrawFailed")
        .withArgs("0x9e87fac8"); // First chars keccak256("Paused()")
      let receipt = await tx.wait();
      let evt = getTransactionEvent(dummyStrategy.interface, receipt, "Deposit");
      expect(evt).not.equal(null);
      expect(evt.args.assets).to.be.equal(0);

      expect(await vault.totalAssets()).to.equal(0);
      expect(await dummyStrategy.getFail(vault)).to.deep.equal([false, false, false, false]);

      // Setting again `strategy` works fine
      await expect(vault.connect(anon).setStrategy(strategy, encodeSwapConfig(swapConfig), false))
        .to.emit(vault, "StrategyChanged")
        .withArgs(dummyStrategy, strategy);
      expect(await vault.totalAssets()).to.closeTo(_A(3000), CENT);
      expect(await cUSDCv3.balanceOf(vault)).to.closeTo(_A(3000), CENT);

      // Now I unpause Compound
      await cUSDCv3.connect(compGuardian).pause(false, false, false, false, false);

      // Setting a dummyStrategy sends the assets to the vault
      tx = await vault.connect(anon).setStrategy(dummyStrategy, encodeDummyStorage({}), false);
      await expect(tx)
        .to.emit(vault, "StrategyChanged")
        .withArgs(strategy, dummyStrategy)
        .not.to.emit(vault, "WithdrawFailed");
      receipt = await tx.wait();
      evt = getTransactionEvent(dummyStrategy.interface, receipt, "Deposit");
      expect(evt).not.equal(null);
      expect(evt.args.assets).to.be.closeTo(_A(3000), CENT);

      expect(await vault.totalAssets()).to.closeTo(_A(3000), CENT);
      expect(await cUSDCv3.balanceOf(vault)).to.equal(0);
      expect(await currency.balanceOf(vault)).to.closeTo(_A(3000), CENT);
    });
  });
});
