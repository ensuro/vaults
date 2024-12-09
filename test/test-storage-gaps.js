require("mocha");
const { expect } = require("chai");
const hre = require("hardhat");

const { getStorageLayout } = require("@ensuro/utils/js/utils");

describe("Storage Gaps", () => {
  const contracts = ["CompoundV3ERC4626", "SingleStrategyERC4626", "MultiStrategyERC4626"];

  for (const contract of contracts) {
    it(`${contract} has a proper storage gap`, async () => {
      const { storage, types } = await getStorageLayout(
        hre,
        `contracts/${contract}.sol`,
        contract.split("/").slice(-1)[0]
      );

      const gap = storage[storage.length - 1];

      // Check the storage ends with a gap
      expect(gap.label).to.equal("__gap");

      // Check the storage aligns to 50 slots (+1 because of https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/issues/182) // Solved?
      const finalSlot = parseInt(gap.slot) + Math.floor(parseInt(types[gap.type].numberOfBytes) / 32);
      expect(finalSlot % 50).to.equal(0);
    });
  }
});
