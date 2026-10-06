import { describe, expect, it } from "vite-plus/test";

import { isBrunoTableDocumentFocusChainActive } from "./focus-ownership";

function topLevelDocument(hasFocus: boolean): Document {
  const currentWindow: { frameElement: null; parent: unknown } = {
    frameElement: null,
    parent: undefined,
  };
  currentWindow.parent = currentWindow;
  const ownerDocument = {
    defaultView: currentWindow,
    hasFocus: () => hasFocus,
  };
  return ownerDocument as unknown as Document;
}

function inaccessibleParentDocument(): Document {
  const ownerDocument = {
    defaultView: {
      frameElement: null,
      get parent(): never {
        throw new Error("cross-origin parent access");
      },
    },
    hasFocus: () => true,
  };
  return ownerDocument as unknown as Document;
}

function distinctParentDocument(): Document {
  const parentWindow = {};
  const ownerDocument = {
    defaultView: {
      frameElement: null,
      parent: parentWindow,
    },
    hasFocus: () => true,
  };
  return ownerDocument as unknown as Document;
}

describe("BrunoTable document focus ownership", () => {
  it("rejects a top-level document whose browsing context is not focused", () => {
    expect(isBrunoTableDocumentFocusChainActive(topLevelDocument(false))).toBe(false);
  });

  it("accepts a focused top-level document", () => {
    expect(isBrunoTableDocumentFocusChainActive(topLevelDocument(true))).toBe(true);
  });

  it("rejects an embedded document whose parent frame is inaccessible", () => {
    expect(isBrunoTableDocumentFocusChainActive(inaccessibleParentDocument())).toBe(false);
  });

  it("rejects an embedded document with a distinct accessible parent window", () => {
    expect(isBrunoTableDocumentFocusChainActive(distinctParentDocument())).toBe(false);
  });
});
