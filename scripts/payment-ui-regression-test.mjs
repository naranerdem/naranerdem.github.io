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
assert.match(page, /data-offer-decline=\"\$\{escape\(item\.id\)\}\">Татгалзсаныг тэмдэглэх/);
assert.match(page, /data-offer-close-action=\"\$\{escape\(item\.id\)\}\">Саналыг хаах/);
assert.match(page, /Энэ нь асран хамгаалагч татгалзсан гэсэн тэмдэглэл биш\./);
assert.match(page, /Хариу өгөхийг хүссэн хугацаа өнгөрсөн ч санал хадгалагдаж байна\./);
assert.match(page, /copyMessengerOffer\(offerId\)/);
assert.match(page, /new ClipboardItem\(/);
assert.match(page, /document\.execCommand\?\.\("copy"\)/);
assert.match(page, /message\("Хууллаа", true\)/);
const offerMarkup = page.slice(page.indexOf("function offerMarkup"), page.indexOf("function render"));
assert.doesNotMatch(offerMarkup, /classLabel\)} · \$\{escape\(item\.weekday\)/);

console.log("ok payment staff UI regressions");
