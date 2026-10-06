import { afterEach, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { NumericProbe } from "./internal/compiler-numeric-probe";

afterEach(cleanup);
test("compiled state and event callbacks preserve exact bigint literals and operations", async () => {
  await render(<NumericProbe />);
  const output = page.getByRole("status", { name: "Compiled exact values", exact: true });
  await expect
    .element(output)
    .toMatchTextContent(
      "90071992547409931234567890|-90071992547409931234567890|264|2000|true|true|true|42",
    );
  await page.getByRole("button", { name: "Next exact value", exact: true }).click();
  await expect
    .element(output)
    .toMatchTextContent(
      "90071992547409931234567891|-90071992547409931234567890|264|2000|true|true|true|42",
    );
});
