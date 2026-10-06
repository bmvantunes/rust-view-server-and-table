import { createContext, useContext } from "react";

import type { ReactNode } from "react";

import type { BrunoTableClientFacetRowsSource } from "./client-source-adapter";
import type { BrunoTableRowPipelineRuntimeView } from "./grid-runtime";

type BrunoTableClientFilterContextValue = Readonly<{
  readonly runtime: BrunoTableRowPipelineRuntimeView;
  readonly facetRows: BrunoTableClientFacetRowsSource;
}>;

const BrunoTableClientFilterContext = createContext<BrunoTableClientFilterContextValue | undefined>(
  undefined,
);

export function BrunoTableClientFilterContextProvider({
  children,
  value,
}: Readonly<{
  readonly children: ReactNode;
  readonly value: BrunoTableClientFilterContextValue;
}>): ReactNode {
  return (
    <BrunoTableClientFilterContext.Provider value={value}>
      {children}
    </BrunoTableClientFilterContext.Provider>
  );
}

export function useBrunoTableClientFilterContext(): BrunoTableClientFilterContextValue {
  const value = useContext(BrunoTableClientFilterContext);
  if (value === undefined) {
    throw new Error("BrunoTable filter controls must be rendered inside BrunoTableClient.");
  }
  return value;
}
