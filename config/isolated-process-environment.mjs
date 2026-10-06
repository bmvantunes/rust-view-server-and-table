import { delimiter, join } from "node:path";

// Package runners prepend their caller's node_modules/.bin. Changing cwd alone does not
// change that precedence and can load one checkout's Vitest runner with another's test API.
export function isolatedProcessEnvironment(cwd, inherited = process.env) {
  const environment = {
    ...inherited,
    CI: "true",
    PWD: cwd,
    PATH: [
      join(cwd, "node_modules", ".bin"),
      ...(inherited.PATH ?? "")
        .split(delimiter)
        .filter((path) => path !== "" && !path.includes("node_modules")),
    ].join(delimiter),
  };
  delete environment.NODE_PATH;
  return environment;
}
