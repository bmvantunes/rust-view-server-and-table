import type { JSX } from "react";

type CompilerSmokeProps = {
  readonly value: number;
};

function CompilerSmoke({ value }: CompilerSmokeProps): JSX.Element {
  const result = { doubled: value * 2 };

  return <output>{result.doubled}</output>;
}

export { CompilerSmoke };
