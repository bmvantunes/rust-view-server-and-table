/// <reference types="node" />

import { fileURLToPath } from "node:url";

const shadcnRoot = fileURLToPath(new URL("../packages/ui/src/components/", import.meta.url));

export const shadcnSourceAliases = Object.freeze(
  Object.fromEntries(
    [
      "alert",
      "alert-dialog",
      "button",
      "empty",
      "native-select",
      "popover",
      "skeleton",
      "spinner",
      "table",
      "toast",
    ].map((name) => [`@bruno/shadcn/${name}`, `${shadcnRoot}${name}.tsx`]),
  ),
);
