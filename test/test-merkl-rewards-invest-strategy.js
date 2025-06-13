const fs = require("fs");
const { expect } = require("chai");
const { amountFunction, _W, getAccessManagerRole, getAddress, mergeFragments } = require("@ensuro/utils/js/utils");
const { WEEK } = require("@ensuro/utils/js/constants");
const { buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const { encodeSwapConfig } = require("./utils");
const { initForkCurrency, amScheduleAndExecuteBatch, setupChain } = require("@ensuro/utils/js/test-utils");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256, ZeroAddress } = hre.ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);

const ADDRESSES = {
  // polygon mainnet addresses
  UNISWAP: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  MERKL_DISTRIBUTOR: "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae",
  QUICKSWAP: "0xf5b509bB0909a69B1c207E495f687a596C168E12",
  USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  USDCWhale: "0xF977814e90dA44bFA03b6295A0616a897441aceC",
  MSV: "0x14F6DFEE761455247C6bf2b2b052a1F6245dD6FB",
  COMP: "0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c",
  WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  COMP_ORACLE: "0x2A8758b7257102461BC958279054e372C2b1bDE6",
  USDC_ORACLE: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7",
  WPOL_ORACLE: "0x66aCD49dB829005B3681E29b6F4Ba1d93843430e",
  ACCESS_MANAGER: "0xa29DF9825F283B2fA7a26B4627F84aDa80cDD79a",
  ADMINS_MULTISIG: "0xCfcd29CD20B6c64A4C0EB56e29E5ce3CD69336D2",
};

const MerklForwardMethods = {
  setSwapConfig: 0,
  claimRewards: 1,
  claimAndSwapRewards: 2,
  swapRewards: 3,
};

const TEST_BLOCK = 72684500;
const INITIAL = 10000;

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();

  const USDC = await initForkCurrency(ADDRESSES.USDC, ADDRESSES.USDCWhale, [lp, lp2], [_A(INITIAL), _A(INITIAL)]);
  const WPOL = await ethers.getContractAt("IERC20Metadata", ADDRESSES.WPOL);
  const COMP = await ethers.getContractAt("IERC20Metadata", ADDRESSES.COMP);
  const acMgr = await ethers.getContractAt("AccessManager", ADDRESSES.ACCESS_MANAGER);
  const compOracle = await ethers.getContractAt("AggregatorV3Interface", ADDRESSES.COMP_ORACLE);
  const wpolOracle = await ethers.getContractAt("AggregatorV3Interface", ADDRESSES.WPOL_ORACLE);
  const usdcOracle = await ethers.getContractAt("AggregatorV3Interface", ADDRESSES.USDC_ORACLE);

  // Impersonate ADMINS_MULTISIG
  await helpers.impersonateAccount(ADDRESSES.ADMINS_MULTISIG);
  await helpers.setBalance(ADDRESSES.ADMINS_MULTISIG, ethers.parseEther("100"));
  const adminsMultisig = await ethers.getSigner(ADDRESSES.ADMINS_MULTISIG);

  const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
  const swapLibrary = await SwapLibrary.deploy();
  const MerklRewardsInvestStrategy = await ethers.getContractFactory("MerklRewardsInvestStrategy", {
    libraries: {
      SwapLibrary: await ethers.resolveAddress(swapLibrary),
    },
  });
  const AccessManagedMSV = await ethers.getContractFactory("AccessManagedMSV");
  const msv = await ethers.getContractAt(
    mergeFragments(AccessManagedMSV.interface.fragments, MerklRewardsInvestStrategy.interface.fragments),
    ADDRESSES.MSV
  );

  return {
    USDC,
    COMP,
    WPOL,
    usdcOracle,
    compOracle,
    wpolOracle,
    msv,
    acMgr,
    adminsMultisig,
    MerklRewardsInvestStrategy,
    swapLibrary,
    lp,
    lp2,
    anon,
    guardian,
    admin,
  };
}

async function fetchRewards(userAddress) {
  if (TEST_BLOCK === null) {
    const resp = await fetch(`https://api.merkl.xyz/v4/users/${userAddress}/rewards?chainId=137&breakdownPage=0`);
    expect(resp.status).to.equal(200);
    const rewardData = await resp.json();
    fs.writeFileSync("./test/merkl-api-resp-2.json", JSON.stringify(rewardData));
    return rewardData;
  } else {
    return JSON.parse(fs.readFileSync("./test/merkl-api-resp.json"));
  }
}

describe("MerklRewardsInvestStrategy contract tests", function () {
  before(async () => {
    await setupChain(TEST_BLOCK);
  });

  it("Can claim COMP and WPOL rewards and they are added to MSV totalAssets", async () => {
    const {
      USDC,
      COMP,
      WPOL,
      usdcOracle,
      compOracle,
      wpolOracle,
      msv,
      MerklRewardsInvestStrategy,
      acMgr,
      adminsMultisig,
    } = await helpers.loadFixture(setUp);
    const wpolStrategy = await MerklRewardsInvestStrategy.deploy(
      USDC,
      WPOL,
      usdcOracle,
      wpolOracle,
      WEEK,
      ADDRESSES.MERKL_DISTRIBUTOR
    );
    const compStrategy = await MerklRewardsInvestStrategy.deploy(
      USDC,
      COMP,
      usdcOracle,
      compOracle,
      WEEK,
      ADDRESSES.MERKL_DISTRIBUTOR
    );
    const slippage = 0.05;

    // Add the new strategies
    await amScheduleAndExecuteBatch(
      acMgr.connect(adminsMultisig),
      [msv, msv],
      [
        msv.interface.encodeFunctionData("addStrategy", [
          getAddress(wpolStrategy),
          encodeSwapConfig(buildUniswapConfig(_W(slippage), 500, ADDRESSES.UNISWAP)),
        ]),
        msv.interface.encodeFunctionData("addStrategy", [
          getAddress(compStrategy),
          encodeSwapConfig(buildUniswapConfig(_W(slippage), 100, ADDRESSES.UNISWAP)),
        ]),
      ]
    );
    expect(await wpolStrategy.totalAssets(msv)).to.equal(_A(0));
    expect(await compStrategy.totalAssets(msv)).to.equal(_A(0));

    // Grant permissions to call claimRewards and swapRewards forward method on both strategies
    await amScheduleAndExecuteBatch(
      acMgr.connect(adminsMultisig),
      [acMgr, acMgr],
      [
        acMgr.interface.encodeFunctionData("setTargetFunctionRole", [
          getAddress(msv),
          [
            await msv.getForwardToStrategySelector(2, MerklForwardMethods.claimRewards),
            await msv.getForwardToStrategySelector(3, MerklForwardMethods.claimRewards),
            await msv.getForwardToStrategySelector(2, MerklForwardMethods.swapRewards),
            await msv.getForwardToStrategySelector(3, MerklForwardMethods.swapRewards),
            await msv.getForwardToStrategySelector(3, MerklForwardMethods.setSwapConfig),
          ],
          getAccessManagerRole("CLAIM_ROLE"),
        ]),
        acMgr.interface.encodeFunctionData("grantRole", [
          getAccessManagerRole("CLAIM_ROLE"),
          ADDRESSES.ADMINS_MULTISIG,
          0,
        ]),
      ]
    );

    const totalAssetsBefore = await msv.totalAssets();
    const encoder = ethers.AbiCoder.defaultAbiCoder();

    // Claim Rewards
    const rewardData = await fetchRewards(ADDRESSES.MSV);

    const wpolReward = rewardData[0].rewards.find((r) => r.token.address === ADDRESSES.WPOL);
    const wpolClaimParams = encoder.encode(["uint256", "bytes32[]"], [BigInt(wpolReward.amount), wpolReward.proofs]);
    await expect(() =>
      msv.connect(adminsMultisig).forwardToStrategy(2, MerklForwardMethods.claimRewards, wpolClaimParams)
    ).to.changeTokenBalances(WPOL, [msv], [BigInt(wpolReward.amount)]);

    const expectedAmountWpol =
      (wpolReward.token.price * (1 - slippage) * Number(BigInt(wpolReward.amount) / BigInt(1e12))) / 1e6;

    expect(await wpolStrategy.totalAssets(msv)).to.closeTo(_A(expectedAmountWpol), _A(expectedAmountWpol * slippage));

    const compReward = rewardData[0].rewards.find((r) => r.token.address === ADDRESSES.COMP);
    const compClaimParams = encoder.encode(["uint256", "bytes32[]"], [BigInt(compReward.amount), compReward.proofs]);
    await expect(() =>
      msv.connect(adminsMultisig).forwardToStrategy(3, MerklForwardMethods.claimRewards, compClaimParams)
    ).to.changeTokenBalances(COMP, [msv], [BigInt(compReward.amount)]);

    let expectedAmountComp =
      (compReward.token.price * (1 - slippage) * Number(BigInt(compReward.amount) / BigInt(1e12))) / 1e6;

    expect(await compStrategy.totalAssets(msv)).to.closeTo(_A(expectedAmountComp), _A(expectedAmountComp * slippage));

    const totalAssetsAfter = await msv.totalAssets();
    expect(totalAssetsAfter).to.be.closeTo(totalAssetsBefore + _A(expectedAmountComp) + _A(expectedAmountWpol), _A(10));

    // Checks totalAssets matchs the expected value for each strategy. The tolerance is because the expected amounts
    // are computed based on Merkl prices, not the oracle prices
    expect(await wpolStrategy.totalAssets(msv)).to.closeTo(_A(expectedAmountWpol), _A(0.02 * expectedAmountWpol));
    expect(await compStrategy.totalAssets(msv)).to.closeTo(_A(expectedAmountComp), _A(0.02 * expectedAmountComp));

    // Claim Rewards - First partially, then full
    await expect(() =>
      msv
        .connect(adminsMultisig)
        .forwardToStrategy(2, MerklForwardMethods.swapRewards, encoder.encode(["uint256"], [_W(100)]))
    ).to.changeTokenBalances(WPOL, [msv], [-_W(100)]);
    expect(await wpolStrategy.totalAssets(msv)).to.closeTo(
      _A(expectedAmountWpol) - _A(wpolReward.token.price * 100),
      _A(0.02 * expectedAmountWpol)
    );
    await expect(() =>
      msv
        .connect(adminsMultisig)
        .forwardToStrategy(2, MerklForwardMethods.swapRewards, encoder.encode(["uint256"], [MaxUint256]))
    ).to.changeTokenBalances(WPOL, [msv], [-BigInt(wpolReward.amount) + _W(100)]);
    expect(await wpolStrategy.totalAssets(msv)).to.equal(0);

    // Change the swapConfig for COMP increasing the slippage and verify the totalAssets changes
    await expect(
      msv
        .connect(adminsMultisig)
        .forwardToStrategy(
          3,
          MerklForwardMethods.setSwapConfig,
          encodeSwapConfig(buildUniswapConfig(_W(slippage * 5), 123, ADDRESSES.QUICKSWAP))
        )
    ).to.emit(msv, "SwapConfigChanged");
    // Recompute expectedAmountComp with 5 times more slippage
    expectedAmountComp =
      (compReward.token.price * (1 - slippage * 5) * Number(BigInt(compReward.amount) / BigInt(1e12))) / 1e6;
    expect(await compStrategy.totalAssets(msv)).to.closeTo(_A(expectedAmountComp), _A(0.02 * expectedAmountComp));
  });

  it("Can claim and swap WPOL rewards in the same operation", async () => {
    const { USDC, WPOL, usdcOracle, wpolOracle, msv, MerklRewardsInvestStrategy, acMgr, adminsMultisig } =
      await helpers.loadFixture(setUp);
    const wpolStrategy = await MerklRewardsInvestStrategy.deploy(
      USDC,
      WPOL,
      usdcOracle,
      wpolOracle,
      WEEK,
      ADDRESSES.MERKL_DISTRIBUTOR
    );
    const slippage = 0.01;

    // Add the new strategies
    await amScheduleAndExecuteBatch(
      acMgr.connect(adminsMultisig),
      [msv],
      [
        msv.interface.encodeFunctionData("addStrategy", [
          getAddress(wpolStrategy),
          encodeSwapConfig(buildUniswapConfig(_W(slippage), 500, ADDRESSES.UNISWAP)),
        ]),
      ]
    );
    expect(await wpolStrategy.totalAssets(msv)).to.equal(_A(0));

    // Grant permissions to call claimRewards and swapRewards forward method on both strategies
    await amScheduleAndExecuteBatch(
      acMgr.connect(adminsMultisig),
      [acMgr, acMgr],
      [
        acMgr.interface.encodeFunctionData("setTargetFunctionRole", [
          getAddress(msv),
          [await msv.getForwardToStrategySelector(2, MerklForwardMethods.claimAndSwapRewards)],
          getAccessManagerRole("CLAIM_ROLE"),
        ]),
        acMgr.interface.encodeFunctionData("grantRole", [
          getAccessManagerRole("CLAIM_ROLE"),
          ADDRESSES.ADMINS_MULTISIG,
          0,
        ]),
      ]
    );

    const totalAssetsBefore = await msv.totalAssets();
    const encoder = ethers.AbiCoder.defaultAbiCoder();

    // Claim Rewards
    const rewardData = await fetchRewards(ADDRESSES.MSV);

    const wpolReward = rewardData[0].rewards.find((r) => r.token.address === ADDRESSES.WPOL);
    const wpolClaimParams = encoder.encode(["uint256", "bytes32[]"], [BigInt(wpolReward.amount), wpolReward.proofs]);
    await expect(() =>
      msv.connect(adminsMultisig).forwardToStrategy(2, MerklForwardMethods.claimAndSwapRewards, wpolClaimParams)
    ).to.changeTokenBalances(WPOL, [msv], [0]);

    const expectedAmountWpol =
      (wpolReward.token.price * (1 - slippage) * Number(BigInt(wpolReward.amount) / BigInt(1e12))) / 1e6;

    expect(await wpolStrategy.totalAssets(msv)).to.equal(0);

    const totalAssetsAfter = await msv.totalAssets();
    expect(totalAssetsAfter).to.be.closeTo(totalAssetsBefore + _A(expectedAmountWpol), _A(5));

    // Final coverage tests
    expect(await wpolStrategy.maxDeposit(adminsMultisig)).to.equal(0); // This way acquiring WPOL is disabled
    await expect(
      wpolStrategy.forwardEntryPoint(MerklForwardMethods.claimAndSwapRewards, wpolClaimParams)
    ).to.be.revertedWithCustomError(wpolStrategy, "CanBeCalledOnlyThroughDelegateCall");
  });
});
