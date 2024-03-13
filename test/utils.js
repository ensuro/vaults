const ethers = require("ethers");

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

module.exports = {
  encodeDummyStorage,
  encodeSwapConfig,
  dummyStorage,
};
