import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/pages/staff/payments.astro", "utf8");
assert.match(page, /timeZone: "Asia\/Ulaanbaatar"/);
assert.match(page, /localDateTime\(new Date\(\)\)/);
assert.doesNotMatch(page, /toISOString\(\)\.slice\(0, 16\)/);
assert.doesNotMatch(page, /finalizeAfter\?\.slice/);
assert.match(page, /remaining <= 0 \? "Төлбөр баталгаажсан"/);
assert.match(page, /item\.seatConfirmationApproved \? "Хэсэгчлэн төлсөн"/);
assert.match(page, /\$\{tentative\}/);

console.log("ok payment staff UI regressions");
