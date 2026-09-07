import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "naranerdem-staff-intake-email-"));
const dbPath = path.join(dir, "reminders.sqlite3");
const bundle = path.join(dir, "payment-reminders.mjs");
const now = "2026-09-03T02:00:00.000Z";

function sql(source, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", dbPath] : [dbPath], { input: `PRAGMA foreign_keys=ON;\n${source}`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function quote(value) { return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
function bind(statement, values) { let index = 0; const result = statement.replaceAll("?", () => quote(values[index++])); assert.equal(index, values.length); return result; }
class Statement {
  constructor(database, statement) { this.database = database; this.statement = statement; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.statement, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.statement, this.values) }; }
  async run() { const rows = this.database.query(`${this.statement}; SELECT changes() AS changes`, this.values); return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } }; }
}
class Database {
  prepare(statement) { return new Statement(this, statement); }
  query(statement, values = []) { const result = sql(`${bind(statement, values)};`, true); return result ? JSON.parse(result) : []; }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}
function env(DB) {
  return { APP_ENV: "staging", EMAIL_ENABLED: "true", RESEND_API_KEY: "test-key", EMAIL_FROM: "Наран Эрдэм <burtgel@example.test>",
    STAGING_EMAIL_OVERRIDE_TO: "safe@example.test", DB };
}
function seedDraft(database, id, staffAssisted) {
  database.query(`INSERT INTO registration_draft (
    id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email,
    home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 'year', 'Тест Асран', 'Ээж', '99000000', ?, ?, 'Тест хаяг', 'single', 'parent-rule', 'student-rule', 'awaiting_initial_payment', '2026-09-04T02:00:00.000Z', 1, 'staff-intake-email-test', ?, ?)`,
  [id, `${id}-hash`.padEnd(64, "0"), `${id}@example.test`, `${id}@example.test`, now, now]);
  database.query(`INSERT INTO registration_draft_child (
    id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status,
    selected_stage_code, selected_class_session_id, status, initial_payment_amount_mnt, payment_plan_code, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 0, 'Тест', ?, 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class', 'awaiting_initial_payment', 1200000, 'single', 1, 'staff-intake-email-test', ?, ?)`,
  [`${id}-child`, id, id, now, now]);
  database.query(`INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, 'class', 'initial_payment', 'active', '2026-09-03T03:00:00.000Z', 1, 'staff-intake-email-test', ?, ?)`, [`${id}-hold`, `${id}-child`, now, now]);
  database.query(`INSERT INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
    VALUES (?, ?, ?, ?, ?, 1, 'staff-intake-email-test')`, [`${id}-request`, id, `NE-${id.toUpperCase()}`, now, now]);
  database.query(`INSERT INTO payment_installment (
    id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt,
    original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, 1, 'initial', 1200000, '2026-09-04T02:00:00.000Z', '2026-09-04T02:00:00.000Z', 360, ?, 'pending', ?, ?, 1, 'staff-intake-email-test')`,
  [`${id}-installment`, `${id}-request`, `${id}-child`, now, now, now]);
  if (staffAssisted) {
    database.query(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at)
      VALUES (?, ?, 'staff', 'staff-teacher', 'registration.created_by_staff', 'registration_draft', ?, ?, 'staging', 1, 'staff-intake-email-test', ?)`,
    [`${id}-staff-audit`, now, id, JSON.stringify({ source: "staff_assisted", receiptRequested: false }), now]);
  }
}

try {
  sql(readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort().map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const build = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/payment-reminders.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
  const { processDuePaymentReminders } = await import(pathToFileURL(bundle).href);
  const database = new Database();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at) VALUES ('year', 'Тест', 'open', 1, 1, 'staff-intake-email-test', ?, ?);
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at) VALUES ('offering', 'annual_course', 'Тест сургалт', 'year', 'stage_1', 1, 'paid', 'active', 1, 'staff-intake-email-test', ?, ?);
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at) VALUES ('class', 'offering', 'year', 'stage_1', 'Тест анги', 'Мягмар', '09:00', '10:20', 10, 'available', 1, 1, 'staff-intake-email-test', ?, ?);
    UPDATE payment_collection_settings SET bank_name = 'Тест банк', account_holder_name = 'Тест эзэмшигч', account_number = '0000000000', updated_at = ? WHERE singleton = 1;`, [now, now, now, now, now, now, now]);
  seedDraft(database, "public", false);
  seedDraft(database, "staff", true);
  const sent = [];
  const provider = { async send(message) { sent.push(message); return { providerMessageId: `provider-${sent.length}` }; } };
  assert.equal(await processDuePaymentReminders(env(database), new Date(now), provider), 2, "a receipt-unchecked staff intake receives the same due reminder processing as an equivalent public registration");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM payment_notification_milestone WHERE registration_draft_id = 'public' AND milestone_type = 'initial_reminder'")[0].count, 1);
  assert.equal(database.query("SELECT COUNT(*) AS count FROM payment_notification_milestone WHERE registration_draft_id = 'staff' AND milestone_type = 'initial_reminder'")[0].count, 1);
  assert.equal(database.query("SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = 'staff' AND event_type = 'payment_initial_reminder'")[0].count, 1, "staff receipt preference is not a permanent email opt-out");
  assert.equal(sent.length, 2, "each logical reminder is delivered once through the normal staging-safe path");
  assert.equal(await processDuePaymentReminders(env(database), new Date(now), provider), 0, "reminder processing is idempotent after delivery");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = 'staff' AND event_type = 'payment_initial_reminder'")[0].count, 1, "reminder replay does not duplicate the Outbox row");
  console.log("ok staff intake receipt preference leaves ordinary payment reminders enabled");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
