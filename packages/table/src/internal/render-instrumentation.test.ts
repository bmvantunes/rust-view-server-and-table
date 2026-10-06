import { describe, expect, it, vi } from "vitest";

import {
  hasBrunoTableClientDragFillFrameListener,
  installBrunoTableClientDragFillFrameListener,
  recordBrunoTableClientDragFillFrame,
} from "./render-instrumentation";
import { BRUNO_TABLE_GESTURE_TIMING_DIAGNOSTIC_SENTINEL } from "./test-diagnostic-build-contract";

describe("BrunoTable Drag Fill frame instrumentation", () => {
  it("records table-scoped frame lifecycle evidence only while a listener is installed", () => {
    const listener = vi.fn();

    expect(hasBrunoTableClientDragFillFrameListener("orders")).toBe(false);
    recordBrunoTableClientDragFillFrame("orders", {
      phase: "scheduled",
      frameId: 11,
    });
    expect(listener).not.toHaveBeenCalled();

    const dispose = installBrunoTableClientDragFillFrameListener("orders", listener);
    try {
      expect(hasBrunoTableClientDragFillFrameListener("orders")).toBe(true);
      expect(hasBrunoTableClientDragFillFrameListener("inventory")).toBe(false);

      recordBrunoTableClientDragFillFrame("inventory", {
        phase: "scheduled",
        frameId: 12,
      });
      recordBrunoTableClientDragFillFrame("orders", {
        phase: "scheduled",
        frameId: 13,
      });
      recordBrunoTableClientDragFillFrame("orders", {
        phase: "ran",
        frameId: 13,
        durationMs: 1.25,
      });

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenNthCalledWith(1, {
        tableId: "orders",
        diagnosticBuildContract: BRUNO_TABLE_GESTURE_TIMING_DIAGNOSTIC_SENTINEL,
        phase: "scheduled",
        frameId: 13,
      });
      expect(listener).toHaveBeenNthCalledWith(2, {
        tableId: "orders",
        diagnosticBuildContract: BRUNO_TABLE_GESTURE_TIMING_DIAGNOSTIC_SENTINEL,
        phase: "ran",
        frameId: 13,
        durationMs: 1.25,
      });

      dispose();
      expect(hasBrunoTableClientDragFillFrameListener("orders")).toBe(false);
      recordBrunoTableClientDragFillFrame("orders", {
        phase: "cancelled",
        frameId: 14,
      });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  });

  it("keeps diagnostics observational when one listener throws", () => {
    const throwing = () => {
      throw new Error("diagnostic failure");
    };
    const survivor = vi.fn();
    const disposeThrowing = installBrunoTableClientDragFillFrameListener("orders", throwing);
    const disposeSurvivor = installBrunoTableClientDragFillFrameListener("orders", survivor);
    try {
      expect(() =>
        recordBrunoTableClientDragFillFrame("orders", {
          phase: "ran",
          frameId: 21,
          durationMs: 0.5,
        }),
      ).not.toThrow();
      expect(survivor).toHaveBeenCalledOnce();
    } finally {
      disposeSurvivor();
      disposeThrowing();
    }
  });
});
