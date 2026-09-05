import assert from "node:assert/strict";
import { buildRegistrationPaymentReport, reportToTsv } from "../src/scripts/staff-reports.js";
import { readFileSync } from "node:fs";

const router = readFileSync("src/server/api/router.ts", "utf8");
const service = readFileSync("src/server/staff/payment-reconciliation.ts", "utf8");
const paymentsPage = readFileSync("src/pages/staff/payments.astro", "utf8");

assert.match(router, /path === "\/api\/staff\/payments\/export"/, "export has a dedicated API route");
assert.match(router, /requireStaffCapability\(request, env, "registration\.view"\)/, "export requires registration visibility server-side");
assert.match(service, /getRegistrationExportRows/, "export uses a narrow operational projection");
assert.match(paymentsPage, /copyReportToClipboard/, "clipboard export uses the shared TSV helper");
assert.match(paymentsPage, /registrationReport\(\)/, "clipboard and file export share one authorized data projection");
const exportProjection = service.slice(service.indexOf("getRegistrationExportRows"));
assert.doesNotMatch(exportProjection, /access_token_hash|outbox_text|session_token|challenge/, "export excludes credentials, capability data, and raw email content");

const report = buildRegistrationPaymentReport({ generatedAt: "2026-09-05T00:00:00.000Z", rows: [{
  status: "Баталгаажсан", child: "Өлзий =SUM(1,1)", birthDate: "2018-02-03", grade: "2", school: "Сургууль",
  guardian: "Асран хамгаалагч", relationship: "Ээж", phone: "01234567", email: "parent@example.test", emailStatus: "Баталгаажаагүй",
  address: "+formula", academicYear: "2026–2027", offering: "1-р шат", className: "Мягмар 09:00", paymentPlan: "Нэг удаа",
  price: 100000, discount: 0, paid: 0, remaining: 100000, dueAt: "2026-09-10", ownReferral: "NE-TEST", usedReferral: "", registeredAt: "2026-09-05",
}] });
const tsv = reportToTsv(report);
assert.match(tsv, /'01234567/, "phone values are emitted as Excel text");
assert.match(tsv, /'\+formula/, "formula-like user values are neutralized");
assert.match(tsv, /Өлзий =SUM\(1,1\)/, "Mongolian Unicode survives report serialization");
console.log("ok staff registration export authorization, safe columns, formula protection, Unicode, and phone preservation");
