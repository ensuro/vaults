const { ProviderWrapper } = require("hardhat/plugins");
const { ProviderError } = require("hardhat/internal/core/providers/errors");

const MAX_RETRIES = 3;
const BACKOFF_DELAY_MS = 2000;

// eslint-disable-next-line func-style
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ProviderWrapper to retry on Polygon's "header not found" error, which became very frequent around september 2024.
 */
class BackoffRetry extends ProviderWrapper {
  // eslint-disable-next-line consistent-return
  async request(args) {
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        return await this._wrappedProvider.request(args);
      } catch (e) {
        if (!(e instanceof ProviderError) || i >= MAX_RETRIES - 1) throw e;
        if (e.code === -32000 && (e.message.includes("header not found") || e.message.includes("timeout"))) {
          console.error("Retrying %s because of temp error %s: %s (%s)", args.method, e.code, e.message, e.data);
          await delay(BACKOFF_DELAY_MS);
          continue;
        }
        throw e;
      }
    }
  }
}

function installWrapper() {
  // eslint-disable-next-line no-undef
  return extendProvider(async (provider) => new BackoffRetry(provider));
}

module.exports = { BackoffRetry, installWrapper };
