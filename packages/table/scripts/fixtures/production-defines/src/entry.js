/*! Diagnostic spelling in a comment: __BRUNO_TABLE_DEVELOPMENT__ */
const prefix__BRUNO_TABLE_DEVELOPMENT__suffix = "larger identifier";
const properties = { __BRUNO_TABLE_DEVELOPMENT__: "property name" };
function shadow(__BRUNO_TABLE_DEVELOPMENT__) {
  return __BRUNO_TABLE_DEVELOPMENT__;
}

export const evidence = {
  development: __BRUNO_TABLE_DEVELOPMENT__,
  testDiagnostics: __BRUNO_TABLE_TEST_DIAGNOSTICS__,
  literal: "__BRUNO_TABLE_DEVELOPMENT__ __BRUNO_TABLE_TEST_DIAGNOSTICS__",
  larger: prefix__BRUNO_TABLE_DEVELOPMENT__suffix,
  property: properties.__BRUNO_TABLE_DEVELOPMENT__,
  shadow: shadow("local binding"),
};
