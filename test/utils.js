const ethers = require("ethers");
const { attachAsAMP } = require("@ensuro/access-managed-proxy/js/deployProxy");

function encodeSwapConfig(swapConfig) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["tuple(uint8, uint256, bytes)"], [swapConfig]);
}

function encodeDummyStorage({ failConnect, failDisconnect, failDeposit, failWithdraw }) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(bool, bool, bool, bool)"],
    [[failConnect || false, failDisconnect || false, failDeposit || false, failWithdraw || false]]
  );
}

function dummyStorage({ failConnect, failDisconnect, failDeposit, failWithdraw }) {
  return [failConnect || false, failDisconnect || false, failDeposit || false, failWithdraw || false];
}

async function makeAllPublic(contract, accessManager) {
  const skipSelectors = await (await attachAsAMP(contract)).PASS_THRU_METHODS();
  const selectors = contract.interface.fragments
    .filter((fragment) => fragment.type === "function" && skipSelectors.indexOf(fragment.selector) < 0)
    .map((fragment) => fragment.selector);
  const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();
  await accessManager.setTargetFunctionRole(contract, selectors, PUBLIC_ROLE);
}

module.exports = {
  encodeDummyStorage,
  encodeSwapConfig,
  dummyStorage,
  makeAllPublic,
};
