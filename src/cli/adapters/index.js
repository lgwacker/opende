// Harness adapter registry. Adding a harness (opencode/Cursor/Windsurf) = one new
// adapter module exporting a `scaffold(ctx)` (and, later, the declarative
// mcpConfig/skills/agents/doctrine/gate descriptors). Assets stay single-source
// under assets/; only the generator differs per harness.
import { claudeAdapter } from "./claude.js";

export const ADAPTERS = {
  claude: claudeAdapter,
};

export function getAdapter(id) {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`Unknown harness '${id}'. Available: ${Object.keys(ADAPTERS).join(", ")}.`);
  return a;
}
