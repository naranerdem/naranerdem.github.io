import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(path.join(tmpdir(), "naranerdem-payment-plan-"));
const databasePath = path.join(dir, "payment-plan.sqlite3");
const bundlePath = path.join(dir, "payment-plan-change.mjs");
const reconciliationBundlePath = path.join(dir, "payment-reconciliation.mjs");
const now = "2026-10-05T04:00:00.000Z";

function sql(input, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], {
    input: `.timeout 5000\nPRAGMA foreign_keys=ON;\n${input}`, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stderr}\n${input}`);
  return result.stdout.trim();
}
function value(input) {
  if (input == null) return "NULL";
  if (typeof input === "number") return String(input);
  return `'${String(input).replaceAll("'", "''")}'`;
}
function bound(statement, values) {
  let index = 0;
  const text = statement.replaceAll("?", () => value(values[index++]));
  assert.equal(index, values.length, "every D1 placeholder is bound");
  return text;
}
class Statement {
  constructor(database, text) { this.database = database; this.text = text; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.text, this.values)[0] ?? null; }
  async all() { return { results: this.database.query(this.text, this.values) }; }
  async run() { return { meta: { changes: Number(this.database.query(`${this.text}; SELECT changes() AS changes`, this.values).at(-1)?.changes ?? 0) } }; }
}
class SqliteD1 {
  prepare(text) { return new Statement(this, text); }
  query(text, values = []) { const output = sql(`${bound(text, values)};`, true); return output ? JSON.parse(output) : []; }
  async batch(statements) {
    const output = sql(`CREATE TEMP TABLE _changes (n INTEGER, changes INTEGER); BEGIN IMMEDIATE;
${statements.map((statement, index) => `${bound(statement.text, statement.values)}; INSERT INTO _changes VALUES (${index}, changes());`).join("\n")}
COMMIT; SELECT * FROM _changes ORDER BY n;`, true);
    return (output ? JSON.parse(output) : []).map((row) => ({ meta: { changes: Number(row.changes) } }));
  }
}
const env = (DB) => ({ APP_ENV: "staging", DB, EMAIL_ENABLED: "false", STAFF_AUTH_EMAIL_ENABLED: "true" });
const actor = { staffAccountId: "staff", displayName: "Test staff", roles: ["teacher"], capabilities: ["payment.view", "payment.manage", "registration.manage"], sessionId: "test", sessionExpiresAt: now, sessionAbsoluteExpiresAt: now };
const count = (DB, table, where = "1 = 1") => Number(DB.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)[0].count);

function seed(DB) {
  DB.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year', '2026–2027', 'open', 1, 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('staff', 'staff@example.test', 'Test staff', 'active', 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, ends_on, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('source-offering', 'annual_course', 'Stage 1', 'year', 'stage_1', '2026-09-01', '2027-05-31', 1, 'paid', 'active', 1, 'payment-plan', '${now}', '${now}'),
           ('target-offering', 'annual_course', 'Stage 2', 'year', 'stage_2', '2026-09-01', '2027-05-31', 1, 'paid', 'active', 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO offering_course_pricing (activity_offering_id, one_time_amount_mnt, two_installment_enabled, first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at)
    VALUES ('target-offering', 1200000, 1, 650000, 650000, '2027-01-25', '${now}', '${now}');
  INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('source-class', 'year', 'stage_1', '1-р шат · Мягмар 15:00–16:20', 'Мягмар', '15:00', '16:20', 20, 'available', 'source-offering', 1, 1, 'payment-plan', '${now}', '${now}'),
           ('target-class', 'year', 'stage_2', '2-р шат · Ням 10:00–11:20', 'Ням', '10:00', '11:20', 20, 'available', 'target-offering', 1, 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('guardian', 'Test guardian', '99000000', '99000000', 'guardian@example.test', 'guardian@example.test', 'Address', 'active', 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('student', 'Test', 'Learner', 'female', '2015-05-10', 'active', 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, submitted_at, is_test, test_run_id, created_at, updated_at)
    VALUES ('pre-source', 'guardian', 'year', 'completed', '${now}', 1, 'payment-plan', '${now}', '${now}'),
           ('pre-target', 'guardian', 'year', 'completed', '${now}', 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, selected_payment_plan_code, is_test, test_run_id, created_at, updated_at)
    VALUES ('application-source', 'pre-source', 'student', 5, 'new', 'enrolled', 'single', 1, 'payment-plan', '${now}', '${now}'),
           ('application-current', 'pre-target', 'student', 5, 'new', 'enrolled', 'single', 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at, transferred_out_at)
    VALUES ('source-enrollment', 'application-source', 'student', 'year', 'source-class', 'confirmed', '${now}', 1, 'payment-plan', '${now}', '${now}', '${now}'),
           ('enrollment', 'application-current', 'student', 'year', 'target-class', 'confirmed', '${now}', 1, 'payment-plan', '${now}', '${now}', NULL);
  INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, verified_at, expires_at, is_test, test_run_id, created_at, updated_at)
    VALUES ('draft', '${"x".repeat(64)}', 'year', 'Test guardian', 'Parent', '99000000', 'guardian@example.test', 'guardian@example.test', 'Address', 'single', 'rules', 'rules', 'awaiting_initial_payment', '${now}', '2027-01-01T00:00:00.000Z', 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, current_school, returning_status, selected_stage_code, selected_class_session_id, payment_plan_code, initial_payment_amount_mnt, status, is_test, test_run_id, created_at, updated_at, canonical_student_id, canonical_application_child_id, canonical_enrollment_id)
    VALUES ('child', 'draft', 0, 'Test', 'Learner', 'female', '2015-05-10', '5', 'School', 'new', 'stage_1', 'source-class', 'single', 1200000, 'awaiting_initial_payment', 1, 'payment-plan', '${now}', '${now}', 'student', 'application-current', 'enrollment');
  INSERT INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
    VALUES ('request', 'draft', 'NE-PLAN1', '${now}', '${now}', 1, 'payment-plan');
  INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, paid_at, canonical_application_child_id, canonical_enrollment_id, is_test, test_run_id, created_at, updated_at)
    VALUES ('first', 'request', 'child', 1, 'initial', 1200000, '2026-09-12T15:59:59.999Z', '2026-09-12T15:59:59.999Z', 60, '2026-09-12T14:59:59.999Z', 'partially_paid', NULL, 'application-current', 'enrollment', 1, 'payment-plan', '${now}', '${now}');
  INSERT INTO received_payment (id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status, confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id)
    VALUES ('receipt', 'request', 650000, '2026-10-04T03:05:00.000Z', 'staff_manual_bank', 'confirmed', '2026-10-04T03:05:00.000Z', 'receipt-key', '${now}', '${now}', 1, 'payment-plan');
  INSERT INTO payment_confirmation (id, received_payment_id, payment_request_id, status, finalize_after, seat_confirmation_approved, remaining_payment_due_at, finalized_at, created_at, updated_at, is_test, test_run_id)
    VALUES ('confirmation', 'receipt', 'request', 'finalized', '2026-10-04T03:05:00.000Z', 1, '2027-01-15T15:59:59.999Z', '2026-10-04T03:05:00.000Z', '${now}', '${now}', 1, 'payment-plan');
  INSERT INTO payment_allocation (id, received_payment_id, payment_installment_id, allocated_amount_mnt, allocated_at, created_at, is_test, test_run_id)
    VALUES ('allocation', 'receipt', 'first', 650000, '2026-10-04T03:05:00.000Z', '${now}', 1, 'payment-plan');
  INSERT INTO class_transfer (id, source_enrollment_id, source_application_child_id, target_enrollment_id, target_application_child_id, source_class_session_id, target_class_session_id, reason, created_by_staff_account_id, idempotency_key, source_payment_plan_code, target_payment_plan_code, source_pricing_snapshot_json, target_pricing_snapshot_json, source_effective_charge_mnt, target_effective_charge_mnt, recognized_paid_mnt, required_difference_mnt, resulting_credit_mnt, status, version, created_at, updated_at, completed_at, is_test, test_run_id)
    VALUES ('transfer', 'source-enrollment', 'application-source', 'enrollment', 'application-current', 'source-class', 'target-class', 'Completed test transfer', 'staff', 'transfer-key', 'single', 'single', '{}', '{}', 1200000, 1200000, 650000, 0, 0, 'completed', 1, '${now}', '${now}', '${now}', 1, 'payment-plan');`);
}

try {
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort().map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n");
  sql(migrations);
  for (const [source, output] of [["src/server/staff/payment-plan-change.ts", bundlePath], ["src/server/staff/payment-reconciliation.ts", reconciliationBundlePath]]) {
    const build = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(build.stderr);
  }
  const { PaymentPlanChangeError, previewEnrollmentPaymentPlanChange, reviseEnrollmentPaymentPlan } = await import(pathToFileURL(bundlePath).href);
  const { getInitialPaymentQueue, recordManualPayment } = await import(pathToFileURL(reconciliationBundlePath).href);
  const DB = new SqliteD1(); seed(DB);
  const preview = await previewEnrollmentPaymentPlanChange(env(DB), actor, { paymentRequestId: "request", registrationDraftChildId: "child", proposedPaymentPlanCode: "two_installment", reason: "Stage 2 agreement" });
  assert.equal(preview.previousTotalMnt, 1200000, "the original agreement is preserved in review");
  assert.equal(preview.proposedTotalMnt, 1300000, "the Stage 2 two-payment policy is authoritative");
  assert.equal(preview.paidMnt, 650000, "the finalized receipt remains cash received exactly once");
  assert.equal(preview.proposedOutstandingMnt, 650000, "only the second policy installment remains unpaid");
  assert.equal(preview.currentRemainingDueAt, "2027-01-15T15:59:59.999Z", "the effective approved remaining deadline, not the historical initial due date, is loaded");
  assert.equal(preview.policyRemainingDueAt, "2027-01-25T15:59:59.999Z", "the stage policy deadline remains visible but is not silently applied");
  assert.deepEqual(preview.proposedInstallments.map((entry) => [entry.amountMnt, entry.dueAt]), [[650000, "2026-09-12T15:59:59.999Z"], [650000, "2027-01-15T15:59:59.999Z"]], "an existing approved deadline is preserved by default when it differs from policy");
  DB.query("UPDATE offering_course_pricing SET updated_at = '2026-10-05T04:01:00.000Z' WHERE activity_offering_id = 'target-offering'");
  await assert.rejects(
    () => reviseEnrollmentPaymentPlan(env(DB), actor, {
      paymentRequestId: "request", registrationDraftChildId: "child", proposedPaymentPlanCode: "two_installment",
      reason: "Stage 2 agreement", reviewFingerprint: preview.reviewFingerprint,
      operationId: "e0000000-0000-4000-8000-000000000000",
    }, new Date(now)),
    (error) => error instanceof PaymentPlanChangeError && error.code === "conflict",
    "a policy revision after review rejects the whole agreement change before any write",
  );
  assert.equal(count(DB, "enrollment_payment_agreement_revision"), 0, "a stale review leaves no audit header or replacement installment");
  const refreshedPreview = await previewEnrollmentPaymentPlanChange(env(DB), actor, { paymentRequestId: "request", registrationDraftChildId: "child", proposedPaymentPlanCode: "two_installment", proposedRemainingDueAt: "2027-01-25T15:59:59.999Z", reason: "Stage 2 agreement" });
  assert.equal(refreshedPreview.currentRemainingDueAt, "2027-01-15T15:59:59.999Z", "review retains the previous agreed deadline for audit");
  assert.equal(refreshedPreview.proposedRemainingDueAt, "2027-01-25T15:59:59.999Z", "a teacher-reviewed deadline change is explicit");
  const operationId = "e1010101-1010-4101-8101-101010101010";
  const saved = await reviseEnrollmentPaymentPlan(env(DB), actor, { paymentRequestId: "request", registrationDraftChildId: "child", proposedPaymentPlanCode: "two_installment", proposedRemainingDueAt: "2027-01-25T15:59:59.999Z", reason: "Stage 2 agreement", reviewFingerprint: refreshedPreview.reviewFingerprint, operationId }, new Date(now));
  assert.equal(saved.idempotent, false, "the reviewed agreement is saved once");
  assert.deepEqual(DB.query(`SELECT amount_mnt AS amountMnt, effective_due_at AS dueAt, status FROM payment_installment WHERE registration_draft_child_id = 'child' ORDER BY installment_number`).map((row) => [Number(row.amountMnt), row.dueAt, row.status]), [[650000, "2026-09-12T15:59:59.999Z", "paid"], [650000, "2027-01-25T15:59:59.999Z", "pending"]], "the active agreement replaces the single unpaid portion without rewriting the receipt");
  assert.equal(Number(DB.query(`SELECT received_amount_mnt AS amount FROM received_payment WHERE id = 'receipt'`)[0].amount), 650000, "cash receipt stays immutable");
  assert.equal(Number(DB.query(`SELECT allocated_amount_mnt AS amount FROM payment_allocation WHERE id = 'allocation'`)[0].amount), 650000, "receipt allocation stays immutable");
  assert.equal(count(DB, "enrollment_payment_agreement_revision"), 1, "an immutable agreement header is recorded");
  assert.equal(count(DB, "enrollment_payment_agreement_revision_entry"), 3, "old and proposed installments are retained for audit");
  assert.equal(DB.query(`SELECT remaining_payment_due_at AS dueAt FROM payment_confirmation WHERE id = 'confirmation'`)[0].dueAt, "2027-01-25T15:59:59.999Z", "the effective payment deadline follows the reviewed agreement instead of retaining stale approval data");
  const revision = DB.query(`SELECT previous_pricing_snapshot_json AS previousSnapshot, proposed_pricing_snapshot_json AS proposedSnapshot FROM enrollment_payment_agreement_revision`)[0];
  assert.equal(JSON.parse(revision.previousSnapshot).effectiveRemainingDueAt, "2027-01-15T15:59:59.999Z", "the prior effective deadline remains in immutable history");
  assert.equal(JSON.parse(revision.proposedSnapshot).proposedRemainingDueAt, "2027-01-25T15:59:59.999Z", "the explicit new deadline remains in immutable history");
  assert.equal(count(DB, "payment_notification_milestone", "registration_draft_child_id = 'child' AND milestone_type = 'partial_balance_reminder' AND status != 'cancelled'"), 0, "stale partial-balance reminders are cancelled before the new schedule is used");
  const queued = await getInitialPaymentQueue(env(DB), actor, new Date("2026-10-06T04:00:00.000Z"));
  const changedItem = queued.items.find((item) => item.registrationDraftChildId === "child");
  assert.equal(changedItem?.paymentPlanCode, "two_installment", "payment entry uses the effective agreement rather than the historical intake choice");
  assert.equal(changedItem?.remainingPaymentDueAt, "2027-01-25T15:59:59.999Z", "Payments reads the revised child-scoped agreement deadline");
  assert.equal(changedItem?.nextScheduledInstallment?.amountMnt, 650000, "the ordinary later-payment control targets the new unpaid installment");
  const laterPayment = await recordManualPayment(env(DB), actor, { paymentRequestId: "request", allocations: [{ installmentId: changedItem.nextScheduledInstallment.id, amountMnt: 650000 }], source: "staff_manual_bank", idempotencyKey: "later-plan-payment" }, new Date("2027-01-25T12:00:00.000Z"));
  assert.ok(laterPayment.id, "the ordinary later-payment path settles the revised second installment");
  assert.equal((await recordManualPayment(env(DB), actor, { paymentRequestId: "request", allocations: [{ installmentId: changedItem.nextScheduledInstallment.id, amountMnt: 650000 }], source: "staff_manual_bank", idempotencyKey: "later-plan-payment" }, new Date("2027-01-25T12:01:00.000Z"))).idempotent, true, "a lost-response retry cannot duplicate the later payment");
  const retry = await reviseEnrollmentPaymentPlan(env(DB), actor, { paymentRequestId: "request", registrationDraftChildId: "child", proposedPaymentPlanCode: "two_installment", proposedRemainingDueAt: "2027-01-25T15:59:59.999Z", reason: "Stage 2 agreement", reviewFingerprint: refreshedPreview.reviewFingerprint, operationId }, new Date(now));
  assert.deepEqual(retry, { operationId, idempotent: true }, "a lost response cannot duplicate installments or the agreement revision");
  assert.equal(count(DB, "payment_installment", "registration_draft_child_id = 'child'"), 2, "retry leaves exactly one later installment");
  const stale = await previewEnrollmentPaymentPlanChange(env(DB), actor, { paymentRequestId: "request", registrationDraftChildId: "child", proposedPaymentPlanCode: "two_installment", reason: "Stage 2 agreement" }).catch(() => null);
  assert.equal(stale, null, "a completed plan cannot be silently changed again by this focused workflow");
  console.log("ok payment-plan change preserves transferred agreement, audit, and retry safety");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
