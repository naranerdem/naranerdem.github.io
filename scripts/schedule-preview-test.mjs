import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pagePath = "dist/schedule-preview/index.html";
assert.ok(existsSync(pagePath), "schedule preview static page was built");
const page = readFileSync(pagePath, "utf8");
assert.match(page, /Хуваарийн туршилтын харагдац/);
assert.match(page, /\/api\/calendar\/published/);
assert.match(page, /Дараагийн хичээл/);
assert.match(page, /Бүх хуваарь/);
assert.match(page, /Туршилтын анги/);
assert.match(page, /weekdayNames/);
assert.match(page, /replaceChildren/);
assert.doesNotMatch(page, /innerHTML/);
console.log("ok static schedule preview contract");
