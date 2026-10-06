import config from "../../vite.config";

export default {
  ...config,
  test: {
    ...config.test,
    benchmark: {
      ...config.test?.benchmark,
      include: ["scripts/fixtures/runner-contract.bench.ts"],
    },
  },
};
