import { describe, expect, it, vi } from "vitest";

import { reconcileBrunoTableClientEditSourcePublication } from "./client-edit-source";

describe("BrunoTable Client edit-source publication", () => {
  it("disables Save and preserves edit evidence through a non-authoritative gap", () => {
    const setSavePreflightAvailable = vi.fn();
    const reconcileSourceRows = vi.fn();
    const reconcileActiveRow = vi.fn();

    reconcileBrunoTableClientEditSourcePublication(
      { hasAuthoritativeEditSource: () => false },
      { setSavePreflightAvailable },
      { reconcileSourceRows, reconcileActiveRow },
      undefined,
    );

    expect(setSavePreflightAvailable).toHaveBeenCalledWith(false);
    expect(reconcileSourceRows).not.toHaveBeenCalled();
    expect(reconcileActiveRow).not.toHaveBeenCalled();
  });

  it("enables Save and reconciles exact identities when authority returns", () => {
    const setSavePreflightAvailable = vi.fn();
    const reconcileSourceRows = vi.fn();
    const reconcileActiveRow = vi.fn();
    const changedRowIds = new Set(["ada"]);

    reconcileBrunoTableClientEditSourcePublication(
      { hasAuthoritativeEditSource: () => true },
      { setSavePreflightAvailable },
      { reconcileSourceRows, reconcileActiveRow },
      changedRowIds,
    );

    expect(setSavePreflightAvailable).toHaveBeenCalledWith(true);
    expect(reconcileSourceRows).toHaveBeenCalledWith(changedRowIds);
    expect(reconcileActiveRow).toHaveBeenCalledWith(changedRowIds);
  });
});
