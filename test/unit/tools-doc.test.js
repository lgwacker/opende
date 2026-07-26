// Guards the docs generator against silently under-reporting. It previously
// emitted "0 tools": its brace scanner read the apostrophe in a regex literal
// (`s.replace(/'/g, "''")` in mcp.js) as a string opener and swallowed the rest
// of the registry. A truncated doc looks plausible, so assert the count instead.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MCP = path.join(ROOT, "src", "mcp.js");
const DOC = path.join(ROOT, "docs", "tools.md");

/** Count `name: {` entries at the top level of the TOOLS object in mcp.js. */
function declaredToolCount() {
  const src = fs.readFileSync(MCP, "utf8");
  const body = src.slice(src.indexOf("const TOOLS = {"));
  return [...body.matchAll(/^ {2}(\w+): \{/gm)].length;
}

describe("docs/tools.md generator", () => {
  test("documents every tool declared in mcp.js", () => {
    execFileSync("node", [path.join(ROOT, "scripts", "gen-tools-doc.js")], { cwd: ROOT });
    const doc = fs.readFileSync(DOC, "utf8");
    const declared = declaredToolCount();

    assert.ok(declared > 50, `expected a substantial registry, found ${declared} tools in mcp.js`);
    const header = doc.match(/\*\*(\d+) deterministic tools\*\*/);
    assert.ok(header, "tools.md is missing its tool-count header");
    assert.equal(Number(header[1]), declared);
    assert.equal(doc.match(/^### `/gm)?.length, declared);
  });

  test("includes tools declared after the regex literal that used to truncate it", () => {
    const doc = fs.readFileSync(DOC, "utf8");
    // schema_inspect holds the `/'/g` regex; everything below it was lost.
    for (const name of ["schema_inspect", "finops_credits", "schema_cache_status", "impact_analysis"]) {
      assert.match(doc, new RegExp("^### `" + name + "`", "m"), `tools.md is missing ${name}`);
    }
  });

  test("the checked-in doc is up to date with mcp.js", () => {
    const before = fs.readFileSync(DOC, "utf8");
    execFileSync("node", [path.join(ROOT, "scripts", "gen-tools-doc.js")], { cwd: ROOT });
    assert.equal(fs.readFileSync(DOC, "utf8"), before, "run `npm run docs:generate` and commit the result");
  });
});
