import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "naranerdem-registration-transactional-email-"));
const dbPath = path.join(dir, "email.sqlite3");
const bundle = path.join(dir, "registration-transactional.mjs");
const verificationBundle = path.join(dir, "email-verification.mjs");
const routerSource = readFileSync("src/server/api/router.ts", "utf8");

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

function now() { return "2026-09-03T02:00:00.000Z"; }
function env(database) {
  return {
    APP_ENV: "staging", EMAIL_ENABLED: "true", AUTH_EMAIL_ENABLED: "false", REGISTRATION_WRITE_ENABLED: "true",
    APP_ORIGIN: "https://staging.example.test", EMAIL_FROM: "Наран Эрдэм <burtgel@example.test>", RESEND_API_KEY: "test-key",
    STAGING_EMAIL_OVERRIDE_TO: "safe@example.test", STAGING_EMAIL_ARCHIVE_BCC_TO: "archive@example.test", DB: database,
  };
}

function seedDraft(database, id, email = `${id}@example.test`) {
  database.query(`INSERT INTO registration_draft (
    id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email,
    home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 'year', 'Тест Асран', 'Ээж', '99000000', ?, ?, 'Тест хаяг', 'single', 'parent-rule', 'student-rule', 'awaiting_initial_payment', '2026-09-04T02:00:00.000Z', 1, 'email-test', ?, ?)`,
  [id, `${id}-hash`.padEnd(64, "0"), email, email, now(), now()]);
  database.query(`INSERT INTO registration_draft_child (
    id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status,
    selected_stage_code, selected_class_session_id, status, initial_payment_amount_mnt, payment_plan_code, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 0, 'Тест', 'Хүүхэд', 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class', 'awaiting_initial_payment', 1200000, 'single', 1, 'email-test', ?, ?)`,
  [`${id}-child`, id, now(), now()]);
  database.query(`INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, 'class', 'initial_payment', 'active', '2026-09-03T03:00:00.000Z', 1, 'email-test', ?, ?)`, [`${id}-hold`, `${id}-child`, now(), now()]);
  database.query(`INSERT INTO payment_request (id, registration_draft_id, payment_reference, transfer_description, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, 'Хүүхэд 99000000', 1, 'email-test', ?, ?)`, [`${id}-request`, id, `NE-${id.toUpperCase()}`, now(), now()]);
  database.query(`INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, status, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'initial', 1200000, '2026-09-03T03:00:00.000Z', '2026-09-03T03:00:00.000Z', 'pending', 1, 'email-test', ?, ?)`, [`${id}-installment`, `${id}-request`, `${id}-child`, now(), now()]);
}

try {
  sql(readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort().map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const build = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/email/registration-transactional.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
  const verificationBuild = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/auth/email-verification.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${verificationBundle}`], { encoding: "utf8" });
  if (verificationBuild.status !== 0) throw new Error(verificationBuild.stderr);
  const { sendRegistrationReceipt, sendPaymentConfirmedEmail } = await import(pathToFileURL(bundle).href);
  const { startEmailVerification, EmailVerificationError } = await import(pathToFileURL(verificationBundle).href);
  const database = new Database();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at) VALUES ('year', 'Тест', 'open', 1, 1, 'email-test', ?, ?);
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at) VALUES ('offering', 'annual_course', 'Тест сургалт', 'year', 'stage_1', 1, 'paid', 'active', 1, 'email-test', ?, ?);
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at) VALUES ('class', 'offering', 'year', 'stage_1', 'Тест анги', 'Мягмар', '09:00', '10:20', 10, 'available', 1, 1, 'email-test', ?, ?);
    UPDATE payment_collection_settings SET bank_name = 'Тест банк', account_holder_name = 'Тест эзэмшигч', account_number = '0000000000', updated_at = ? WHERE singleton = 1;`,
  [now(), now(), now(), now(), now(), now(), now()]);
  seedDraft(database, "receipt");
  const messages = [];
  const provider = { async send(message, options) { messages.push({ message, options }); return { providerMessageId: `provider-${messages.length}` }; } };
  assert.equal(await sendRegistrationReceipt(env(database), "receipt", provider), true, "EMAIL_ENABLED sends an ordinary registration receipt even when auth email is disabled");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.to, "safe@example.test", "staging delivery remains safely overridden");
  assert.deepEqual(messages[0].message.bcc, ["archive@example.test"], "the ordinary receipt is archive-BCC safe");
  assert.match(messages[0].message.text, /Таны хүүхдийн мэдээлэл бүртгэгдлээ\./);
  assert.match(messages[0].message.text, /Төлбөр хийгдсэнээр таны хүүхдийн бүртгэл баталгаажна\./);
  assert.doesNotMatch(messages[0].message.text, /эхний төлбөр/i, "a single-payment receipt is plan-neutral");
  assert.doesNotMatch(messages[0].message.text, /verify-email|token=/i, "receipt contains no capability link");
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'receipt:registration-receipt'")[0].status, "sent");
  assert.equal(database.query("SELECT email_sensitivity AS sensitivity FROM outbound_email WHERE id = 'receipt:registration-receipt'")[0].sensitivity, "archive_bcc_safe");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM email_verification_challenge")[0].count, 0, "receipt creates no verification challenge");
  await sendRegistrationReceipt(env(database), "receipt", provider);
  assert.equal(messages.length, 1, "receipt retries are idempotent after success");
  assert.equal(await sendPaymentConfirmedEmail(env(database), "receipt", provider), true, "payment confirmation is also independent of auth email");
  assert.equal(messages.length, 2);
  assert.match(messages[1].message.text, /Таны төлбөрийг хүлээн авч баталгаажууллаа\./);
  assert.doesNotMatch(messages[1].message.text, /эхний төлбөр/i, "payment confirmation is plan-neutral");
  assert.equal(database.query("SELECT status FROM outbound_email WHERE event_type = 'registration_initial_payment_confirmed'")[0].status, "sent");
  seedDraft(database, "failure");
  const failingProvider = { async send() { throw new Error("provider unavailable"); } };
  await assert.rejects(sendRegistrationReceipt(env(database), "failure", failingProvider), /Transactional email delivery failed/);
  assert.equal(database.query("SELECT status FROM registration_draft WHERE id = 'failure'")[0].status, "awaiting_initial_payment", "delivery failure does not undo accepted registration");
  assert.equal(database.query("SELECT status FROM registration_capacity_hold WHERE id = 'failure-hold'")[0].status, "active", "delivery failure does not release the seat");
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'failure:registration-receipt'")[0].status, "failed", "provider failure remains auditable");
  const retryProvider = { async send(message, options) { messages.push({ message, options }); return { providerMessageId: "provider-retry" }; } };
  assert.equal(await sendRegistrationReceipt(env(database), "failure", retryProvider), true, "an idempotent registration replay may retry a previously failed receipt");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM outbound_email WHERE id = 'failure:registration-receipt'")[0].count, 1, "a retry keeps one logical receipt record");
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'failure:registration-receipt'")[0].status, "sent");
  await assert.rejects(startEmailVerification(env(database), "parent@example.test"), (error) => error instanceof EmailVerificationError || error.code === "auth_email_disabled", "optional verification remains unavailable when auth email is disabled");
  assert.match(routerSource, /if \(!authEmailAvailable\(env\)\) return authNotFound\(\);/, "verification resend/change routes fail closed when optional auth email is disabled");
  console.log("ok ordinary registration/payment email is independent of optional parent authentication");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
