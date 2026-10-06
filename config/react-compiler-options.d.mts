export declare const reactCompilerOptions: Readonly<{
  compilationMode: "infer";
  eslintSuppressionRules: string[];
  panicThreshold: "all_errors";
  target: "19";
}>;

export declare const reactCompilerStrictnessFixture: string;

export declare function assertReactCompilerStrictness(
  transformSync: typeof import("oxc-transform-react").transformSync,
): void;
