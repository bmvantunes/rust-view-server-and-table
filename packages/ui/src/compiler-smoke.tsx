import type { JSX } from "react";

type CompilerSmokeProps = {
  value: number;
};

function CompilerSmoke({ value }: CompilerSmokeProps): JSX.Element {
  const result = { doubled: value * 2 };

  return <output>{result.doubled}</output>;
}

export { CompilerSmoke };
