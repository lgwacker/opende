// Loads the altimate-core native engine (Rust/NAPI) and re-exports its
// deterministic functions. altimate-core is a CommonJS native addon, so we load
// it via createRequire from this ESM module.
//
// HARD RULE: we never call the backend/AI/telemetry surface
// (initSdk, flushSdk, resetSdk, reviewAiParse, reviewAiSystemPrompt). Everything
// used here is pure local computation — no network, no API key, no LLM.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Functions that touch the network / SDK / AI — must never be exposed or called.
export const FORBIDDEN = new Set([
  "initSdk",
  "flushSdk",
  "resetSdk",
  "reviewAiParse",
  "reviewAiSystemPrompt",
]);

let _core = null;

// Load the engine. Normally it's the declared dependency `@altimateai/altimate-core`,
// resolved from node_modules. `ALTIMATE_CORE_PATH` can point at an explicit build
// (dir with index.js, or the index.js itself) — used for pinning or local dev.
export function loadCore() {
  if (_core) return _core;
  const override = process.env.ALTIMATE_CORE_PATH;
  try {
    _core = require(override || "@altimateai/altimate-core");
    return _core;
  } catch (e) {
    throw new Error(
      "Could not load the altimate-core engine. It ships as the dependency " +
        "`@altimateai/altimate-core` (run `npm install`), or set ALTIMATE_CORE_PATH " +
        "to a local build.\nUnderlying error: " +
        (e?.message || e),
      { cause: e }
    );
  }
}

// The `Schema` class lives on the native module.
export function Schema() {
  return loadCore().Schema;
}

// Call a named altimate-core function defensively. Rejects forbidden functions
// and awaits any promise the engine returns (several checks are async).
export async function call(fnName, args) {
  if (FORBIDDEN.has(fnName)) {
    throw new Error(`Refusing to call backend/AI function '${fnName}'.`);
  }
  const core = loadCore();
  const fn = core[fnName];
  if (typeof fn !== "function") {
    throw new Error(`altimate-core has no function '${fnName}'.`);
  }
  return await fn(...args);
}
