const ethers = require("ethers");
const { Assertion } = require("chai");

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

const tagRegExp = new RegExp("\\[(?<neg>[!])?(?<variant>[a-zA-Z0-9+]+)\\]", "gu");

function tagit(testDescription, test, only = false) {
  let any = false;
  const iit = only || this.only ? it.only : it;
  for (const m of testDescription.matchAll(tagRegExp)) {
    if (m === undefined) break;
    const neg = m.groups.neg !== undefined;
    any = any || !neg;
    if (m.groups.variant === this.name) {
      if (!neg) {
        // If tag found and not negated, run the it
        iit(testDescription, test);
        return;
      }
      // If tag found and negated, don't run the it
      return;
    }
  }
  // If no positive tags, run the it
  if (!any) iit(testDescription, test);
}

async function makeAllViewsPublic(acMgr, contract) {
  const PUBLIC_ROLE = await acMgr.PUBLIC_ROLE();
  for (const fragment of contract.interface.fragments) {
    if (fragment.type !== "function") continue;
    if (fragment.stateMutability !== "pure" && fragment.stateMutability !== "view") continue;
    await acMgr.setTargetFunctionRole(contract, [fragment.selector], PUBLIC_ROLE);
  }
}

function mergeFragments(a, b) {
  const fallback = a.find((f) => f.type === "fallback");
  return a.concat(
    b.filter((fragment) => fragment.type !== "constructor" && (fallback === undefined || fragment.type !== "fallback"))
  );
}

// Install chai matchear for AccessManagedError
Assertion.addMethod("revertedWithAMError", function (contract, user) {
  return new Assertion(this._obj).to.be.revertedWithCustomError(contract, "AccessManagedUnauthorized").withArgs(user);
});

async function setupAMRole(acMgr, vault, roles, role, methods) {
  await acMgr.labelRole(roles[role], role);
  for (const method of methods) {
    await acMgr.setTargetFunctionRole(vault, [vault.interface.getFunction(method).selector], roles[role]);
  }
}

module.exports = {
  encodeDummyStorage,
  encodeSwapConfig,
  dummyStorage,
  tagit,
  makeAllViewsPublic,
  mergeFragments,
  setupAMRole,
};
