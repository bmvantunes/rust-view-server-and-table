import { bench } from "../benchmark-adapter";

bench(
  "warmup failure",
  () => {
    throw new Error("Intentional benchmark warmup failure.");
  },
  { iterations: 2, time: 0, warmupIterations: 1, warmupTime: 0 },
);

bench(
  "measured success",
  () => {
    Math.sqrt(37);
  },
  {
    iterations: 2,
    time: 0,
    warmupIterations: 1,
    warmupTime: 0,
  },
);
