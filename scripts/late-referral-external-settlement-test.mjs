import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-late-referral-"));
const databasePath = path.join(tempDir, "late-referral.sqlite3");
const serviceBundlePath = path.join(tempDir, "late-referral-service.mjs");
const discountBundlePath = path.join(tempDir, "discounts.mjs");
const now = "2026-10-01T04:00:00.000Z";

function sqlite(input, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], {
    input: `.timeout 5000\nPRAGMA foreign_keys=ON;\n${input}`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stderr}\n${input}`);
  return result.stdout.trim();
}

function sqlValue(value) {
  if (value == null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSql(sql, values) {
  let index = 0;
  const result = sql.replaceAll("?", () => sqlValue(values[index++]));
  assert.equal(index, values.length, "every prepared value is bound");
  return result;
}

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.sql, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.sql, this.values) }; }
  async run() {
    const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values);
    return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } };
  }
}

class SqliteD1 {
  prepare(sql) { return new Statement(this, sql); }
  query(sql, values = []) { const output = sqlite(`${bindSql(sql, values)};`, true); return output ? JSON.parse(output) : []; }
  async batch(statements) {
    const result = sqlite(`CREATE TEMP TABLE _batch_changes (idx INTEGER, changes INTEGER); BEGIN IMMEDIATE;
${statements.map((statement, index) => `${bindSql(statement.sql, statement.values)}; INSERT INTO _batch_changes VALUES (${index}, changes());`).join("\n")}
COMMIT; SELECT * FROM _batch_changes ORDER BY idx;`, true);
    return (result ? JSON.parse(result) : []).map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } }));
  }
}

function count(database, table, where = "1 = 1") {
  return Number(database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)[0].count);
}

function environment(DB) {
  return { APP_ENV: "staging", DB, REGISTRATION_WRITE_ENABLED: "true", EMAIL_ENABLED: "false", AUTH_EMAIL_ENABLED: "false", STAFF_AUTH_EMAIL_ENABLED: "true" };
}

const actor = {
  staffAccountId: "teacher", displayName: "Test teacher", roles: ["teacher"], capabilities: ["registration.manage"],
  sessionId: "test", sessionExpiresAt: now, sessionAbsoluteExpiresAt: now,
};

function seedConfirmed(database, id, amountMnt, classId) {
  const guardianId = `${id}-guardian`;
  const studentId = `${id}-student`;
  const registrationId = `${id}-registration`;
  const applicationId = `${id}-application`;
  const enrollmentId = `${id}-enrollment`;
  const childId = `${id}-child`;
  const requestId = `${id}-request`;
  const installmentId = `${id}-installment`;
  database.query(`INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Test address', 'active', 1, 'late-referral-test', ?, ?)`, [guardianId, `${id} guardian`, `99${id.length}00000`, `99${id.length}00000`, `${id}@example.test`, `${id}@example.test`, now, now]);
  database.query(`INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
    VALUES (?, 'Test', ?, 'female', '2015-05-10', 'active', 1, 'late-referral-test', ?, ?)`, [studentId, id, now, now]);
  database.query(`INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, submitted_at, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, 'year', 'completed', ?, 1, 'late-referral-test', ?, ?)`, [registrationId, guardianId, now, now, now]);
  database.query(`INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, 5, 'new', 'enrolled', 1, 'late-referral-test', ?, ?)`, [applicationId, registrationId, studentId, now, now]);
  database.query(`INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, 'year', ?, 'confirmed', ?, 1, 'late-referral-test', ?, ?)`, [enrollmentId, applicationId, studentId, classId, now, now, now]);
  database.query(`INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, verified_at, expires_at, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, 'year', ?, 'Parent', '99000000', ?, ?, 'Test address', 'single', 'rules', 'rules', 'awaiting_initial_payment', ?, '2026-12-01T00:00:00.000Z', 1, 'late-referral-test', ?, ?)`,
    [registrationId, `${id}`.padEnd(64, "x"), `${id} guardian`, `${id}@example.test`, `${id}@example.test`, now, now, now]);
  database.query(`INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, current_school, returning_status, selected_stage_code, selected_class_session_id, payment_plan_code, initial_payment_amount_mnt, status, is_test, test_run_id, created_at, updated_at, canonical_student_id, canonical_application_child_id, canonical_enrollment_id)
    VALUES (?, ?, 0, 'Test', ?, 'female', '2015-05-10', '5', 'Test school', 'new', 'stage_1', ?, 'single', ?, 'awaiting_initial_payment', 1, 'late-referral-test', ?, ?, ?, ?, ?)`,
    [childId, registrationId, id, classId, amountMnt, now, now, studentId, applicationId, enrollmentId]);
  database.query(`INSERT INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
    VALUES (?, ?, ?, ?, ?, 1, 'late-referral-test')`, [requestId, registrationId, `NE-${id.toUpperCase()}`, now, now]);
  database.query(`INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, status, paid_at, canonical_application_child_id, canonical_enrollment_id, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'initial', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'paid', ?, ?, ?, 1, 'late-referral-test', ?, ?)`,
    [installmentId, requestId, childId, amountMnt, now, applicationId, enrollmentId, now, now]);
  database.query(`INSERT INTO received_payment (id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status, confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id)
    VALUES (?, ?, ?, ?, 'staff_manual_cash', 'confirmed', ?, ?, ?, ?, 1, 'late-referral-test')`,
    [`${id}-receipt`, requestId, amountMnt, now, now, `${id}-receipt-key`, now, now]);
  database.query(`INSERT INTO payment_allocation (id, received_payment_id, payment_installment_id, allocated_amount_mnt, allocated_at, created_at, is_test, test_run_id)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'late-referral-test')`, [`${id}-allocation`, `${id}-receipt`, installmentId, amountMnt, now, now]);
  return { childId, enrollmentId, applicationId, studentId, installmentId, requestId };
}

try {
  const migrations = readdirSync("migrations").filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().map((name) => readFileSync(path.join("migrations", name), "utf8")).join("\n");
  sqlite(migrations);
  const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");
  for (const [source, output] of [["src/server/staff/late-referral-external-settlement.ts", serviceBundlePath], ["src/server/services/discounts.ts", discountBundlePath]]) {
    const built = spawnSync(esbuild, [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(built.stderr);
  }
  const { previewLateReferralExternalSettlement, recordLateReferralExternalSettlement, lateReferralExternalSettlementHistoryForChildren, LateReferralExternalSettlementError } = await import(pathToFileURL(serviceBundlePath).href);
  const { awardReferrerDiscountForReferral } = await import(pathToFileURL(discountBundlePath).href);
  const database = new SqliteD1();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year', 'Test year', 'open', 1, 1, 'late-referral-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('class-a', 'year', 'stage_1', 'Stage 1', 'Saturday', '10:00', '11:20', 20, 'available', 1, 1, 'late-referral-test', '${now}', '${now}'),
           ('class-b', 'year', 'stage_2', 'Stage 2', 'Sunday', '10:00', '11:20', 20, 'available', 1, 1, 'late-referral-test', '${now}', '${now}');
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('teacher', 'teacher@example.test', 'Test teacher', 'active', 1, 'late-referral-test', '${now}', '${now}');`);
  const referrer = seedConfirmed(database, "referrer", 1200000, "class-b");
  const referred = seedConfirmed(database, "referred", 1200000, "class-a");
  database.query(`INSERT INTO enrollment_referral_code (id, enrollment_id, student_id, code, status, activated_at, is_test, test_run_id, created_at, updated_at)
    VALUES ('referrer-code', ?, ?, 'NE-TEST42', 'active', ?, 1, 'late-referral-test', ?, ?)`, [referrer.enrollmentId, referrer.studentId, now, now, now]);
  const refunds = {
    referredChild: { amountMnt: 24000, paidOn: "2026-09-28", method: "cash", paidByNote: "Teacher", externalReference: "", reason: "Already refunded offline" },
    referrer: { amountMnt: 60000, paidOn: "2026-09-28", method: "bank_transfer", paidByNote: "Teacher", externalReference: "REF-42", reason: "Already refunded offline" },
  };
  const preview = await previewLateReferralExternalSettlement(environment(database), actor, { referredRegistrationDraftChildId: referred.childId, referralCode: " ne-test42 ", refunds });
  assert.deepEqual(preview.benefits.map((benefit) => [benefit.benefitType, benefit.entitlementAmountMnt, benefit.differsFromEntitlement]), [["referred_child", 24000, false], ["referrer", 60000, false]], "the preview retains the reviewed 2% and 5% entitlements on 1.2M receipts");
  const operationId = "11111111-1111-4111-8111-111111111111";
  const saved = await recordLateReferralExternalSettlement(environment(database), actor, { referredRegistrationDraftChildId: referred.childId, referralCode: "NE-TEST42", refunds, reviewFingerprint: preview.reviewFingerprint, operationId }, new Date(now));
  assert.equal(saved.idempotent, false, "the first reviewed operation persists once");
  assert.equal(count(database, "referral"), 1, "the canonical relationship is durable");
  assert.equal(count(database, "late_referral_external_settlement"), 2, "both externally settled benefits are recorded");
  assert.equal(count(database, "discount_award"), 0, "external settlement does not create a tuition discount");
  assert.equal(count(database, "payment_credit"), 0, "external settlement does not create spendable payment credit");
  assert.equal(Number(database.query(`SELECT SUM(received_amount_mnt) AS amount FROM received_payment`)[0].amount), 2400000, "original receipts remain immutable");
  assert.equal(Number(database.query(`SELECT SUM(allocated_amount_mnt) AS amount FROM payment_allocation`)[0].amount), 2400000, "allocations remain immutable");
  const retry = await recordLateReferralExternalSettlement(environment(database), actor, { referredRegistrationDraftChildId: referred.childId, referralCode: "NE-TEST42", refunds, reviewFingerprint: preview.reviewFingerprint, operationId }, new Date(now));
  assert.deepEqual(retry, { referralId: saved.referralId, idempotent: true }, "a lost response can retry without another relationship or settlement");
  assert.equal(await awardReferrerDiscountForReferral(environment(database), {
    referralId: saved.referralId, policy: { familyMultiChildBasisPoints: 1000, referrerBasisPoints: 500, referredChildBasisPoints: 200, updatedAt: now }, now,
  }), false, "ordinary referral award processing cannot mint a duplicate later");
  assert.equal(count(database, "discount_award"), 0, "duplicate ordinary award remains absent");
  const history = await lateReferralExternalSettlementHistoryForChildren(database, [referred.childId, referrer.childId]);
  assert.equal(history.get(referred.childId)?.length, 2, "the referred record sees the complete settled relationship history");
  assert.equal(history.get(referrer.childId)?.length, 2, "the referrer record sees the complete settled relationship history");

  const staleReferred = seedConfirmed(database, "stale-referred", 1200000, "class-a");
  const stalePreview = await previewLateReferralExternalSettlement(environment(database), actor, { referredRegistrationDraftChildId: staleReferred.childId, referralCode: "NE-TEST42", refunds });
  database.query(`UPDATE discount_policy_setting SET updated_at = '2026-10-01T04:01:00.000Z' WHERE singleton = 1`);
  await assert.rejects(() => recordLateReferralExternalSettlement(environment(database), actor, {
    referredRegistrationDraftChildId: staleReferred.childId, referralCode: "NE-TEST42", refunds, reviewFingerprint: stalePreview.reviewFingerprint,
    operationId: "22222222-2222-4222-8222-222222222222",
  }, new Date(now)), (error) => error instanceof LateReferralExternalSettlementError && error.code === "stale", "a changed policy invalidates a prior review atomically");
  assert.equal(count(database, "referral", `referred_application_child_id = '${staleReferred.applicationId}'`), 0, "the stale operation writes no partial referral");
  assert.equal(count(database, "late_referral_external_settlement_operation", `referred_registration_draft_child_id = '${staleReferred.childId}'`), 0, "the stale operation writes no operation header");
  console.log("late referral external settlement test passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
