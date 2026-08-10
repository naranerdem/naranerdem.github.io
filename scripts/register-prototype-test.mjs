import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/pages/register.astro", "utf8");
const content = readFileSync("src/content/registration.ts", "utf8");

assert.match(page, /const stagesFromQuery = \{ "1": "stage_1", "2": "stage_2", "3": "stage_3" \}/);
assert.match(page, /const queryStage = stagesFromQuery\[new URLSearchParams\(window\.location\.search\)\.get\("stage"\)\] \|\| ""/);
assert.match(page, /data-child-stage/);
assert.match(page, /data-child-class/);
assert.match(page, /type="radio" name="child-\$\{card\.dataset\.childIndex\}-class"/);
assert.match(page, /const firstSurname = childCards\(\)\[0\]\?\.querySelector\("\[data-child-surname\]"\)\?\.value \|\| ""/);
assert.match(page, /data-child-surname value="\$\{escapeText\(surname\)\}"/);
assert.match(page, /id="guardian-rules-dialog"/);
assert.match(page, /id="student-rules-dialog"/);
assert.match(page, /if \(parentAcknowledged && studentAcknowledged\) showReview\(\)/);
assert.match(page, /fetch\("\/api\/registration\/catalog"/);
assert.doesNotMatch(page, /ranked_class_preference|preferenceLabels|1-р сонголт|2-р сонголт|3-р сонголт|wizard-step/);
assert.doesNotMatch(page, /fetch\([^\n]*POST|method:\s*["']POST["']/);
assert.match(content, /\* тэмдэгтэй талбарыг бөглөнө үү\./);

console.log("ok registration prototype structure tests");
