import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-public-prose-"));
const bundlePath = path.join(tempDir, "public-prose.mjs");

try {
  const bundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/utils/public-prose.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" });
  if (bundled.status !== 0) throw new Error(bundled.stderr);
  const { renderPublicProse } = await import(`${pathToFileURL(bundlePath).href}?public-prose`);
  assert.equal(renderPublicProse("Энгийн мөр"), "<p>Энгийн мөр</p>");
  assert.equal(renderPublicProse("## Том гарчиг\n# Дэд гарчиг"), "<h2>Том гарчиг</h2><h3>Дэд гарчиг</h3>");
  assert.equal(renderPublicProse("<script>alert('x')</script>"), "<p>&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;</p>");

  const browserRenderer = readFileSync("public/scripts/public-prose.js", "utf8");
  const homepage = readFileSync("src/pages/index.astro", "utf8");
  const register = readFileSync("src/pages/register.astro", "utf8");
  assert.match(browserRenderer, /startsWith\("## "\)/);
  assert.match(browserRenderer, /startsWith\("# "\)/);
  assert.match(homepage, /renderPublicProse/);
  assert.match(register, /renderPublicProse\(guardian\.bodyText\)/);
  assert.match(register, /renderPublicProse\(student\.bodyText\)/);
  assert.doesNotMatch(register, /guardian\.bodyText\.split/);
  console.log("ok public prose safely renders paragraphs, major headings, and subheadings");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
