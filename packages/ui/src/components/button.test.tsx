import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import { Button, buttonVariants } from "./button";

describe("Button", () => {
  test("renders the Base UI button with the selected variant", () => {
    const markup = renderToStaticMarkup(
      <Button variant="outline" disabled>
        Save
      </Button>,
    );

    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("border-border");
    expect(markup).toContain("h-7");
    expect(markup).toContain("Save");
  });

  test("exposes the canonical variant helper for semantic links", () => {
    expect(buttonVariants({ variant: "link" })).toContain("hover:underline");
  });
});
