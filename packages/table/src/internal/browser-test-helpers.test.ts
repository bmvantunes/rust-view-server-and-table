import { afterEach, expect, it, vi } from "vitest";

import { settleBrunoTableBrowserFrames } from "./browser-test-helpers";

afterEach(() => vi.unstubAllGlobals());

it("settles through the supplied native frame function without entering the global probe", async () => {
  const probe = vi.fn(() => {
    throw new Error("harness entered grid probe");
  });
  vi.stubGlobal("requestAnimationFrame", probe);
  const nativeFrame = vi.fn((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  await settleBrunoTableBrowserFrames(3, nativeFrame);
  expect(nativeFrame).toHaveBeenCalledTimes(3);
  expect(probe).not.toHaveBeenCalled();
});
