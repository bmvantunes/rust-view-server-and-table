const developmentExpression = 'globalThis.process?.env?.NODE_ENV === "development"';

export function BrunoTableProductionDefines() {
  return {
    name: "bruno-table-production-defines",
    options(options) {
      return {
        ...options,
        transform: {
          ...options.transform,
          define: {
            ...options.transform?.define,
            __BRUNO_TABLE_TEST_DIAGNOSTICS__: "false",
            __BRUNO_TABLE_DEVELOPMENT__: developmentExpression,
          },
        },
      };
    },
  };
}
