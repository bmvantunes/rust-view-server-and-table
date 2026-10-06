export const reactCompilerOptions = /** @type {const} */ ({
  compilationMode: "infer",
  eslintSuppressionRules: /** @type {string[]} */ ([]),
  panicThreshold: "all_errors",
  target: "19",
});

export const reactCompilerStrictnessFixture = `
  export function StrictnessFixture({
    render = <button type="button">Strict</button>,
  }) {
    return render;
  }
`;

export function assertReactCompilerStrictness(transformSync) {
  const relaxedResult = transformSync(
    "react-compiler-strictness.tsx",
    reactCompilerStrictnessFixture,
    {
      jsx: "preserve",
      reactCompiler: { ...reactCompilerOptions, panicThreshold: "none" },
    },
  );

  if (relaxedResult.fatal || !relaxedResult.errors.some(({ severity }) => severity === "Warning")) {
    throw new Error("The React Compiler strictness fixture is not a recoverable bailout.");
  }

  const strictResult = transformSync(
    "react-compiler-strictness.tsx",
    reactCompilerStrictnessFixture,
    {
      jsx: "preserve",
      reactCompiler: reactCompilerOptions,
    },
  );

  if (!strictResult.fatal) {
    throw new Error("React Compiler recoverable bailouts are not configured as fatal errors.");
  }
}
