import { beforeAll } from "vite-plus/test";

import {
  BRUNO_TABLE_CAPABLE_HARDWARE_PROFILE,
  installBrunoTableBenchmarkEnvironment,
} from "./internal/benchmark-profile";

beforeAll(() => {
  installBrunoTableBenchmarkEnvironment({
    browserEngine: BRUNO_TABLE_CAPABLE_HARDWARE_PROFILE.requiredBrowserEngine,
    devicePixelRatio: window.devicePixelRatio,
    logicalProcessorCount: navigator.hardwareConcurrency,
    mode: import.meta.env.MODE,
    userAgent: navigator.userAgent,
    viewport: { height: window.innerHeight, width: window.innerWidth },
  });
});
