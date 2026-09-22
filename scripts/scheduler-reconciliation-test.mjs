import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = mkdtempSync(path.join(tmpdir(), "naranerdem-scheduler-reconciliation-"));
const databasePath = path.join(directory, "scheduler.sqlite3");
const reminderBundle = path.join(directory, "payment-reminders.mjs");
const capacityBundle = path.join(directory, "class-capacity.mjs");
const now = new Date("2026-09-21T02:00:00.000Z");
const stamp = now.toISOString();

function sql(source, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], {
    input: `PRAGMA foreign_keys=ON;\n${source}`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stderr}\n${source}`);
  return result.stdout.trim();
}
function quote(value) { return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
function bind(statement, values) {
  let index = 0;
  const result = statement.replaceAll("?", () => quote(values[index++]));
  assert.equal(index, values.length, "all bindings are consumed");
  return result;
}
class Statement {
  constructor(database, statement) { this.database = database; this.statement = statement; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.statement, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.statement, this.values) }; }
  async run() {
    const rows = this.database.query(`${this.statement}; SELECT changes() AS changes`, this.values);
    return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } };
  }
}
class Database {
  constructor() { this.executedQueries = []; }
  prepare(statement) { return new Statement(this, statement); }
  query(statement, values = []) {
    this.executedQueries.push({ statement, values });
    const result = sql(`${bind(statement, values)};`, true);
    return result ? JSON.parse(result) : [];
  }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
  resetQueries() { this.executedQueries.length = 0; }
}
function env(DB) {
  return {
    APP_ENV: "staging", EMAIL_ENABLED: "true", RESEND_API_KEY: "test-key",
    EMAIL_FROM: "Naran Erdem <scheduler@example.test>", STAGING_EMAIL_OVERRIDE_TO: "safe@example.test", DB,
  };
}

function seedRequest(database, sequence, { due = false, canonicalStudentId = null } = {}) {
  const id = `history-${String(sequence).padStart(3, "0")}`;
  const request = `${id}-request`;
  const child = `${id}-child`;
  const dueAt = due ? stamp : "2026-10-01T02:00:00.000Z";
  database.query(`INSERT INTO registration_draft (
    id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email,
    home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 'year', 'Scheduler guardian', 'Ээж', '99000000', ?, ?, 'Address', 'single', 'parent-rule', 'student-rule', 'awaiting_initial_payment', '2026-10-02T02:00:00.000Z', 1, 'scheduler-test', ?, ?)`,
  [id, `${id}-hash`.padEnd(64, "0"), `${id}@example.test`, `${id}@example.test`, stamp, stamp]);
  database.query(`INSERT INTO registration_draft_child (
    id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status,
    selected_stage_code, selected_class_session_id, status, initial_payment_amount_mnt, payment_plan_code, canonical_student_id,
    is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 0, 'Scheduler', ?, 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'active-class',
    'awaiting_initial_payment', 1200000, 'single', ?, 1, 'scheduler-test', ?, ?)`,
  [child, id, id, canonicalStudentId, stamp, stamp]);
  database.query(`INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, 'active-class', 'initial_payment', 'active', '2026-10-02T02:00:00.000Z', 1, 'scheduler-test', ?, ?)`,
  [`${id}-hold`, child, stamp, stamp]);
  database.query(`INSERT INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
    VALUES (?, ?, ?, ?, ?, 1, 'scheduler-test')`, [request, id, `NE-SCHED-${sequence}`, stamp, stamp]);
  database.query(`INSERT INTO payment_installment (
    id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt,
    original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, 1, 'initial', 1200000, ?, ?, 360, ?, 'pending', ?, ?, 1, 'scheduler-test')`,
  [`${id}-installment`, request, child, dueAt, dueAt, dueAt, stamp, stamp]);
  return { id, request, child };
}

try {
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  const queueMigration = "0064_scheduler_reconciliation_queues.sql";
  assert.ok(migrations.includes(queueMigration), "the scheduler queue migration is present");
  sql(migrations.filter((file) => file < queueMigration).map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const database = new Database();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year', 'Test year', 'open', 1, 1, 'scheduler-test', ?, ?);
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('offering', 'annual_course', 'Scheduler course', 'year', 'stage_1', 1, 'paid', 'active', 1, 'scheduler-test', ?, ?);
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, schedule_state, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('active-class', 'offering', 'year', 'stage_1', 'Active', 'Мягмар', '09:00', '10:20', 10, 'available', 'active', 1, 1, 'scheduler-test', ?, ?),
      ('removed-class', 'offering', 'year', 'stage_1', 'Removed', 'Лхагва', '09:00', '10:20', 10, 'closed', 'removed', 1, 1, 'scheduler-test', ?, ?);
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('credit-student', 'Credit', 'Student', 'not_specified', '2015-01-01', 'active', 1, 'scheduler-test', ?, ?);
    UPDATE payment_collection_settings SET bank_name = 'Test bank', account_holder_name = 'Test holder', account_number = '0000000000', updated_at = ? WHERE singleton = 1;`,
  [stamp, stamp, stamp, stamp, stamp, stamp, stamp, stamp, stamp, stamp, stamp]);
  const due = seedRequest(database, 0, { due: true });
  const credit = seedRequest(database, 1, { canonicalStudentId: "credit-student" });
  for (let index = 2; index < 98; index += 1) seedRequest(database, index);
  database.query(`INSERT INTO received_payment (id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status, confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id)
    VALUES ('credit-receipt', ?, 120000, ?, 'staff_manual_bank', 'confirmed', ?, 'credit-receipt-key', ?, ?, 1, 'scheduler-test');
    INSERT INTO payment_credit (id, received_payment_id, payment_request_id, available_amount_mnt, status, created_at, updated_at, is_test, test_run_id)
    VALUES ('credit-root', 'credit-receipt', ?, 120000, 'available', ?, ?, 1, 'scheduler-test');`,
  [credit.request, stamp, stamp, stamp, stamp, credit.request, stamp, stamp]);

  sql(readFileSync(path.join("migrations", queueMigration), "utf8"));
  assert.equal(Number(database.query("SELECT COUNT(*) AS count FROM child_credit_entry")[0].count), 0,
    "migration only creates queues and cursors; it does not reconcile financial rows");
  const plan = sql(`EXPLAIN QUERY PLAN SELECT payment_request_id FROM payment_milestone_reconciliation_queue
    WHERE status = 'pending' ORDER BY priority, updated_at, payment_request_id LIMIT 32;`);
  assert.match(plan, /USING COVERING INDEX idx_payment_milestone_reconciliation_queue_pending/, "queue claim uses its full pending-work index");
  const creditSweepPlan = sql(`EXPLAIN QUERY PLAN SELECT DISTINCT child.canonical_student_id
    FROM registration_draft_child AS child
    WHERE child.canonical_student_id IS NOT NULL AND child.canonical_student_id > ''
      AND EXISTS (
        SELECT 1 FROM payment_installment
        INNER JOIN payment_credit ON payment_credit.payment_request_id = payment_installment.payment_request_id
        WHERE payment_installment.registration_draft_child_id = child.id
          AND payment_installment.installment_kind = 'initial'
      )
    ORDER BY child.canonical_student_id LIMIT 32;`);
  assert.match(creditSweepPlan, /idx_registration_draft_child_canonical_student/, "credit catch-up advances through canonical owners by index");
  const transferSweepPlan = sql(`EXPLAIN QUERY PLAN SELECT DISTINCT enrollment.student_id
    FROM enrollment
    INNER JOIN class_transfer ON class_transfer.source_enrollment_id = enrollment.id
    INNER JOIN class_transfer_credit ON class_transfer_credit.class_transfer_id = class_transfer.id
    WHERE enrollment.student_id > '' ORDER BY enrollment.student_id LIMIT 32;`);
  assert.match(transferSweepPlan, /idx_enrollment_student_for_credit_reconciliation/, "transfer catch-up advances through learners by index");

  const build = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/payment-reminders.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${reminderBundle}`], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
  const capacityBuild = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/services/class-capacity.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${capacityBundle}`], { encoding: "utf8" });
  if (capacityBuild.status !== 0) throw new Error(capacityBuild.stderr);
  const { processDuePaymentReminders } = await import(pathToFileURL(reminderBundle).href);
  const { getClassCapacityProjections } = await import(pathToFileURL(capacityBundle).href);
  const sent = [];
  const provider = { async send(message) { sent.push(message); return { providerMessageId: `provider-${sent.length}` }; } };

  const catchupStartedAt = performance.now();
  for (let tick = 0; tick < 5; tick += 1) await processDuePaymentReminders(env(database), new Date(now.getTime() + tick * 60_000), provider);
  const catchupMillis = performance.now() - catchupStartedAt;
  assert.equal(Number(database.query("SELECT COUNT(*) AS count FROM scheduler_reconciliation_sweep WHERE completed_at IS NULL")[0].count), 0,
    "one-time catch-up advances in bounded batches and completes durably");
  assert.equal(Number(database.query("SELECT COUNT(*) AS count FROM child_credit_entry WHERE source_payment_credit_id = 'credit-root'")[0].count), 1,
    "pre-existing available credit is mirrored once during bounded catch-up");
  assert.equal(sent.length, 1, "the due reminder is delivered once while catch-up is progressing");
  assert.equal(Number(database.query(`SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = ?`, [due.id])[0].count), 1,
    "the due milestone retains one durable Outbox identity across reconciliation retries");

  database.resetQueries();
  const idleStartedAt = performance.now();
  await processDuePaymentReminders(env(database), new Date(now.getTime() + 10 * 60_000), provider);
  const idleMillis = performance.now() - idleStartedAt;
  const idleQueries = database.executedQueries.map((entry) => entry.statement);
  assert.ok(!idleQueries.some((statement) => statement.includes("INSERT OR IGNORE INTO child_credit_entry")),
    "idle ticks do not replay the global legacy-credit reconciliation");
  assert.ok(!idleQueries.some((statement) => statement.includes("INSERT OR IGNORE INTO payment_notification_milestone")),
    "idle ticks do not recreate milestones across payment history");
  assert.equal(sent.length, 1, "an idle replay does not duplicate delivery");

  database.query(`UPDATE payment_credit SET status = 'refunded', refunded_at = ?, updated_at = ? WHERE id = 'credit-root'`, [stamp, stamp]);
  assert.equal(database.query("SELECT status FROM child_credit_reconciliation_queue WHERE canonical_student_id = 'credit-student'")[0].status, "pending",
    "a changed legacy credit is queued by the database write path");
  await processDuePaymentReminders(env(database), new Date(now.getTime() + 11 * 60_000), provider);
  assert.equal(Number(database.query(`SELECT COUNT(*) AS count FROM child_credit_entry WHERE origin_entry_id = 'child-credit:payment:credit-root' AND entry_kind = 'refund'`)[0].count), 1,
    "changed credit reaches the ledger before subsequent due decisions");

  database.query(`UPDATE payment_installment SET reminder_at = '2026-10-03T02:00:00.000Z', updated_at = ?
    WHERE payment_request_id = 'history-002-request'`, [stamp]);
  assert.equal(database.query(`SELECT status FROM payment_milestone_reconciliation_queue
    WHERE payment_request_id = 'history-002-request'`)[0].status, "pending",
  "a corrected installment is queued instead of depending on a historical sweep");
  await processDuePaymentReminders(env(database), new Date(now.getTime() + 12 * 60_000), provider);
  database.query(`UPDATE registration_draft SET status = 'cancelled', updated_at = ? WHERE id = 'history-002'`, [stamp]);
  assert.equal(database.query(`SELECT status FROM payment_milestone_reconciliation_queue
    WHERE payment_request_id = 'history-002-request'`)[0].status, "pending",
  "a cancellation itself requeues the affected request");
  await processDuePaymentReminders(env(database), new Date(now.getTime() + 13 * 60_000), provider);
  assert.equal(database.query(`SELECT status FROM payment_milestone_reconciliation_queue
    WHERE payment_request_id = 'history-002-request'`)[0].status, "completed",
  "a cancellation queue item is consumed without needing a full-history milestone sweep");

  database.query(`UPDATE payment_milestone_reconciliation_queue
    SET status = 'processing', lease_expires_at = '2026-09-21T01:00:00.000Z', revision = revision + 1
    WHERE payment_request_id = ?`, [due.request]);
  await processDuePaymentReminders(env(database), new Date(now.getTime() + 14 * 60_000), provider);
  assert.equal(database.query("SELECT status FROM payment_milestone_reconciliation_queue WHERE payment_request_id = ?", [due.request])[0].status, "completed",
    "an interrupted claim is recovered without duplicate milestones or delivery");

  const overlap = seedRequest(database, 99);
  database.resetQueries();
  await Promise.all([
    processDuePaymentReminders(env(database), new Date(now.getTime() + 15 * 60_000), provider),
    processDuePaymentReminders(env(database), new Date(now.getTime() + 15 * 60_000), provider),
  ]);
  assert.equal(database.executedQueries.filter((entry) => entry.statement.includes("INSERT OR IGNORE INTO payment_notification_milestone")).length, 4,
    "two overlapping ticks claim one request once before its four scoped milestone writes");
  assert.equal(database.query(`SELECT status FROM payment_milestone_reconciliation_queue WHERE payment_request_id = ?`, [overlap.request])[0].status, "completed",
    "the overlapping claim converges on one durable completed queue item");

  const allClasses = await getClassCapacityProjections(database, "staging", now);
  const operationalClasses = await getClassCapacityProjections(database, "staging", now, undefined, { operationalOnly: true });
  assert.equal(allClasses.length, 2, "historical/reporting callers can still request removed classes");
  assert.deepEqual(operationalClasses.map((entry) => entry.classSessionId), ["active-class"],
    "background operational capacity projection omits removed classes");
  console.log(`scheduler local timing: catch-up 98 requests in ${catchupMillis.toFixed(1)}ms; idle ${idleMillis.toFixed(1)}ms`);
  console.log(`scheduler idle prepared queries: ${idleQueries.length}; catch-up requests: 98; queue plan: ${plan.replaceAll("\n", " | ")}`);
  console.log(`scheduler sweep plans: credit ${creditSweepPlan.replaceAll("\n", " | ")}; transfer ${transferSweepPlan.replaceAll("\n", " | ")}`);
  console.log("ok bounded scheduler reconciliation, due reminder delivery, credit recovery, interrupted claims, and inactive capacity filtering");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
