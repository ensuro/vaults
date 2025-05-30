require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-dependency-compiler");
require("hardhat-contract-sizer");
const hretry = require("@ensuro/utils/js/hardhat-retry");

hretry.installWrapper();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      initialBaseFeePerGas: 0,
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  dependencyCompiler: {
    paths: [
      "@ensuro/utils/contracts/TestCurrency.sol",
      "@ensuro/utils/contracts/TestERC4626.sol",
      "@ensuro/swaplibrary/contracts/mocks/SwapRouterMock.sol",
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
      "@openzeppelin/contracts/access/manager/AccessManager.sol",
    ],
  },
  mocha: {
    timeout: 180000,
  },
};
