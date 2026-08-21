import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync("src/pages/index.astro", "utf8");
const prose = readFileSync("src/utils/public-prose.ts", "utf8");
const register = readFileSync("src/pages/register.astro", "utf8");
const program = readFileSync("src/pages/programs/[slug].astro", "utf8");
const staff = readFileSync("src/pages/staff/programs.astro", "utf8");
const font = readFileSync("public/scripts/public-font.js", "utf8");
const styles = readFileSync("src/styles/global.css", "utf8");

assert.ok(home.indexOf("Наран Эрдэм") < home.indexOf("ХҮҮХДИЙН ШИНЖЛЭХ УХААНЫ ЛАБОРАТОРИ"));
assert.equal((home.match(/href="\/register\/\?new=1"/g) || []).length, 2);
assert.match(home, /brand-logo/); assert.doesNotMatch(home, /current-registration|stage-item|hero-logo|Одоо бүртгэж байна/);
assert.match(prose, /startsWith\("## "\)/); assert.match(prose, /<p>/); assert.match(prose, /escapePublicText/);
assert.doesNotMatch(prose, /markdown|<script>/i);
assert.match(font, /font === "serif" \? "serif" : "sans"/);
assert.match(styles, /\.simple-hero h1 \{[^}]*font-size: clamp\(2\.35rem, 9vw, 5\.5rem\)[^}]*white-space: nowrap/, "hero title stays on one line at a responsive size");
assert.match(register, /loadPublicFont\(\)/); assert.match(program, /loadPublicFont\(\)/);
assert.doesNotMatch(staff, /program-long-description|Дэлгэрэнгүй тайлбар/);

console.log("ok public brochure structure, prose grammar, and font wiring");
