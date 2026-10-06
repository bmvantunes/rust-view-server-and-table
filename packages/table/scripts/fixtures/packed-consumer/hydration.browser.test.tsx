/// <reference types="vite/client" />

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { PackedApplication } from "./App";
import markup from "./markup.json";
import "./bruno-table.css";

test("hydrates the installed compiled grid and shadcn controls from Node SSR", async () => {
  expect(markup).toContain("Ada");
  expect(markup).toContain("Grace");
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.append(host);
  const originalGrid = page.getByRole("grid").element();
  const errors: unknown[] = [];
  const consoleError = vi.spyOn(console, "error");
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(host, <PackedApplication />, {
      onRecoverableError: (error) => errors.push(error),
    });
  });
  environment.IS_REACT_ACT_ENVIRONMENT = previous;
  try {
    expect(page.getByRole("grid").element()).toBe(originalGrid);
    await page.getByRole("button", { name: "Clicks: 0" }).click();
    await expect.element(page.getByRole("button", { name: "Clicks: 1" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Quick Filter" }).fill("grace");
    await expect.element(page.getByRole("status", { name: "Result rows" })).toHaveTextContent("1");
    await expect.element(page.getByRole("gridcell", { name: "Grace", exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("gridcell", { name: "Ada", exact: true }))
      .not.toBeInTheDocument();
    expect(errors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root!.unmount());
    consoleError.mockRestore();
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
    host.remove();
  }
});
