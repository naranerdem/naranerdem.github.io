import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-registration-holds-"));
const databasePath = path.join(tempDir, "registration.sqlite3");
const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");

function bundle(source, output) {
  const result = spawnSync(esbuild, [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`esbuild failed\n${result.stdout}\n${result.stderr}`);
}

const registrationBundle = path.join(tempDir, "registration-submission.mjs");
const turnstileBundle = path.join(tempDir, "turnstile.mjs");
const emailVerificationBundle = path.join(tempDir, "email-verification.mjs");
const paymentReconciliationBundle = path.join(tempDir, "payment-reconciliation.mjs");
bundle("src/server/services/registration-submission.ts", registrationBundle);
bundle("src/server/security/turnstile.ts", turnstileBundle);
bundle("src/server/auth/email-verification.ts", emailVerificationBundle);
bundle("src/server/staff/payment-reconciliation.ts", paymentReconciliationBundle);
const {
  changeDraftEmail,
  claimRegistrationEmailSend,
  confirmRegistrationChallenge,
  createRegistrationDraft,
  enforceResendCooldown,
  markRegistrationEmailSent,
  registrationStatusForSession,
  RegistrationSubmissionError,
} = await import(pathToFileURL(registrationBundle).href);
const { TurnstileError, verifyTurnstile } = await import(pathToFileURL(turnstileBundle).href);
const { verifyEmailToken } = await import(pathToFileURL(emailVerificationBundle).href);
const {
  claimParentPayment,
  getInitialPaymentQueue,
  recordCheckedNotFound,
  recordManualPayment,
  releaseUnpaidSeat,
} = await import(pathToFileURL(paymentReconciliationBundle).href);

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSql(sql, values) {
  let index = 0;
  const bound = sql.replaceAll("?", () => {
    if (index >= values.length) throw new Error("Missing SQLite test binding");
    return sqlValue(values[index++]);
  });
  assert.equal(index, values.length, "all SQLite test bindings are consumed");
  return bound;
}

function sqlite(input, json = false) {
  const args = json ? ["-json", databasePath] : [databasePath];
  const result = spawnSync("sqlite3", args, { input: `.timeout 5000\nPRAGMA foreign_keys=ON;\n${input}`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stdout}\n${result.stderr}\n${input}`);
  return result.stdout.trim();
}

class Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  async all() {
    return { success: true, results: this.database.query(this.sql, this.values) };
  }
  async first() {
    return this.database.query(this.sql, this.values)[0] ?? null;
  }
  async run() {
    const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values);
    return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } };
  }
}

class SqliteD1 {
  prepare(sql) {
    return new Statement(this, sql);
  }
  query(sql, values = []) {
    const output = sqlite(`${bindSql(sql, values)};`, true);
    return output ? JSON.parse(output) : [];
  }
  async batch(statements) {
    const changes = statements.map((statement, index) => `${bindSql(statement.sql, statement.values)};
INSERT INTO _batch_changes (idx, change_count) VALUES (${index}, changes());`).join("\n");
    const output = sqlite(`
CREATE TEMP TABLE _batch_changes (idx INTEGER, change_count INTEGER);
BEGIN IMMEDIATE;
${changes}
COMMIT;
SELECT idx, change_count AS changes FROM _batch_changes ORDER BY idx;
`, true);
    const rows = output ? JSON.parse(output) : [];
    return rows.map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } }));
  }
}

function iso(offsetMinutes = 0) {
  return new Date(Date.UTC(2026, 7, 11, 8, offsetMinutes, 0)).toISOString();
}

function env(database, overrides = {}) {
  return {
    APP_ENV: "staging",
    REGISTRATION_WRITE_ENABLED: "true",
    EMAIL_ENABLED: "true",
    AUTH_EMAIL_ENABLED: "true",
    APP_ORIGIN: "https://staging.example.test",
    EMAIL_FROM: "Наран Эрдэм <burtgel@mail.naranerdem.com>",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    DB: database,
    ...overrides,
  };
}

function submission(classId, waitlistId, children = 1, paymentPlanCode = "single") {
  return {
    guardian: {
      fullName: "Тест Асран",
      relationship: "Ээж",
      primaryPhone: "99000000",
      email: `parent-${randomUUID()}@example.test`,
      homeAddress: "Баянзүрх дүүрэг",
    },
    children: Array.from({ length: children }, (_, index) => ({
      surname: "Тест",
      givenName: `Хүүхэд ${index + 1}`,
      gender: "not_specified",
      dateOfBirth: "2015-05-10",
      currentGrade: "5",
      returningStatus: "new",
      selectedStageCode: "stage_1",
      selectedClassSessionId: classId || undefined,
      preferredWaitlistClassSessionId: waitlistId || undefined,
      codeInput: "ANY-CODE",
      paymentPlanCode: classId ? paymentPlanCode : undefined,
    })),
    parentRulesAcknowledged: true,
    studentRulesAcknowledged: true,
    turnstileToken: "tested-before-service",
  };
}

function count(database, table, where = "1 = 1") {
  return Number(database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)[0].count);
}

function addChallenge(database, draftId, email, now, expiresAt) {
  const outboundId = randomUUID();
  const challengeId = randomUUID();
  const rawToken = randomUUID();
  database.query(`
    INSERT INTO outbound_email (
      id, event_type, template_key, intended_to_email, actual_delivery_email,
      delivery_mode, status, attempt_count, queued_at, is_test, test_run_id,
      created_at, updated_at, registration_draft_id
    ) VALUES (?, 'registration_confirmation_requested', 'registration_confirmation_v1', ?, ?,
      'staging_override', 'sent', 1, ?, 1, ?, ?, ?, ?)
  `, [outboundId, email, "safe@example.test", now, `test:${draftId}`, now, now, draftId]);
  database.query(`
    INSERT INTO email_verification_challenge (
      id, normalized_email, token_hash, purpose, status, outbound_email_id,
      created_at, expires_at, is_test, test_run_id, updated_at, registration_draft_id
    ) VALUES (?, ?, ?, 'registration_email', 'pending', ?, ?, ?, 1, ?, ?, ?)
  `, [challengeId, email.toLowerCase(), createHash("sha256").update(rawToken).digest("hex"), outboundId,
    now, expiresAt, `test:${draftId}`, now, draftId]);
  return {
    id: challengeId,
    normalizedEmail: email.toLowerCase(),
    status: "pending",
    expiresAt,
    invalidatedAt: null,
    registrationDraftId: draftId,
    isTest: 1,
    testRunId: `test:${draftId}`,
    rawToken,
  };
}

function session(now, expiresAt) {
  const rawToken = randomUUID();
  return {
    id: randomUUID(),
    rawToken,
    tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    createdAt: now,
    expiresAt,
  };
}

try {
  const migrations = readdirSync(path.resolve("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(path.resolve("migrations", name), "utf8"))
    .join("\n");
  sqlite(migrations);
  const database = new SqliteD1();
  database.query(`
    INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year-test', 'Тест жил', 'open', 1, 1, 'catalog-test', ?, ?)
  `, [iso(), iso()]);
  for (const [id, capacity, status, time] of [
    ["class-last-seat", 1, "available", "10:00"],
    ["class-roomy", 3, "available", "12:00"],
    ["class-full-preferred", 1, "full", "14:00"],
    ["class-priced", 10, "available", "16:00"],
    ["class-second-offering", 10, "available", "17:00"],
  ]) {
    database.query(`
      INSERT INTO class_session (
        id, academic_year_id, stage_code, display_label, weekday, start_time,
        end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at
      ) VALUES (?, 'year-test', 'stage_1', ?, 'Бямба', ?, '15:20', ?, ?, 1, 1, 'catalog-test', ?, ?)
    `, [id, id, time, capacity, status, iso(), iso()]);
  }
  database.query(`INSERT INTO activity_offering (
    id, kind, title, academic_year_id, stage_code, use_academic_year_breaks,
    charge_mode, status, is_test, test_run_id, created_at, updated_at
  ) VALUES ('offering-test', 'annual_course', 'Тест сургалт', 'year-test', 'stage_1', 1,
    'paid', 'active', 1, 'catalog-test', ?, ?)`, [iso(), iso()]);
  database.query("UPDATE class_session SET activity_offering_id = 'offering-test'");
  database.query(`INSERT INTO offering_course_pricing (
    activity_offering_id, one_time_amount_mnt, two_installment_enabled,
    first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at
  ) VALUES ('offering-test', 850000, 1, 450000, 450000, '2026-11-01', ?, ?)`, [iso(), iso()]);
  database.query(`UPDATE payment_collection_settings SET bank_name = 'Тест банк',
    account_holder_name = 'Тест эзэмшигч', account_number = '0000000000', updated_at = ? WHERE singleton = 1`, [iso()]);
  database.query(`INSERT INTO activity_offering (
    id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at
  ) VALUES ('offering-second-test', 'summer_course', 'Өөр тест сургалт', 'year-test', 'stage_1', 0, 'paid', 'active', 1, 'catalog-test', ?, ?);
  UPDATE class_session SET activity_offering_id = 'offering-second-test' WHERE id = 'class-second-offering';
  INSERT INTO offering_course_pricing (
    activity_offering_id, one_time_amount_mnt, two_installment_enabled,
    first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at
  ) VALUES ('offering-second-test', 700000, 0, NULL, NULL, NULL, ?, ?)`, [iso(), iso(), iso(), iso()]);
  database.query(`INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('staff-payment-test', 'payment@example.test', 'Тест Багш', 'active', 1, 'payment-test', ?, ?)`, [iso(), iso()]);
  const paymentStaff = { staffAccountId: 'staff-payment-test', displayName: 'Тест Багш', roles: ['teacher'],
    capabilities: ['payment.view', 'payment.manage'], sessionId: 'test', sessionExpiresAt: iso(60), sessionAbsoluteExpiresAt: iso(60) };

  const one = await createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso()));
  assert.equal(one.hasProvisionalHold, true);
  assert.equal(count(database, "registration_capacity_hold", "status = 'active'"), 1);
  assert.deepEqual(database.query(`SELECT payment_plan_code AS paymentPlanCode,
    initial_payment_amount_mnt AS initialAmount, second_payment_amount_mnt AS secondAmount
    FROM registration_draft_child WHERE registration_draft_id = ?`, [one.draftId])[0],
  { paymentPlanCode: "single", initialAmount: 850000, secondAmount: null }, "single-plan pricing is snapshotted at acceptance");

  const twoInstallment = await createRegistrationDraft(env(database), submission("class-priced", undefined, 1, "two_installment"), new Date(iso(-3)));
  const twoSnapshot = database.query(`SELECT payment_plan_code AS paymentPlanCode,
    initial_payment_amount_mnt AS initialAmount, second_payment_amount_mnt AS secondAmount,
    second_payment_due_on AS dueOn FROM registration_draft_child WHERE registration_draft_id = ?`, [twoInstallment.draftId])[0];
  assert.deepEqual(twoSnapshot, { paymentPlanCode: "two_installment", initialAmount: 450000, secondAmount: 450000, dueOn: "2026-11-01" }, "two-installment pricing is snapshotted per child");
  database.query(`UPDATE offering_course_pricing SET one_time_amount_mnt = 950000,
    first_installment_amount_mnt = 500000, second_installment_amount_mnt = 500000 WHERE activity_offering_id = 'offering-test'`);
  assert.equal(database.query(`SELECT initial_payment_amount_mnt AS initialAmount FROM registration_draft_child WHERE registration_draft_id = ?`, [one.draftId])[0].initialAmount, 850000, "later Offering price changes do not rewrite accepted single-plan snapshots");
  assert.equal(database.query(`SELECT initial_payment_amount_mnt AS initialAmount FROM registration_draft_child WHERE registration_draft_id = ?`, [twoInstallment.draftId])[0].initialAmount, 450000, "later Offering price changes do not rewrite accepted two-installment snapshots");
  const twoChallenge = addChallenge(database, twoInstallment.draftId, twoInstallment.normalizedEmail, iso(-3), iso(-3 + 24 * 60));
  const twoSession = session(iso(-2), iso(58));
  await confirmRegistrationChallenge(env(database), twoChallenge, twoSession, new Date(iso(-2)));
  const twoStatus = await registrationStatusForSession(database, twoSession.rawToken, new Date(iso(-2)));
  assert.equal(twoStatus.children[0].initialPaymentAmountMnt, 450000, "verified payment status exposes the saved initial amount, not the new Offering price");
  assert.equal(twoStatus.paymentCollection.bankName, "Тест банк", "verified payment status includes configured transfer instructions only after verification");
  const twoRequest = database.query(`SELECT id, payment_reference AS paymentReference FROM payment_request WHERE registration_draft_id = ?`, [twoInstallment.draftId])[0];
  assert.match(twoRequest.paymentReference, /^NE-[A-Z2-9]{6}$/, "payment reference is stable, opaque, and copyable");
  assert.equal(count(database, "payment_installment", `payment_request_id = '${twoRequest.id}'`), 2, "two-installment snapshot creates two generic obligations");
  await claimParentPayment(database, twoRequest.id, twoInstallment.draftId, twoSession.rawToken, new Date(iso(-1)));
  await claimParentPayment(database, twoRequest.id, twoInstallment.draftId, twoSession.rawToken, new Date(iso(-1)));
  assert.equal(count(database, "payment_evidence", `payment_request_id = '${twoRequest.id}' AND evidence_type = 'parent_claim'`), 1, "parent paid claim is idempotent evidence only");
  const queueBeforePayment = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()));
  const twoQueueItem = queueBeforePayment.items.find((item) => item.paymentRequestId === twoRequest.id);
  assert.equal(twoQueueItem.parentClaimed, true, "parent claim is visible to staff without changing capacity");
  await recordCheckedNotFound(env(database), paymentStaff, twoRequest.id, new Date(iso()));
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${twoInstallment.draftId}') AND status = 'active'`), 1, "checked-not-found never releases a seat");
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: twoRequest.id,
    allocations: [{ installmentId: twoQueueItem.installmentId, amountMnt: 450000 }],
    source: 'staff_manual_bank', receivedAt: '2026-08-11T07:53:00.000Z', idempotencyKey: 'two-initial-exact',
  }, new Date('2026-08-13T09:15:00.000Z'));
  const duplicatePayment = await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: twoRequest.id,
    allocations: [{ installmentId: twoQueueItem.installmentId, amountMnt: 450000 }],
    source: 'staff_manual_bank', receivedAt: '2026-08-11T07:53:00.000Z', idempotencyKey: 'two-initial-exact',
  }, new Date('2026-08-13T09:16:00.000Z'));
  assert.equal(duplicatePayment.idempotent, true, "retrying the same manual confirmation does not create a duplicate payment");
  assert.equal(database.query(`SELECT received_at AS receivedAt, confirmed_at AS confirmedAt FROM received_payment WHERE idempotency_key = 'two-initial-exact'`)[0].receivedAt, '2026-08-11T07:53:00.000Z', "actual receipt time is preserved separately");
  assert.equal(database.query(`SELECT confirmed_at AS confirmedAt FROM received_payment WHERE idempotency_key = 'two-initial-exact'`)[0].confirmedAt, '2026-08-13T09:15:00.000Z', "staff confirmation time is preserved separately");
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'later'`, [twoRequest.id])[0].status, 'pending', "later installment remains independent of initial seat confirmation");
  const multiChild = submission("class-priced", undefined, 1, "two_installment");
  multiChild.children.push({ ...multiChild.children[0], givenName: "Хүүхэд 2", selectedClassSessionId: "class-second-offering", paymentPlanCode: "single" });
  const multiChildDraft = await createRegistrationDraft(env(database), multiChild, new Date(iso(-4)));
  assert.deepEqual(database.query(`SELECT position, payment_plan_code AS paymentPlanCode, initial_payment_amount_mnt AS initialAmount
    FROM registration_draft_child WHERE registration_draft_id = ? ORDER BY position`, [multiChildDraft.draftId]),
  [{ position: 0, paymentPlanCode: "two_installment", initialAmount: 500000 }, { position: 1, paymentPlanCode: "single", initialAmount: 700000 }],
  "siblings may retain independent Offering prices and payment plans");
  const multiChallenge = addChallenge(database, multiChildDraft.draftId, multiChildDraft.normalizedEmail, iso(-4), iso(56));
  const multiSession = session(iso(-3), iso(57));
  await confirmRegistrationChallenge(env(database), multiChallenge, multiSession, new Date(iso(-3)));
  const multiRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [multiChildDraft.draftId])[0];
  const multiInstallments = database.query(`SELECT id, amount_mnt AS amountMnt FROM payment_installment
    WHERE payment_request_id = ? AND installment_kind = 'initial' ORDER BY id`, [multiRequest.id]);
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: multiRequest.id,
    allocations: multiInstallments.map((item) => ({ installmentId: item.id, amountMnt: Number(item.amountMnt) })),
    receivedAmountMnt: 1201000, source: 'staff_manual_bank', idempotencyKey: 'multi-child-transfer',
  }, new Date(iso(-2)));
  assert.equal(count(database, "payment_allocation", `received_payment_id = (SELECT id FROM received_payment WHERE idempotency_key = 'multi-child-transfer')`), 2, "one received payment can allocate across two children's initial obligations");
  assert.equal(database.query(`SELECT received_amount_mnt AS amountMnt FROM received_payment WHERE idempotency_key = 'multi-child-transfer'`)[0].amountMnt, 1201000, "unallocated overpayment remains representable without inventing a credit");
  const manipulated = submission("class-priced");
  manipulated.children[0].initialPaymentAmountMnt = 1;
  const manipulatedDraft = await createRegistrationDraft(env(database), manipulated, new Date(iso(-1)));
  assert.equal(database.query(`SELECT initial_payment_amount_mnt AS initialAmount FROM registration_draft_child WHERE registration_draft_id = ?`, [manipulatedDraft.draftId])[0].initialAmount, 950000, "browser-provided amounts are ignored in favor of the server pricing plan");
  database.query("UPDATE payment_collection_settings SET account_number = NULL");
  await assert.rejects(createRegistrationDraft(env(database), submission("class-priced"), new Date(iso(-1))),
    (error) => error instanceof RegistrationSubmissionError && error.code === "pricing_unavailable", "incomplete transfer instructions prevent a new payment request");
  database.query("UPDATE payment_collection_settings SET account_number = '0000000000'");

  const competing = await Promise.allSettled([
    createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(1))),
    createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(1))),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 0, "an existing hold protects the last seat");
  assert.equal(count(database, "registration_capacity_hold", "class_session_id = 'class-last-seat' AND deadline_at > '2026-08-11T08:01:00.000Z'"), 1);

  database.query("UPDATE registration_capacity_hold SET deadline_at = ? WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)", [iso(1), one.draftId]);
  const replacement = await createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(2)));
  assert.equal(replacement.hasProvisionalHold, true, "expired provisional hold restores capacity without cleanup");

  await assert.rejects(
    createRegistrationDraft(env(database), submission("class-roomy", undefined, 4), new Date(iso(3))),
    (error) => error instanceof RegistrationSubmissionError && error.code === "capacity_changed",
  );
  const partialDraft = database.query("SELECT id FROM registration_draft ORDER BY created_at DESC LIMIT 1")[0];
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${partialDraft.id}')`), 0, "multi-child failure creates no partial hold");

  const waitlistOnly = await createRegistrationDraft(env(database), submission(undefined, "class-full-preferred"), new Date(iso(4)));
  assert.equal(waitlistOnly.hasProvisionalHold, false);
  assert.equal(count(database, "registration_draft_waitlist_entry", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${waitlistOnly.draftId}')`), 0, "unverified draft does not enter FIFO queue");
  const waitChallenge = addChallenge(database, waitlistOnly.draftId, waitlistOnly.normalizedEmail, iso(4), iso(4 + 24 * 60));
  const waitConfirmed = await confirmRegistrationChallenge(env(database), waitChallenge, session(iso(5), iso(65)), new Date(iso(5)));
  assert.equal(waitConfirmed.status, "waitlisted");
  assert.equal(count(database, "registration_draft_waitlist_entry", "status = 'active'"), 1);
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${waitlistOnly.draftId}')`), 0);

  const fallback = await createRegistrationDraft(env(database), submission("class-roomy", "class-full-preferred"), new Date(iso(6)));
  const fallbackChallenge = addChallenge(database, fallback.draftId, fallback.normalizedEmail, iso(6), iso(6 + 24 * 60));
  const fallbackSession = session(iso(7), iso(67));
  const fallbackConfirmed = await confirmRegistrationChallenge(env(database), fallbackChallenge, fallbackSession, new Date(iso(7)));
  assert.equal(fallbackConfirmed.hasPaymentHold, true);
  assert.equal(fallbackConfirmed.paymentDeadlineAt, iso(7 + 24 * 60), "fresh payment hold starts at confirmation");
  assert.equal(count(database, "registration_draft_waitlist_entry", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${fallback.draftId}')`), 1);
  const fallbackStatus = await registrationStatusForSession(database, fallbackSession.rawToken, new Date(iso(8)));
  assert.equal(fallbackStatus.id, fallback.draftId);
  assert.equal(fallbackStatus.children.length, 1);
  await assert.rejects(
    registrationStatusForSession(database, "unrelated-session", new Date(iso(8))),
    (error) => error.code === "session_required",
  );
  const fifo = database.query("SELECT registration_draft_child_id FROM registration_draft_waitlist_entry WHERE class_session_id = 'class-full-preferred' ORDER BY created_at, id");
  assert.equal(fifo.length, 2);
  assert.notEqual(fifo[0].registration_draft_child_id, fifo[1].registration_draft_child_id);

  const lateFree = await createRegistrationDraft(env(database), submission("class-roomy"), new Date(iso(8)));
  database.query("UPDATE registration_capacity_hold SET deadline_at = ? WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)", ["2026-08-11T08:08:30.000Z", lateFree.draftId]);
  const lateFreeChallenge = addChallenge(database, lateFree.draftId, lateFree.normalizedEmail, iso(8), iso(8 + 24 * 60));
  const reacquired = await confirmRegistrationChallenge(env(database), lateFreeChallenge, session(iso(9), iso(69)), new Date(iso(9)));
  assert.equal(reacquired.lateReacquired, true);
  assert.equal(reacquired.hasPaymentHold, true);

  database.query("UPDATE registration_capacity_hold SET deadline_at = ? WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)", [iso(9), replacement.draftId]);
  const competitor = await createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(10)));
  const replacementChallenge = addChallenge(database, replacement.draftId, replacement.normalizedEmail, iso(2), iso(2 + 24 * 60));
  const lost = await confirmRegistrationChallenge(env(database), replacementChallenge, session(iso(11), iso(71)), new Date(iso(11)));
  assert.equal(lost.status, "seat_unavailable");
  assert.equal(lost.hasPaymentHold, false);
  assert.equal(count(database, "registration_capacity_hold", `class_session_id = 'class-last-seat' AND status = 'active' AND deadline_at > '${iso(11)}'`), 1, "late confirmation cannot overbook competitor");
  assert.ok(competitor.draftId);

  const emailChangeDraft = await createRegistrationDraft(env(database), submission("class-roomy"), new Date(iso(12)));
  const beforeEmailChange = database.query(`
    SELECT deadline_at AS deadlineAt FROM registration_capacity_hold
    WHERE registration_draft_child_id IN (
      SELECT id FROM registration_draft_child WHERE registration_draft_id = ?
    )
  `, [emailChangeDraft.draftId])[0];
  const draftRow = database.query(`
    SELECT id, normalized_email AS normalizedEmail, email, status,
      email_last_sent_at AS emailLastSentAt, expires_at AS expiresAt
    FROM registration_draft WHERE id = ?
  `, [emailChangeDraft.draftId])[0];
  await changeDraftEmail(database, draftRow, "changed@example.test", new Date(iso(13)));
  const afterEmailChange = database.query(`
    SELECT deadline_at AS deadlineAt FROM registration_capacity_hold
    WHERE registration_draft_child_id IN (
      SELECT id FROM registration_draft_child WHERE registration_draft_id = ?
    )
  `, [emailChangeDraft.draftId])[0];
  assert.equal(afterEmailChange.deadlineAt, beforeEmailChange.deadlineAt, "changing email does not extend provisional hold");
  await markRegistrationEmailSent(database, emailChangeDraft.draftId, new Date(iso(13)));
  const sentDraft = { ...draftRow, emailLastSentAt: iso(13) };
  assert.throws(
    () => enforceResendCooldown(sentDraft, new Date("2026-08-11T08:13:30.000Z")),
    (error) => error.code === "resend_cooldown",
  );
  await assert.rejects(
    claimRegistrationEmailSend(database, sentDraft, new Date("2026-08-11T08:13:30.000Z")),
    (error) => error.code === "resend_cooldown",
  );
  const deadlineAfterResendBookkeeping = database.query(`
    SELECT deadline_at AS deadlineAt FROM registration_capacity_hold
    WHERE registration_draft_child_id IN (
      SELECT id FROM registration_draft_child WHERE registration_draft_id = ?
    )
  `, [emailChangeDraft.draftId])[0];
  assert.equal(deadlineAfterResendBookkeeping.deadlineAt, beforeEmailChange.deadlineAt, "resend bookkeeping does not extend provisional hold");

  await assert.rejects(createRegistrationDraft(
    env(database),
    submission("class-roomy", undefined, 3),
    new Date("2026-08-13T09:00:00.000Z"),
  ), (error) => error instanceof RegistrationSubmissionError && error.code === "capacity_changed",
  "overdue initial-payment reservations continue to consume capacity until staff resolves them");
  const cashDraft = await createRegistrationDraft(env(database), submission("class-priced"), new Date("2026-08-13T09:05:00.000Z"));
  const cashChallenge = addChallenge(database, cashDraft.draftId, cashDraft.normalizedEmail, "2026-08-13T09:05:00.000Z", "2026-08-14T09:05:00.000Z");
  const cashSession = session("2026-08-13T09:06:00.000Z", "2026-08-16T10:06:00.000Z");
  await confirmRegistrationChallenge(env(database), cashChallenge, cashSession, new Date("2026-08-13T09:06:00.000Z"));
  const cashRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [cashDraft.draftId])[0];
  const cashInstallment = database.query(`SELECT id, amount_mnt AS amountMnt FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'initial'`, [cashRequest.id])[0];
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: cashRequest.id, allocations: [{ installmentId: cashInstallment.id, amountMnt: 100000 }],
    source: 'staff_manual_cash', idempotencyKey: 'cash-partial',
  }, new Date("2026-08-13T09:10:00.000Z"));
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE id = ?`, [cashInstallment.id])[0].status, 'partially_paid', "partial first payment does not confirm the obligation");
  await assert.rejects(recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: cashRequest.id, allocations: [{ installmentId: cashInstallment.id, amountMnt: Number(cashInstallment.amountMnt) }],
    source: 'staff_manual_cash', idempotencyKey: 'cash-overpayment',
  }), "allocation cannot exceed the remaining obligation");
  await claimParentPayment(database, cashRequest.id, cashDraft.draftId, cashSession.rawToken, new Date("2026-08-15T10:00:00.000Z"));
  await assert.rejects(claimParentPayment(database, cashRequest.id, cashDraft.draftId, "not-this-family", new Date("2026-08-15T10:00:00.000Z")), "another session cannot claim a family's payment");
  const released = await releaseUnpaidSeat(env(database), paymentStaff, cashRequest.id, new Date("2026-08-15T10:00:00.000Z"));
  assert.equal(released.released, true, "staff can explicitly release a genuinely unpaid overdue seat");
  assert.equal(released.parentClaimed, true, "release surfaces the parent's non-authoritative payment claim");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${cashDraft.draftId}') AND status = 'active'`), 0, "explicit release, not elapsed time, frees the seat");
  assert.equal(count(database, "guardian_account"), 0);
  assert.equal(count(database, "student"), 0);

  const replayDraft = await createRegistrationDraft(env(database), submission(undefined, "class-full-preferred"), new Date("2026-08-13T10:00:00.000Z"));
  const replayChallenge = addChallenge(
    database,
    replayDraft.draftId,
    replayDraft.normalizedEmail,
    "2026-08-13T10:00:00.000Z",
    "2026-08-14T10:00:00.000Z",
  );
  const verificationTime = new Date("2026-08-13T10:01:00.000Z");
  const firstVerification = await verifyEmailToken(env(database), replayChallenge.rawToken, "", verificationTime);
  assert.match(firstVerification.redirectUrl, /status=confirmed/);
  const sessionToken = decodeURIComponent(firstVerification.cookie.match(/^naran_verified_email=([^;]+)/)[1]);
  const friendlyReplay = await verifyEmailToken(env(database), replayChallenge.rawToken, sessionToken, verificationTime);
  assert.match(friendlyReplay.redirectUrl, /status=already-verified/);
  await assert.rejects(
    verifyEmailToken(env(database), replayChallenge.rawToken, "", verificationTime),
    (error) => error.code === "invalid_or_expired_token",
  );
  const storedChallenge = database.query("SELECT token_hash AS tokenHash FROM email_verification_challenge WHERE id = ?", [replayChallenge.id])[0];
  assert.notEqual(storedChallenge.tokenHash, replayChallenge.rawToken);

  const production = env(database, {
    APP_ENV: "production",
    REGISTRATION_WRITE_ENABLED: "false",
    EMAIL_ENABLED: "false",
    AUTH_EMAIL_ENABLED: "false",
  });
  await assert.rejects(createRegistrationDraft(production, submission("class-roomy")), (error) => error.code === "disabled");

  let siteverifyCalls = 0;
  globalThis.fetch = async (_url, init) => {
    siteverifyCalls += 1;
    const body = init.body;
    assert.equal(body.get("secret"), "1x0000000000000000000000000000000AA");
    return Response.json({ success: true, action: "registration_submit" });
  };
  await assert.rejects(verifyTurnstile(env(database), ""), (error) => error instanceof TurnstileError && error.code === "missing");
  assert.equal(siteverifyCalls, 0);
  await verifyTurnstile(env(database), "documented-test-token");
  assert.equal(siteverifyCalls, 1);
  globalThis.fetch = async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  await assert.rejects(verifyTurnstile(env(database), "bad-token"), (error) => error.code === "invalid");
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  await assert.rejects(verifyTurnstile(env(database), "network-token"), (error) => error.code === "unavailable");

  console.log("ok staged registration capacity, confirmation, waitlist, and Turnstile tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
