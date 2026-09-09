import assert from "node:assert/strict";
import { buildRegistrationPaymentReport, reportToTsv } from "../src/scripts/staff-reports.js";
import { readFileSync } from "node:fs";

const router = readFileSync("src/server/api/router.ts", "utf8");
const service = readFileSync("src/server/staff/payment-reconciliation.ts", "utf8");
const paymentsPage = readFileSync("src/pages/staff/payments.astro", "utf8");

assert.match(router, /path === "\/api\/staff\/payments\/export"/, "export has a dedicated API route");
assert.match(router, /requireStaffCapability\(request, env, "registration\.view"\)/, "export requires registration visibility server-side");
assert.match(service, /getRegistrationExportRows/, "export uses a narrow operational projection");
assert.match(service, /registration_draft_child\.payment_plan_code AS paymentPlan/, "export reads the selected per-child agreement snapshot rather than the draft-level grouping marker");
assert.match(service, /code === "two_installment" \? "2 хувааж"/, "two-installment agreements retain their plan label independently of payment history");
assert.match(service, /"Тодруулаагүй"/, "historically missing agreement data is not misreported as one-time payment");
assert.match(service, /statusRank/, "export applies an explicit operational status ordering");
assert.match(service, /"Төлбөр баталгаажсан": 10,[\s\S]*"Хэсэгчлэн төлсөн": 20,[\s\S]*"Хугацаа хэтэрсэн": 30,[\s\S]*"Төлбөр хүлээж байна": 40,[\s\S]*"Шалгах шаардлагатай": 50,[\s\S]*"Кредит \/ буцаалт": 60,[\s\S]*"Хүлээлгийн жагсаалт": 70/, "export follows the staff operational order, retaining credit/refund before waitlist when present");
assert.match(service, /"Цуцлагдсан": 99/, "cancelled registrations sort after every active operational status");
assert.match(paymentsPage, /id="payment-copy"[^>]*aria-label="Excel-д хуулах"[^>]*>Бэлтгэж байна…</, "registration/payment exposes an accessible clipboard action while its authorized projection loads");
assert.match(paymentsPage, /void prepareRegistrationReport\(\)/, "list refresh preloads the authorized TSV projection for clipboard user activation");
assert.match(paymentsPage, /await copyReportToClipboard\(report\)/, "clipboard action uses the shared Excel-safe TSV helper");
assert.match(paymentsPage, /copyFallback\(reportToTsv\(report\)\)/, "clipboard denial retains a selectable manual-copy fallback");
const copyHandler = paymentsPage.slice(paymentsPage.indexOf('q("#payment-copy").addEventListener'), paymentsPage.indexOf('q("#payment-export").addEventListener'));
assert.match(copyHandler, /await copyReportToClipboard\(report\)/, "the copy handler begins clipboard work directly from the user click");
assert.doesNotMatch(copyHandler, /registrationReport\(|fetch\(.*payments\/export/, "the copy handler never starts an export fetch before invoking clipboard copy");
assert.match(paymentsPage, /registrationReport\(\)/, "file export uses the authorized data projection");
const exportProjection = service.slice(service.indexOf("getRegistrationExportRows"));
assert.doesNotMatch(exportProjection, /access_token_hash|outbox_text|session_token|challenge/, "export excludes credentials, capability data, and raw email content");

const report = buildRegistrationPaymentReport({ generatedAt: "2026-09-05T00:00:00.000Z", rows: [{
  status: "Хэсэгчлэн төлсөн", child: "Өлзий =SUM(1,1)", birthDate: "2018-02-03", grade: "2", school: "Сургууль",
  guardian: "Асран хамгаалагч", relationship: "Ээж", phone: "01234567", email: "parent@example.test", emailStatus: "Баталгаажаагүй",
  address: "+formula", academicYear: "2026–2027", offering: "1-р шат", className: "Мягмар 09:00", paymentPlan: "2 хувааж",
  price: 100000, discount: 0, paid: 50000, remaining: 50000, dueAt: "2026-09-10", ownReferral: "NE-TEST", usedReferral: "", registeredAt: "2026-09-05",
}, {
  status: "Төлбөр баталгаажсан", child: "Бүрэн төлсөн", birthDate: "2017-02-03", grade: "3", school: "Сургууль",
  guardian: "Асран хамгаалагч", relationship: "Аав", phone: "99112233", email: "paid@example.test", emailStatus: "Баталгаажсан",
  address: "Хаяг", academicYear: "2026–2027", offering: "2-р шат", className: "Лхагва 09:00", paymentPlan: "2 хувааж",
  price: 100000, discount: 0, paid: 100000, remaining: 0, dueAt: "", ownReferral: "", usedReferral: "", registeredAt: "2026-09-04",
}, {
  status: "Цуцлагдсан", child: "Түүх", birthDate: "2016-02-03", grade: "4", school: "Сургууль",
  guardian: "Асран хамгаалагч", relationship: "Асран хамгаалагч", phone: "99110000", email: "cancelled@example.test", emailStatus: "Баталгаажаагүй",
  address: "Хаяг", academicYear: "2026–2027", offering: "3-р шат", className: "Пүрэв 15:00", paymentPlan: "Нэг удаа",
  price: 100000, discount: 0, paid: 0, remaining: 100000, dueAt: "", ownReferral: "", usedReferral: "", registeredAt: "2026-09-03",
}] });
const tsv = reportToTsv(report);
assert.match(tsv, /'01234567/, "phone values are emitted as Excel text");
assert.match(tsv, /'\+formula/, "formula-like user values are neutralized");
assert.match(tsv, /Өлзий =SUM\(1,1\)/, "Mongolian Unicode survives report serialization");
assert.equal((tsv.match(/2 хувааж/g) || []).length, 2, "generated TSV retains selected two-installment agreements including a fully paid agreement");
assert.ok(tsv.indexOf("Хэсэгчлэн төлсөн") < tsv.indexOf("Цуцлагдсан"), "generated TSV retains the service-provided active-before-cancelled ordering");
console.log("ok staff registration export authorization, selected agreement labels, status ordering, safe columns, formula protection, Unicode, and phone preservation");
