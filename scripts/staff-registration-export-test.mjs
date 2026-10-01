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
assert.match(service, /activePaymentInstallmentsForChildren/, "export reuses the active effective agreement projection instead of independently summing historical rows");
assert.match(service, /cashAllocatedAmountMnt/, "export distinguishes cash received from credit applied to an obligation");
assert.match(service, /secondary_phone AS secondaryPhone/, "export projects the collected secondary phone from the authoritative draft");
assert.match(service, /COALESCE\(guardian_account\.facebook_name, registration_draft\.facebook_name\) AS guardianFacebookName/, "export projects the existing guardian Facebook account, preferring the canonical guardian when available");
assert.match(service, /class_session\.stage_code AS stageCode/, "export reads the authoritative structured class stage");
assert.match(service, /COALESCE\(class_meeting_rule\.weekly_weekday, class_session\.weekday\) AS weekday/, "export reads the authoritative meeting weekday without parsing its display label");
assert.match(service, /COALESCE\(class_meeting_rule\.start_time, class_session\.start_time\) AS startTime/, "export reads the authoritative local class start time without timezone conversion");
assert.match(service, /LEFT JOIN class_meeting_rule ON class_meeting_rule\.class_session_id = class_session\.id/, "export keeps the one-to-one meeting rule join bounded to the selected class");
assert.match(service, /stageMatches\.length !== 1 \|\| weekdayMatches\.length !== 1 \|\| timeMatches\.length !== 1/, "legacy display labels are only used when their schedule is unambiguous");
assert.match(service, /effectiveAmountMnt - installment\.allocatedAmountMnt/, "export remaining balance uses the same effective active obligations as staff payment detail");
assert.match(readFileSync("src/scripts/staff-reports.js", "utf8"), /Кредитээр тооцсон/, "the TSV exposes credit application without mislabeling it as paid cash");
assert.match(service, /"Бүрэн төлсөн": 10,[\s\S]*"Хэсэгчлэн төлсөн": 20,[\s\S]*"Хугацаа хэтэрсэн": 30,[\s\S]*"Төлбөр хүлээж байна": 40,[\s\S]*"Шалгах шаардлагатай": 50,[\s\S]*"Кредит \/ буцаалт": 60,[\s\S]*"Хүлээлгийн жагсаалт": 70/, "export follows the staff operational order, retaining credit/refund before waitlist when present");
assert.match(service, /"Цуцлагдсан": 99/, "cancelled registrations sort after every active operational status");
assert.match(paymentsPage, /id="payment-copy"[^>]*aria-label="Excel-д хуулах"[^>]*>Бэлтгэж байна…</, "registration/payment exposes an accessible clipboard action while its authorized projection loads");
assert.match(paymentsPage, /void prepareRegistrationReport\(\)/, "list refresh preloads the authorized TSV projection for clipboard user activation");
assert.match(paymentsPage, /await copyReportToClipboard\(report\)/, "clipboard action uses the shared Excel-safe TSV helper");
assert.match(paymentsPage, /copyFallback\(reportToTsv\(report\)\)/, "clipboard denial retains a selectable manual-copy fallback");
const copyHandler = paymentsPage.slice(paymentsPage.indexOf('q("#payment-copy").addEventListener'), paymentsPage.indexOf('q("#payment-export").addEventListener'));
assert.match(copyHandler, /await copyReportToClipboard\(report\)/, "the copy handler begins clipboard work directly from the user click");
assert.match(copyHandler, /let report = state\.registrationReportCache/, "the copy handler uses the prepared shared report when it is available");
assert.match(copyHandler, /if \(!report\)[\s\S]*?await registrationReport\(\)/, "a cache miss has an explicit recoverable export fallback");
assert.match(paymentsPage, /registrationReport\(\)/, "file export uses the authorized data projection");
const exportProjection = service.slice(service.indexOf("getRegistrationExportRows"));
assert.doesNotMatch(exportProjection, /access_token_hash|outbox_text|session_token|challenge/, "export excludes credentials, capability data, and raw email content");

const report = buildRegistrationPaymentReport({ generatedAt: "2026-09-05T00:00:00.000Z", rows: [{
  status: "Хэсэгчлэн төлсөн", child: "Өлзий =SUM(1,1)", birthDate: "2018-02-03", grade: "2", school: "Сургууль",
  guardian: "Асран хамгаалагч", relationship: "Ээж", phone: "01234567", secondaryPhone: "+976 00112233", guardianFacebookName: "guardian.example", email: "parent@example.test", emailStatus: "Баталгаажаагүй",
  address: "+formula", academicYear: "2026–2027", stage: "1-р шат", weekday: "Бямба", startTime: "14:00", paymentPlan: "2 хувааж",
  price: 100000, discount: 0, paid: 50000, remaining: 50000, dueAt: "2026-09-30T18:10:45.000Z", ownReferral: "NE-TEST", usedReferral: "", registeredAt: "2026-09-25T12:40:03.521Z",
}, {
  status: "Бүрэн төлсөн", child: "Бүрэн төлсөн", birthDate: "2017-02-03", grade: "3", school: "Сургууль",
  guardian: "Асран хамгаалагч", relationship: "Аав", phone: "99112233", secondaryPhone: "", guardianFacebookName: "", email: "paid@example.test", emailStatus: "Баталгаажсан",
  address: "Хаяг", academicYear: "2026–2027", stage: "2-р шат", weekday: "Лхагва", startTime: "09:00", paymentPlan: "2 хувааж",
  price: 100000, discount: 0, paid: 100000, remaining: 0, dueAt: "", ownReferral: "", usedReferral: "", registeredAt: "2026-09-04",
}, {
  status: "Цуцлагдсан", child: "Түүх", birthDate: "2016-02-03", grade: "4", school: "Сургууль",
  guardian: "Асран хамгаалагч", relationship: "Асран хамгаалагч", phone: "99110000", secondaryPhone: "", guardianFacebookName: "", email: "cancelled@example.test", emailStatus: "Баталгаажаагүй",
  address: "Хаяг", academicYear: "2026–2027", stage: "3-р шат", weekday: "Пүрэв", startTime: "15:00", paymentPlan: "Нэг удаа",
  price: 100000, discount: 0, paid: 0, remaining: 100000, dueAt: "", ownReferral: "", usedReferral: "", registeredAt: "2026-09-03",
}] });
const tsv = reportToTsv(report);
assert.doesNotMatch(tsv, /'01234567/, "ordinary phone values do not carry a visible spreadsheet apostrophe");
assert.match(tsv, /\t01234567\t/, "a leading-zero phone remains an unchanged TSV string");
assert.match(tsv, /\+976 00112233/, "an international phone remains legible without a formula escape marker");
assert.ok(tsv.indexOf("Утас") < tsv.indexOf("Нэмэлт утас"), "download and clipboard share the same primary/secondary phone column order");
assert.ok(tsv.indexOf("Нэмэлт утас") < tsv.indexOf("Асран хамгаалагчийн Facebook"), "guardian Facebook stays beside the other guardian contact columns");
assert.match(tsv, /guardian\.example/, "the existing guardian Facebook value is exported");
const lines = tsv.split("\n");
const headers = lines[3].split("\t");
const rows = lines.slice(4).map((line) => line.split("\t"));
assert.ok(!headers.includes("Сургалт"), "the export no longer has a separate offering column");
assert.ok(headers.includes("Асран хамгаалагчийн Facebook"), "the export names the guardian Facebook column in Mongolian");
assert.ok(rows.every((row) => row.length === headers.length), "every clipboard/download row remains aligned with the shared headers");
assert.deepEqual(headers.slice(0, 3), ["Төлөв", "Бүртгүүлсэн", "Хүүхэд"], "registration time is the second shared clipboard/download column");
assert.equal(rows[1][headers.indexOf("Асран хамгаалагчийн Facebook")], "", "a missing guardian Facebook value remains blank");
assert.deepEqual(headers.slice(headers.indexOf("Шат"), headers.indexOf("Шат") + 3), ["Шат", "Гариг", "Цаг"], "the structured class schedule replaces the former combined column in place");
assert.deepEqual(rows[0].slice(headers.indexOf("Шат"), headers.indexOf("Шат") + 3), ["1-р шат", "Бямба", "14:00"], "the structured schedule has one weekday and local start time only");
assert.equal(rows[0][headers.indexOf("Цаг")], "14:00", "class times are emitted as HH:mm without seconds or an end time");
assert.ok(!headers.includes("Анги, цаг"), "the ambiguous combined class-time column is removed");
const missingSchedule = buildRegistrationPaymentReport({ rows: [{ status: "Төлбөр хүлээж байна", child: "Legacy", stage: "", weekday: "", startTime: "", registeredAt: "2026-09-05" }] });
const missingRow = reportToTsv(missingSchedule).split("\n")[4].split("\t");
assert.deepEqual(missingRow.slice(missingSchedule.columns.findIndex((column) => column.key === "stage"), missingSchedule.columns.findIndex((column) => column.key === "stage") + 3), ["", "", ""], "missing legacy schedule data remains blank rather than invented");
assert.match(tsv, /Үүсгэсэн: 2026-09-05 08:00 · Цагийн бүс: Asia\/Ulaanbaatar/, "report generation time is labelled once in Ulaanbaatar time");
assert.equal(rows[0][headers.indexOf("Бүртгүүлсэн")], "2026-09-25 20:40", "registration timestamps use Ulaanbaatar minute precision");
assert.equal(rows[0][headers.indexOf("Дараагийн хугацаа")], "2026-10-01 02:10", "timestamp deadlines roll over in Ulaanbaatar time");
assert.equal(rows[1][headers.indexOf("Төрсөн огноо")], "2017-02-03", "date-only birthdays remain unchanged");
assert.match(tsv, /'\+formula/, "formula-like user values are neutralized");
assert.match(tsv, /Өлзий =SUM\(1,1\)/, "Mongolian Unicode survives report serialization");
assert.equal((tsv.match(/2 хувааж/g) || []).length, 2, "generated TSV retains selected two-installment agreements including a fully paid agreement");
assert.ok(tsv.indexOf("Хэсэгчлэн төлсөн") < tsv.indexOf("Цуцлагдсан"), "generated TSV retains the service-provided active-before-cancelled ordering");
console.log("ok staff registration export authorization, selected agreement labels, status ordering, safe columns, formula protection, Unicode, and phone preservation");
