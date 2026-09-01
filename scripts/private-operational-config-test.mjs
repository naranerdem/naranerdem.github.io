import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPrivateOperationalConfigImportPlan, buildPrivateOperationalConfigImportSql, createPrivateOperationalConfigBundle, sha256, validatePrivateOperationalConfigBundle } from "./private-operational-config.mjs";

const rule = (code, body) => ({ code, title: code === "guardian" ? "Асран хамгаалагч" : "Сурагч", body_text: body, body_hash: sha256(body) });
const bundle = createPrivateOperationalConfigBundle({
  centerInformation: { phone: "90000000", public_email: "info@example.test", facebook_page_url: "https://example.test", physical_address: "Тест", homepage_intro: "Товч", about_center_text: "Танилцуулга", teacher_bio: "Багш" },
  courseRules: [rule("guardian", "Асран хамгаалагчийн журам"), rule("student", "Сурагчийн журам")],
  paymentCollection: { bank_name: "Банк", account_holder_name: "Эзэмшигч", account_number: "123", iban: null, transfer_instruction: "Заавар" },
}, "staging", "2026-09-01T00:00:00.000Z");
const target = {
  centerInformation: { ...bundle.center_information, updated_at: "2026-08-01T00:00:00.000Z" },
  paymentCollection: { ...bundle.payment_collection, updated_at: "2026-08-01T00:00:00.000Z" },
  courseRules: bundle.course_rules.map((entry) => ({ id: `document-${entry.code}`, code: entry.code, title: entry.title, updated_at: "2026-08-01T00:00:00.000Z", body_hash: entry.body_hash })),
};
assert.equal(buildPrivateOperationalConfigImportSql(buildPrivateOperationalConfigImportPlan(bundle, target)), "", "matching singleton configuration is a no-op");
const changed = structuredClone(bundle); changed.center_information.homepage_intro = "Шинэ товч"; changed.course_rules[0] = rule("guardian", "Шинэ журам");
const plan = buildPrivateOperationalConfigImportPlan(changed, target); const sql = buildPrivateOperationalConfigImportSql(plan, "2026-09-01T01:00:00.000Z", () => "test-id");
assert.equal(plan.center.action, "update"); assert.equal(plan.payment.action, "unchanged"); assert.equal(plan.rules.find((entry) => entry.rule.code === "guardian").action, "update");
assert.match(sql, /private_import_guard_failure/); assert.match(sql, /private_operational_center_imported/); assert.match(sql, /private_operational_course_rule_imported/); assert.doesNotMatch(sql, /registration_draft|activity_offering|class_session|registration_window/);
assert.throws(() => validatePrivateOperationalConfigBundle({ ...bundle, course_rules: [bundle.course_rules[0]] }), /exactly two current rules/);
assert.throws(() => validatePrivateOperationalConfigBundle({ ...bundle, course_rules: [{ ...bundle.course_rules[0], body_hash: "0".repeat(64) }, bundle.course_rules[1]] }), /hash is invalid/);
const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-private-operational-config-")); const databasePath = path.join(tempDir, "config.sqlite3");
try {
  const migrations = readdirSync("migrations").filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().map((name) => readFileSync(path.join("migrations", name), "utf8")).join("\n");
  const migrate = spawnSync("sqlite3", [databasePath], { input: `PRAGMA foreign_keys=ON;\n${migrations}`, encoding: "utf8" }); if (migrate.status !== 0) throw new Error(migrate.stderr);
  const rows = (sql) => { const result = spawnSync("sqlite3", ["-json", databasePath], { input: sql, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); return JSON.parse(result.stdout); };
  const localTarget = { centerInformation: rows("SELECT phone, public_email, facebook_page_url, physical_address, homepage_intro, about_center_text, teacher_bio, updated_at FROM public_center_information WHERE singleton=1")[0], paymentCollection: rows("SELECT bank_name, account_holder_name, account_number, iban, transfer_instruction, updated_at FROM payment_collection_settings WHERE singleton=1")[0], courseRules: rows("SELECT document.id, document.code, document.title, document.updated_at, version.body_hash FROM course_rule_document document JOIN course_rule_version version ON version.id=document.current_version_id ORDER BY document.code") };
  const localPlan = buildPrivateOperationalConfigImportPlan(bundle, localTarget); let generatedId = 0; const localSql = buildPrivateOperationalConfigImportSql(localPlan, "2026-09-01T01:00:00.000Z", () => `local-test-${++generatedId}`);
  const sqlPath = path.join(tempDir, "import.sql"); writeFileSync(sqlPath, localSql); const applied = spawnSync("sqlite3", [databasePath], { input: localSql, encoding: "utf8" }); if (applied.status !== 0) throw new Error(applied.stderr);
  assert.equal(buildPrivateOperationalConfigImportSql(buildPrivateOperationalConfigImportPlan(bundle, { centerInformation: rows("SELECT phone, public_email, facebook_page_url, physical_address, homepage_intro, about_center_text, teacher_bio, updated_at FROM public_center_information WHERE singleton=1")[0], paymentCollection: rows("SELECT bank_name, account_holder_name, account_number, iban, transfer_instruction, updated_at FROM payment_collection_settings WHERE singleton=1")[0], courseRules: rows("SELECT document.id, document.code, document.title, document.updated_at, version.body_hash FROM course_rule_document document JOIN course_rule_version version ON version.id=document.current_version_id ORDER BY document.code") }), "2026-09-01T01:00:01.000Z", () => "local-verify"), "", "executed import reaches an exact no-op state");
} finally { rmSync(tempDir, { recursive: true, force: true }); }
console.log("ok private operational config filters singleton content, preserves rule immutability, and excludes operational records");
