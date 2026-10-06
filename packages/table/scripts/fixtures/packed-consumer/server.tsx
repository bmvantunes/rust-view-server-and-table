import { writeFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { PackedApplication } from "./App";

writeFileSync("markup.json", JSON.stringify(renderToString(<PackedApplication />)));
