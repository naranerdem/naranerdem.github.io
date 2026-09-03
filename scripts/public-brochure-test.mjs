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
assert.match(home, /<span>Facebook<\/span><strong>Наран Эрдэмийн хуудас<\/strong>/, "Facebook contact card has a distinct link label");
assert.equal((home.match(/<span>Facebook<\/span><strong>Наран Эрдэмийн хуудас<\/strong>/g) || []).length, 2, "runtime public contact projection keeps the same Facebook link label");
assert.match(prose, /startsWith\("## "\)/); assert.match(prose, /<p>/); assert.match(prose, /escapePublicText/);
assert.match(prose, /startsWith\("# "\)/); assert.match(prose, /<h3>/);
assert.doesNotMatch(prose, /markdown|<script>/i);
assert.match(font, /normalizePublicFont\(font\) \|\| "sans"/);
assert.match(font, /PUBLIC_FONT_STORAGE_KEY = "naranerdem\.public-font"/);
assert.match(font, /font === "serif" \|\| font === "sans"/);
assert.match(font, /localStorage\.setItem\(PUBLIC_FONT_STORAGE_KEY, value\)/);
for (const page of [home, register]) {
  assert.match(page, /localStorage\.getItem\("naranerdem\.public-font"\)/, "public shells have the early font bootstrap");
  assert.match(page, /value === "sans" \|\| value === "serif"/, "bootstrap accepts only public font enums");
}
assert.match(program, /loadPublicFont\(\)/, "program pages reconcile the authoritative font setting");
assert.doesNotMatch(staff, /naranerdem\.public-font/, "staff pages do not bootstrap the public font");
assert.match(styles, /\.simple-hero h1 \{[^}]*font-size: clamp\(2\.35rem, 9vw, 5\.5rem\)[^}]*white-space: nowrap/, "hero title stays on one line at a responsive size");
assert.match(styles, /@media \(max-width: 32rem\)[\s\S]*data-public-font="serif"[\s\S]*font-size: 17px/, "serif public body text grows slightly on phones");
assert.match(styles, /\.public-prose h2 \{ font-size: clamp\(1\.35rem, 2vw, 1\.85rem\)/, "brochure headings remain unchanged");
assert.match(styles, /\.public-prose h3, \.rules-dialog h3 \{ color: #073aaf; font-size: 1\.08em; font-style: italic; font-weight: 400;/, "brochure subheadings are compact blue italic text");
assert.match(register, /loadPublicFont\(\)/); assert.match(program, /loadPublicFont\(\)/);
assert.match(register, /renderPublicProse\(guardian\.bodyText\)/, "registration renders rules with the shared public prose renderer");
assert.doesNotMatch(staff, /program-long-description|Дэлгэрэнгүй тайлбар/);

console.log("ok public brochure structure, prose grammar, and font wiring");
