import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/pages/register.astro", "utf8");
const content = readFileSync("src/content/registration.ts", "utf8");

assert.match(page, /initialStageSelection\(window\.location\.search\)/);
assert.match(page, /userStageSelection\(stage\.value\)/);
assert.match(page, /applyStageRecommendation/);
assert.match(page, /data-child-stage/);
assert.match(page, /data-child-class/);
assert.match(page, /type="radio" name="child-\$\{card\.dataset\.childIndex\}-class"/);
assert.match(page, /const firstSurname = childCards\(\)\[0\]\?\.querySelector\("\[data-child-surname\]"\)\?\.value \|\| ""/);
assert.match(page, /data-child-surname value="\$\{escapeText\(surname\)\}"/);
assert.doesNotMatch(page, /data-child-surname[^\n]*(readonly|disabled)/);
assert.match(page, /data-previous-stage-field hidden/);
assert.match(page, /previous\.disabled = !visible/);
assert.match(page, /previous\.required = visible/);
assert.match(page, /field\.hidden = !visible/);
assert.match(page, /id="guardian-rules-dialog"/);
assert.match(page, /id="student-rules-dialog"/);
assert.match(page, /if \(parentAcknowledged && studentAcknowledged\) showReview\(\)/);
assert.match(page, /fetch\("\/api\/registration\/catalog"/);
assert.match(page, /classSelectionIssue/);
assert.match(page, /issue\.focusTarget === "class-status"|card\.querySelector\("\[data-catalog-message\]"\)/);
assert.doesNotMatch(page, /incomplete\.querySelector\("\[data-child-stage\]"\)/);
assert.doesNotMatch(page, /ranked_class_preference|preferenceLabels|1-р сонголт|2-р сонголт|3-р сонголт|wizard-step/);
assert.doesNotMatch(page, /fetch\([^\n]*POST|method:\s*["']POST["']/);
assert.match(content, /\* тэмдэгтэй талбарыг бөглөнө үү\./);
assert.match(content, /Өмнө нь Наран Эрдэмд сурсан уу\?/);
assert.match(content, /Урилгын код/);
assert.match(content, /Энэ шатны анги, цаг хараахан ороогүй байна\./);
assert.match(content, /Төлбөр баталгаажихыг хүлээж буй: \{count\}/);
assert.doesNotMatch(content, /дараа нь өөрчил|өөрчилж болно|Авсан урилгын код|Нэг асран хамгаалагч хэд хэдэн хүүхэд|Өмнө сурч байсан бол сонгоно уу/);

console.log("ok registration prototype structure tests");
