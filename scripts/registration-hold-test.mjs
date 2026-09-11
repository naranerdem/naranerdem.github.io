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
const catalogBundle = path.join(tempDir, "registration-catalog.mjs");
const publicSiteBundle = path.join(tempDir, "public-site.mjs");
const turnstileBundle = path.join(tempDir, "turnstile.mjs");
const emailVerificationBundle = path.join(tempDir, "email-verification.mjs");
const parentAccessBundle = path.join(tempDir, "parent-access.mjs");
const paymentReconciliationBundle = path.join(tempDir, "payment-reconciliation.mjs");
const canonicalPromotionBundle = path.join(tempDir, "canonical-enrollment-promotion.mjs");
const additionalClassPreviewBundle = path.join(tempDir, "additional-class-preview.mjs");
const additionalClassAdmissionBundle = path.join(tempDir, "additional-class-admission.mjs");
const registrationCancellationBundle = path.join(tempDir, "registration-cancellation.mjs");
const classTransferBundle = path.join(tempDir, "class-transfer.mjs");
const discountsBundle = path.join(tempDir, "discounts.mjs");
const registrationCorrectionBundle = path.join(tempDir, "registration-corrections.mjs");
const initialPaymentDeadlineBundle = path.join(tempDir, "initial-payment-deadline.mjs");
const childCreditBundle = path.join(tempDir, "child-credit-ledger.mjs");
const paymentRemindersBundle = path.join(tempDir, "payment-reminders.mjs");
bundle("src/server/services/registration-submission.ts", registrationBundle);
bundle("src/server/services/registration-catalog.ts", catalogBundle);
bundle("src/server/services/public-site.ts", publicSiteBundle);
bundle("src/server/security/turnstile.ts", turnstileBundle);
bundle("src/server/auth/email-verification.ts", emailVerificationBundle);
bundle("src/server/services/parent-access.ts", parentAccessBundle);
bundle("src/server/staff/payment-reconciliation.ts", paymentReconciliationBundle);
bundle("src/server/services/canonical-enrollment-promotion.ts", canonicalPromotionBundle);
bundle("src/server/staff/additional-class-preview.ts", additionalClassPreviewBundle);
bundle("src/server/staff/additional-class-admission.ts", additionalClassAdmissionBundle);
bundle("src/server/staff/registration-cancellation.ts", registrationCancellationBundle);
bundle("src/server/staff/class-transfer.ts", classTransferBundle);
bundle("src/server/services/discounts.ts", discountsBundle);
bundle("src/server/staff/registration-corrections.ts", registrationCorrectionBundle);
bundle("src/server/staff/initial-payment-deadline.ts", initialPaymentDeadlineBundle);
bundle("src/server/services/child-credit-ledger.ts", childCreditBundle);
bundle("src/server/staff/payment-reminders.ts", paymentRemindersBundle);
const {
  changeDraftEmail,
  claimRegistrationEmailSend,
  confirmRegistrationChallenge,
  createRegistrationDraft,
  enforceResendCooldown,
  markRegistrationEmailSent,
  registrationStatusForAccess,
  registrationStatusForDraftId,
  registrationStatusForSession,
  RegistrationSubmissionError,
} = await import(pathToFileURL(registrationBundle).href);
const { getRegistrationCatalog } = await import(pathToFileURL(catalogBundle).href);
const { getAdditionalClassPreview, AdditionalClassPreviewError } = await import(pathToFileURL(additionalClassPreviewBundle).href);
const { createAdditionalClassAdmission: createAdditionalClassAdmissionService, AdditionalClassAdmissionError } = await import(pathToFileURL(additionalClassAdmissionBundle).href);
const { claimAdditionalAdmissionConfirmation, finalizeAdditionalAdmissionClaim, promotePaidDraftChild } = await import(pathToFileURL(canonicalPromotionBundle).href);
const { cancelRegistration } = await import(pathToFileURL(registrationCancellationBundle).href);
const { closeClassTransfer, completeClassTransfer, initiateClassTransfer, listClassTransferTargets } = await import(pathToFileURL(classTransferBundle).href);
const { effectiveInstallments } = await import(pathToFileURL(discountsBundle).href);
const { getPublicSiteModel } = await import(pathToFileURL(publicSiteBundle).href);
const { TurnstileError, verifyTurnstile } = await import(pathToFileURL(turnstileBundle).href);
const gatesBundle = path.join(tempDir, "operational-gates.mjs");
bundle("src/server/security/operational-gates.ts", gatesBundle);
const { registrationWriteEnabled } = await import(pathToFileURL(gatesBundle).href);
const { sendParentAccessEmail, verifyEmailToken } = await import(pathToFileURL(emailVerificationBundle).href);
const { getParentDashboard } = await import(pathToFileURL(parentAccessBundle).href);
const {
  claimParentPayment,
  confirmSeatForSufficientPayment,
  finalizeDuePaymentConfirmations,
  getRegistrationExportRows,
  getInitialPaymentQueue,
  recordCheckedNotFound,
  recordManualPayment,
  releaseUnpaidSeat,
} = await import(pathToFileURL(paymentReconciliationBundle).href);
const { registrationCorrectionDetail, replaceRegistrationEmail, saveRegistrationCorrection } = await import(pathToFileURL(registrationCorrectionBundle).href);
const { getInitialPaymentDeadlineSetting, updateInitialPaymentDeadlineSetting } = await import(pathToFileURL(initialPaymentDeadlineBundle).href);
const { addManualChildCredit, applyChildCredit, childCreditSummary, correctChildCredit, creditPaymentReviewState, leaveChildCreditUnused, transferChildCredit } = await import(pathToFileURL(childCreditBundle).href);
const { processDuePaymentReminders } = await import(pathToFileURL(paymentRemindersBundle).href);

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
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
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
      facebookName: "Тест Асран",
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
      codeInput: "",
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
   ["class-legacy-status", 10, "available", "17:30"],
    ["class-award-source", 10, "available", "18:00"],
    ["class-award-target", 10, "available", "18:30"],
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
    account_holder_name = 'Тест эзэмшигч', account_number = '0000000000', iban = 'MN00TEST0000000000', updated_at = ? WHERE singleton = 1`, [iso()]);
  database.query(`INSERT INTO activity_offering (
    id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at
  ) VALUES ('offering-second-test', 'summer_course', 'Өөр тест сургалт', 'year-test', 'stage_1', 0, 'paid', 'active', 1, 'catalog-test', ?, ?);
  UPDATE class_session SET activity_offering_id = 'offering-second-test' WHERE id = 'class-second-offering';
  INSERT INTO offering_course_pricing (
    activity_offering_id, one_time_amount_mnt, two_installment_enabled,
    first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at
  ) VALUES ('offering-second-test', 700000, 0, NULL, NULL, NULL, ?, ?)`, [iso(), iso(), iso(), iso()]);
  database.query(`INSERT INTO registration_window (
    id, name, starts_on, ends_on, is_test, test_run_id, created_at, updated_at
  ) VALUES ('window-active-test', 'Тест бүртгэл', '2026-08-01', '2026-08-31', 1, 'catalog-test', ?, ?);
  INSERT INTO registration_window_offering (registration_window_id, activity_offering_id, created_at)
  VALUES ('window-active-test', 'offering-test', ?), ('window-active-test', 'offering-second-test', ?);`, [iso(), iso(), iso(), iso()]);
  for (const [id, stage] of [["offering-stage-2", "stage_2"], ["offering-stage-3", "stage_3"]]) {
    database.query(`INSERT INTO activity_offering (
      id, kind, title, academic_year_id, stage_code, use_academic_year_breaks,
      charge_mode, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, 'annual_course', ?, 'year-test', ?, 1, 'paid', 'active', 1, 'catalog-test', ?, ?)`, [id, id, stage, iso(), iso()]);
    database.query(`INSERT INTO class_session (
      id, activity_offering_id, academic_year_id, stage_code, display_label, weekday,
      start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, 'year-test', ?, ?, 'Бямба', '18:00', '19:20', 8, 'available', 1, 1, 'catalog-test', ?, ?)`,
    [`class-${stage}`, id, stage, `class-${stage}`, iso(), iso()]);
    database.query(`INSERT INTO offering_course_pricing (
      activity_offering_id, one_time_amount_mnt, two_installment_enabled,
      first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at
    ) VALUES (?, 800000, 0, NULL, NULL, NULL, ?, ?)`, [id, iso(), iso()]);
  }
  database.query(`INSERT INTO class_session (
    id, activity_offering_id, academic_year_id, stage_code, display_label, weekday,
    start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at
  ) VALUES ('class-closed', 'offering-test', 'year-test', 'stage_1', 'class-closed', 'Бямба',
    '19:00', '20:20', 8, 'closed', 1, 1, 'catalog-test', ?, ?)`, [iso(), iso()]);
  database.query(`INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('staff-payment-test', 'payment@example.test', 'Тест Багш', 'active', 1, 'payment-test', ?, ?)`, [iso(), iso()]);
  const paymentStaff = { staffAccountId: 'staff-payment-test', displayName: 'Тест Багш', roles: ['teacher'],
    capabilities: ['payment.view', 'payment.manage'], sessionId: 'test', sessionExpiresAt: iso(60), sessionAbsoluteExpiresAt: iso(60) };
 const registrationStaff = { ...paymentStaff, capabilities: ['registration.manage'] };
  async function createAdditionalClassAdmission(workerEnv, actor, input, nowDate) {
    const existing = await workerEnv.DB.prepare(`SELECT 1 AS value FROM additional_class_admission WHERE idempotency_key = ?`)
      .bind(input.idempotencyKey).first();
    if (existing || !actor.capabilities?.includes("registration.manage")) {
      return createAdditionalClassAdmissionService(workerEnv, actor, {
        ...input, policyUpdatedAt: "replay", proposedSourceAwardMnt: 0, proposedTargetAwardMnt: 0,
      }, nowDate);
    }
    const preview = await getAdditionalClassPreview(workerEnv, registrationStaff, {
      registrationDraftChildId: input.registrationDraftChildId,
      targetClassSessionId: input.targetClassSessionId,
      paymentPlanCode: input.paymentPlanCode,
    }, nowDate);
    assert.ok(preview.proposal, "a fresh additional admission must carry an authoritative pricing proposal");
    return createAdditionalClassAdmissionService(workerEnv, actor, {
      ...input,
      policyUpdatedAt: preview.baseDiscount.policyUpdatedAt,
      proposedSourceAwardMnt: preview.sourceEffect.awardMnt,
      proposedTargetAwardMnt: preview.proposal.baseDiscountMnt,
    }, nowDate);
  }
  const exportStaff = { ...paymentStaff, capabilities: ['payment.view', 'registration.view'] };
  const adminStaff = { ...paymentStaff, staffAccountId: 'staff-admin-test', capabilities: ['admin.settings.manage'] };

  database.query("UPDATE academic_year SET registration_status = 'closed' WHERE id = 'year-test'");
  const stageOneOnlyCatalog = await getRegistrationCatalog(database, "staging", new Date(iso()));
  const catalogSessions = stageOneOnlyCatalog.academicYears.flatMap((year) => year.classSessions);
  assert.ok(catalogSessions.some((entry) => entry.id === "class-last-seat" && entry.stageCode === "stage_1"), "an active Stage 1 window exposes its concrete classes even when the legacy academic-year status is closed");
  assert.deepEqual(new Set(catalogSessions.map((entry) => entry.stageCode)), new Set(["stage_1"]), "Stage 2 and 3 Offerings outside every active window are absent from the public catalog");
  assert.equal(catalogSessions.find((entry) => entry.id === "class-closed")?.availability, "unavailable", "a closed concrete class remains unavailable despite an active window");
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, created_at, updated_at)
    VALUES ('year-provenance-mismatch', 'Холимог тест жил', 'draft', 0, 0, ?, ?);
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('offering-provenance-mismatch', 'annual_course', 'Холимог тест сургалт', 'year-provenance-mismatch', 'stage_2', 1, 'paid', 'active', 1, 'catalog-test', ?, ?);
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('class-provenance-mismatch', 'offering-provenance-mismatch', 'year-provenance-mismatch', 'stage_2', 'Холимог анги', 'Мягмар', '09:00', '10:20', 10, 'available', 1, 1, 'catalog-test', ?, ?);
    INSERT INTO offering_course_pricing (activity_offering_id, one_time_amount_mnt, two_installment_enabled, first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at)
    VALUES ('offering-provenance-mismatch', 800000, 0, NULL, NULL, NULL, ?, ?);
    INSERT INTO registration_window_offering (registration_window_id, activity_offering_id, created_at)
    VALUES ('window-active-test', 'offering-provenance-mismatch', ?)`, [iso(), iso(), iso(), iso(), iso(), iso(), iso(), iso(), iso()]);
  const mixedProvenanceSubmission = submission("class-provenance-mismatch");
  mixedProvenanceSubmission.children[0].selectedStageCode = "stage_2";
  await assert.rejects(createRegistrationDraft(env(database), mixedProvenanceSubmission, new Date(iso(-5))),
    (error) => error.code === "invalid_class", "staging rejects a class whose academic-year, Offering, and class test provenance disagree");
  const legacyStatusDraft = await createRegistrationDraft(env(database), submission("class-legacy-status"), new Date(iso(-5)));
  assert.ok(legacyStatusDraft.hasPaymentHold, "legacy academic-year registration status does not override a valid active window");
  await assert.rejects(createRegistrationDraft(env(database, {
    APP_ENV: "production",
    REGISTRATION_WRITE_ENABLED: "true",
    TURNSTILE_SITE_KEY: "production-site-key",
    TURNSTILE_SECRET_KEY: "production-secret",
  }), submission("class-closed"), new Date(iso(-4))), (error) => error.code === "invalid_class", "a reviewed production gate and real Turnstile configuration reach the normal registration service path");
  const fabricatedRules = submission("class-priced"); fabricatedRules.parentRulesVersion = "fabricated-rule-version";
  await assert.rejects(createRegistrationDraft(env(database), fabricatedRules, new Date(iso(-4))), (error) => error.code === "invalid_rules_version", "fabricated rule versions are rejected");
  const staffIntakeInput = submission("class-second-offering");
  const staffIntake = await createRegistrationDraft(env(database), staffIntakeInput, new Date(iso(-4)), {
    idempotencyKey: `staff-intake:${randomUUID()}`,
    staffAssisted: { staffAccountId: "staff-teacher", intakeChannel: "paper_form", parentAcknowledged: true, studentAcknowledged: true, receiptRequested: false },
  });
  assert.ok(staffIntake.hasPaymentHold, "staff-assisted intake uses the normal atomic initial-payment hold");
  assert.equal(database.query("SELECT gender FROM registration_draft_child WHERE registration_draft_id = ?", [staffIntake.draftId])[0].gender, "not_specified", "the established unspecified gender response persists as a valid child value");
  assert.equal(count(database, "enrollment", `id IN (SELECT canonical_enrollment_id FROM registration_draft_child WHERE registration_draft_id = '${staffIntake.draftId}')`), 0, "staff-assisted intake does not create a canonical enrollment directly");
  const staffAudit = database.query(`SELECT actor_type AS actorType, actor_ref AS actorRef, metadata_json AS metadata FROM audit_event WHERE subject_id = ? AND action = 'registration.created_by_staff'`, [staffIntake.draftId])[0];
  assert.equal(staffAudit.actorType, "staff", "staff-assisted provenance records the staff actor type");
  assert.equal(staffAudit.actorRef, "staff-teacher", "staff-assisted provenance records the staff actor");
  assert.deepEqual(JSON.parse(staffAudit.metadata), { source: "staff_assisted", intakeChannel: "paper_form", guardianAcknowledged: true, childAcknowledged: true, receiptRequested: false, parentRulesVersion: "parent-rules-v1", studentRulesVersion: "student-rules-v1" }, "staff-assisted provenance stores the channel, acknowledgements, email choice, and exact active rule revisions");
  await assert.rejects(createRegistrationDraft(env(database), submission("class-second-offering"), new Date(iso(-4)), {
    staffAssisted: { staffAccountId: "staff-teacher", intakeChannel: "paper_form", parentAcknowledged: false, studentAcknowledged: true, receiptRequested: false },
  }), (error) => error.code === "staff_intake_not_acknowledged", "staff-assisted intake requires both recorded acknowledgements");
  database.query("UPDATE public_center_information SET homepage_intro = 'Нийтийн товч танилцуулга', teacher_bio = 'Тест багш' WHERE singleton = 1");
  database.query("INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at) VALUES ('annual-program-stage_1', 'annual_course', '1-р шат', 'stage_1', 'active', 1, 'registration-test', ?, ?)", [iso(), iso()]);
  database.query("UPDATE curriculum_program_family SET recommended_grade_min = '4', recommended_grade_max = '6', public_short_description = 'Нийтийн тайлбар', public_long_description = 'Нууц биш дэлгэрэнгүй' WHERE id = 'annual-program-stage_1'");
  const publicSite = await getPublicSiteModel(env(database), new Date(iso()));
  const publicStageOne = publicSite.programs.find((program) => program.stageCode === "stage_1");
  assert.equal(publicSite.center.homepageIntro, "Нийтийн товч танилцуулга", "public site uses typed center information");
  assert.equal(publicStageOne.current, true, "only catalog-visible active-window classes make a public Program current");
  assert.equal(publicStageOne.registerHref, "/register/?stage=stage_1", "public registration uses the authoritative stage route");
  assert.equal(publicStageOne.lessonCount, 0, "the test fixture has no public lesson detail and exposes only a count");
  assert.doesNotMatch(JSON.stringify(publicSite), /lessonTitle|internalNote/, "public-site model contains no curriculum lesson titles or notes");

  const one = await createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso()));
  assert.equal(one.hasPaymentHold, true);
  assert.equal(one.paymentDeadlineAt, iso(24 * 60), "accepted submission starts the 24-hour payment deadline without email verification");
  const initialDeadline = await getInitialPaymentDeadlineSetting(env(database));
  assert.equal(initialDeadline.deadlineMinutes, 1440, "the default initial-payment deadline is 24 hours");
  await assert.rejects(updateInitialPaymentDeadlineSetting(env(database), paymentStaff, { deadlineMinutes: 5, expectedUpdatedAt: initialDeadline.updatedAt }), "teacher/accountant cannot change the initial-payment deadline");
  const shortDeadline = await updateInitialPaymentDeadlineSetting(env(database), adminStaff, { deadlineMinutes: 5, expectedUpdatedAt: initialDeadline.updatedAt });
  assert.equal(shortDeadline.deadlineMinutes, 5, "admin can change the initial-payment deadline");
  assert.equal(one.paymentDeadlineAt, iso(24 * 60), "an existing registration retains its snapshotted deadline after the setting changes");
  const shortDeadlineDraft = await createRegistrationDraft(env(database), submission("class-second-offering"), new Date(iso(1)));
  assert.equal(shortDeadlineDraft.paymentDeadlineAt, iso(6), "a five-minute setting snapshots a five-minute deadline for a new registration");
  const shortHold = database.query(`SELECT id FROM registration_capacity_hold WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)`, [shortDeadlineDraft.draftId])[0];
  const shortQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso(7)));
  assert.ok(shortQueue.items.some((item) => item.paymentRequestId === database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [shortDeadlineDraft.draftId])[0].id), "an overdue initial reservation remains in the operational queue and is never auto-released");
  assert.equal(database.query(`SELECT status FROM registration_capacity_hold WHERE id = ?`, [shortHold.id])[0].status, "active", "passing the snapshotted deadline does not release capacity");
  const oneAccessToken = decodeURIComponent(one.accessCookie.match(/naran_registration_draft=([^;]+)/)[1]);
  const oneStatus = await registrationStatusForAccess(database, oneAccessToken, new Date(iso()));
  assert.equal(oneStatus.children[0].holdType, "initial_payment", "draft access immediately exposes the payment reservation");
  assert.equal(oneStatus.paymentCollection.iban, "MN00TEST0000000000", "configured IBAN appears in immediate parent payment instructions");
  const correctionDraft = await createRegistrationDraft(env(database), submission("class-second-offering"), new Date(iso(-2)));
  const correctionAccessToken = decodeURIComponent(correctionDraft.accessCookie.match(/naran_registration_draft=([^;]+)/)[1]);
  const correctionChild = database.query(`SELECT id FROM registration_draft_child WHERE registration_draft_id = ?`, [correctionDraft.draftId])[0].id;
  const correctionBefore = await registrationCorrectionDetail(env(database), registrationStaff, correctionChild);
  const correctionAfter = await saveRegistrationCorrection(env(database), registrationStaff, correctionChild, { ...correctionBefore, expectedDraftUpdatedAt: correctionBefore.draftUpdatedAt, expectedChildUpdatedAt: correctionBefore.childUpdatedAt,
    reason: "Бичгийн алдааг засав", guardianName: "Зассан Асран", primaryPhone: "99112233", email: "corrected@example.test", surname: "Зассан", givenName: "Хүүхэд", gender: "female", dateOfBirth: "2015-01-01", currentGrade: "5", homeAddress: "Тест хаяг" });
  assert.equal(correctionAfter.guardianName, "Зассан Асран", "teacher can correct ordinary guardian details");
  assert.equal(database.query("SELECT verified_at AS verifiedAt FROM registration_draft WHERE id = ?", [correctionDraft.draftId])[0].verifiedAt, null, "a changed email never inherits prior verification");
  assert.equal(count(database, "registration_data_correction", `registration_draft_child_id = '${correctionChild}'`), 1, "correction retains before/after history");
  assert.equal(count(database, "audit_event", `action = 'registration_data_corrected' AND subject_id = '${correctionChild}'`), 1, "correction is audited");
  const correctionAudit = JSON.parse(database.query("SELECT metadata_json AS metadata FROM audit_event WHERE action = 'registration_data_corrected' AND subject_id = ?", [correctionChild])[0].metadata);
  assert.equal(correctionAudit.reason, "Бичгийн алдааг засав", "correction audit retains the staff reason");
  assert.equal(correctionAudit.changes.find((change) => change.field === "guardianName").after, "Зассан Асран", "correction audit retains field-level before/after values");
  await assert.rejects(saveRegistrationCorrection(env(database), registrationStaff, correctionChild, { ...correctionBefore, expectedDraftUpdatedAt: correctionBefore.draftUpdatedAt, expectedChildUpdatedAt: correctionBefore.childUpdatedAt, reason: "Хуучин маягт", currentSchool: "Өөр сургууль" }), (error) => error.code === "conflict", "a stale correction cannot overwrite a newer change");
  const noOpBefore = await registrationCorrectionDetail(env(database), registrationStaff, correctionChild);
  const noOp = await saveRegistrationCorrection(env(database), registrationStaff, correctionChild, { ...noOpBefore, expectedDraftUpdatedAt: noOpBefore.draftUpdatedAt, expectedChildUpdatedAt: noOpBefore.childUpdatedAt, reason: "Давтан хадгалах" });
  assert.equal(noOp.unchanged, true, "a no-op correction creates no write");
  assert.equal(count(database, "registration_data_correction", `registration_draft_child_id = '${correctionChild}'`), 1, "a no-op correction creates no history row");
  const sharedDraft = await createRegistrationDraft(env(database), submission("class-second-offering"), new Date(iso(-2)));
  const sharedAccessToken = decodeURIComponent(sharedDraft.accessCookie.match(/naran_registration_draft=([^;]+)/)[1]);
  const guardianId = "guardian-correction";
  const canonicalNow = iso(-1);
  database.query(`INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, secondary_phone, secondary_phone_normalized, email, email_normalized, facebook_name, home_address, status, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`, [guardianId, "Зассан Асран", "99112233", "99112233", null, null, "corrected@example.test", "corrected@example.test", null, "Тест хаяг", `test:${correctionDraft.draftId}`, canonicalNow, canonicalNow]);
  database.query("UPDATE registration_draft SET canonical_guardian_account_id = ? WHERE id IN (?, ?)", [guardianId, correctionDraft.draftId, sharedDraft.draftId]);
  const canonicalBefore = await registrationCorrectionDetail(env(database), registrationStaff, correctionChild);
  assert.equal(canonicalBefore.guardianAffectedRegistrationCount, 2, "shared canonical guardian reports linked registrations");
  const canonicalAfter = await saveRegistrationCorrection(env(database), registrationStaff, correctionChild, { ...canonicalBefore, expectedDraftUpdatedAt: canonicalBefore.draftUpdatedAt, expectedChildUpdatedAt: canonicalBefore.childUpdatedAt, expectedGuardianUpdatedAt: canonicalBefore.canonicalGuardianUpdatedAt,
    reason: "Асран хамгаалагчийн хаягийг засав", guardianName: "Шинэ Асран", primaryPhone: "99119911", secondaryPhone: "88112233", email: "corrected@example.test", facebookName: "Шинэ Facebook", homeAddress: "Шинэ хаяг" });
  assert.equal(canonicalAfter.guardianName, "Шинэ Асран", "canonical guardian profile correction is authoritative");
  const sharedGuardian = database.query("SELECT full_name AS fullName, home_address AS homeAddress, facebook_name AS facebookName, primary_phone AS primaryPhone, secondary_phone AS secondaryPhone FROM guardian_account WHERE id = ?", [guardianId])[0];
  assert.deepEqual(sharedGuardian, { fullName: "Шинэ Асран", homeAddress: "Шинэ хаяг", facebookName: "Шинэ Facebook", primaryPhone: "99119911", secondaryPhone: "88112233" }, "canonical guardian receives audited profile and phone corrections");
  assert.equal(database.query("SELECT guardian_full_name AS guardianName, home_address AS homeAddress FROM registration_draft WHERE id = ?", [sharedDraft.draftId])[0].guardianName, "Шинэ Асран", "linked drafts follow the canonical guardian correction");
  assert.equal(database.query("SELECT guardian_full_name AS guardianName, home_address AS homeAddress FROM registration_draft WHERE id = ?", [sharedDraft.draftId])[0].homeAddress, "Шинэ хаяг", "linked draft address follows the canonical guardian correction");
  const accessNow = new Date().toISOString();
  const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const pendingChallenge = addChallenge(database, correctionDraft.draftId, "corrected@example.test", accessNow, accessExpiresAt);
  database.query(`INSERT INTO verified_email_session (id, normalized_email, session_token_hash, created_at, expires_at, revoked_at, is_test, test_run_id, registration_draft_id)
    VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`, ["correction-access-session", "corrected@example.test", createHash("sha256").update("correction-session").digest("hex"), accessNow, accessExpiresAt, `test:${correctionDraft.draftId}`, correctionDraft.draftId]);
  const protectedDetail = await registrationCorrectionDetail(env(database), registrationStaff, correctionChild);
  assert.equal(protectedDetail.emailProtected, true, "a linked verified or access-bound email is protected for the canonical guardian");
  assert.ok((await registrationStatusForAccess(database, correctionAccessToken, new Date(iso()))).children.length, "old draft access is valid before protected replacement");
  assert.ok((await registrationStatusForAccess(database, sharedAccessToken, new Date(iso()))).children.length, "shared linked draft access is valid before protected replacement");
  assert.ok((await getParentDashboard(env(database), "correction-session")).children.length >= 0, "old verified session reaches the canonical guardian dashboard before replacement");
  await assert.rejects(saveRegistrationCorrection(env(database), registrationStaff, correctionChild, { ...protectedDetail, expectedDraftUpdatedAt: protectedDetail.draftUpdatedAt, expectedChildUpdatedAt: protectedDetail.childUpdatedAt, expectedGuardianUpdatedAt: protectedDetail.canonicalGuardianUpdatedAt, reason: "Хориглосон", email: "other@example.test" }), (error) => error.code === "protected", "verified guardian contact remains protected");
  const outboxBeforeProtectedReplacement = count(database, "outbound_email");
  const contactReplacement = await replaceRegistrationEmail(env(database), registrationStaff, correctionChild, { email: "replacement@example.test", reason: "Хаяг солигдсон", confirmed: true, expectedDraftUpdatedAt: protectedDetail.draftUpdatedAt, expectedChildUpdatedAt: protectedDetail.childUpdatedAt, expectedGuardianUpdatedAt: protectedDetail.canonicalGuardianUpdatedAt });
  assert.equal(contactReplacement.email, "replacement@example.test", "protected email replacement updates the contact without automatic delivery");
  assert.equal(database.query("SELECT verified_at AS verifiedAt FROM registration_draft WHERE id = ?", [correctionDraft.draftId])[0].verifiedAt, null, "replacement email is unverified");
  assert.equal(database.query("SELECT email FROM registration_draft WHERE id = ?", [sharedDraft.draftId])[0].email, "replacement@example.test", "protected canonical replacement synchronizes linked draft email");
  assert.equal(database.query("SELECT status FROM email_verification_challenge WHERE id = ?", [pendingChallenge.id])[0].status, "invalidated", "protected replacement invalidates obsolete pending challenges");
  assert.ok(database.query("SELECT revoked_at AS revokedAt FROM verified_email_session WHERE id = ?", ["correction-access-session"])[0].revokedAt, "protected replacement revokes the old parent access session");
  await assert.rejects(registrationStatusForAccess(database, correctionAccessToken, new Date(iso())), (error) => error.code === "draft_access_denied", "old draft access cannot read the corrected registration");
  await assert.rejects(registrationStatusForAccess(database, sharedAccessToken, new Date(iso())), (error) => error.code === "draft_access_denied", "old draft access cannot read another registration linked to the shared guardian");
  await assert.rejects(registrationStatusForSession(database, "correction-session"), (error) => error.code === "session_required", "revoked old verified session cannot read the registration status");
  await assert.rejects(getParentDashboard(env(database), "correction-session"), (error) => error.code === "session_required", "revoked old verified session cannot read any linked canonical child");
  await assert.rejects(verifyEmailToken(env(database), pendingChallenge.rawToken, "correction-session"), (error) => error.code === "invalid_or_expired_token", "old pending challenge cannot be redeemed after replacement");
  assert.equal(count(database, "outbound_email"), outboxBeforeProtectedReplacement, "protected replacement queues no automatic email");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: "replacement-resend" }, { status: 200 });
  await sendParentAccessEmail(env(database, { RESEND_API_KEY: "test-resend-key", STAGING_EMAIL_OVERRIDE_TO: "safe@example.test" }), "replacement@example.test", correctionDraft.draftId, {
    eventType: "parent_enrollment_resend", templateKey: "parent_enrollment_resend_v1", context: {},
    template: () => ({ subject: "Тест", html: "Тест", text: "Тест" }),
  });
  globalThis.fetch = originalFetch;
  const resendChallenge = database.query("SELECT normalized_email AS email, status FROM email_verification_challenge WHERE registration_draft_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [correctionDraft.draftId])[0];
  assert.deepEqual(resendChallenge, { email: "replacement@example.test", status: "pending" }, "the later explicit resend creates a fresh challenge only for the replacement email");
  assert.equal(count(database, "audit_event", `action = 'registration_protected_email_replaced' AND subject_id = '${correctionChild}'`), 1, "protected replacement is separately audited");
  await assert.rejects(saveRegistrationCorrection(env(database), paymentStaff, correctionChild, { ...protectedDetail, expectedDraftUpdatedAt: protectedDetail.draftUpdatedAt, expectedChildUpdatedAt: protectedDetail.childUpdatedAt, reason: "Эрхгүй" }), "accountant cannot correct registration identity/contact data");
  assert.equal(count(database, "registration_capacity_hold", "class_session_id = 'class-last-seat' AND status = 'active'"), 1);
  const fullCatalog = await getRegistrationCatalog(database, "staging", new Date(iso()));
  assert.equal(fullCatalog.academicYears.flatMap((year) => year.classSessions).find((entry) => entry.id === "class-last-seat")?.availability, "full", "a full active-window class remains in the catalog as a waitlist target");
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
  const twoRequest = database.query(`SELECT id, payment_reference AS paymentReference, transfer_description AS transferDescription FROM payment_request WHERE registration_draft_id = ?`, [twoInstallment.draftId])[0];
  assert.match(twoRequest.paymentReference, /^NE-[A-Z2-9]{6}$/, "payment reference is stable, opaque, and copyable");
  assert.match(twoRequest.transferDescription, /^Хүүхэд 1 99000000(?: [2-9][0-9]?)?$/, "parent transfer description uses child name and the full guardian phone rather than the opaque request ID");
  assert.equal(count(database, "payment_installment", `payment_request_id = '${twoRequest.id}'`), 2, "two-installment snapshot creates two generic obligations");
  await claimParentPayment(database, twoRequest.id, twoInstallment.draftId, twoSession.rawToken, new Date(iso(-1)));
  await claimParentPayment(database, twoRequest.id, twoInstallment.draftId, twoSession.rawToken, new Date(iso(-1)));
  assert.equal(count(database, "payment_evidence", `payment_request_id = '${twoRequest.id}' AND evidence_type = 'parent_claim'`), 1, "parent paid claim is idempotent evidence only");
  const queueBeforePayment = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()));
  const twoQueueItem = queueBeforePayment.items.find((item) => item.paymentRequestId === twoRequest.id);
  assert.equal(twoQueueItem.parentClaimed, true, "parent claim is visible to staff without changing capacity");
  const checkedOperationId = randomUUID();
  assert.equal((await recordCheckedNotFound(env(database), paymentStaff, twoRequest.id, checkedOperationId, new Date(iso()))).idempotent, false, "the first payment-search note records one operation");
  assert.equal((await recordCheckedNotFound(env(database), paymentStaff, twoRequest.id, checkedOperationId, new Date(iso()))).idempotent, true, "an ambiguous retry reuses the operation instead of duplicating it");
  assert.equal(count(database, "payment_evidence", `payment_request_id = '${twoRequest.id}' AND evidence_type = 'staff_checked_not_found'`), 1, "rapid retries keep one payment-search evidence row");
  assert.equal(count(database, "audit_event", `subject_id = '${twoRequest.id}' AND action = 'payment_checked_not_found'`), 1, "rapid retries keep one payment-search audit event");
  const otherRequest = database.query(`SELECT id FROM payment_request WHERE id != ? ORDER BY id LIMIT 1`, [twoRequest.id])[0];
  await assert.rejects(
    recordCheckedNotFound(env(database), paymentStaff, otherRequest.id, checkedOperationId, new Date(iso())),
    (error) => error?.code === "conflict",
    "an operation ID already bound to another payment request cannot silently succeed",
  );
  assert.equal(count(database, "payment_evidence", `payment_request_id = '${otherRequest.id}' AND evidence_type = 'staff_checked_not_found'`), 0, "a cross-request replay records no evidence");
  await recordCheckedNotFound(env(database), paymentStaff, twoRequest.id, randomUUID(), new Date(iso()));
  assert.equal(count(database, "payment_evidence", `payment_request_id = '${twoRequest.id}' AND evidence_type = 'staff_checked_not_found'`), 2, "a later deliberate search records a new evidence event");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${twoInstallment.draftId}') AND status = 'active'`), 1, "checked-not-found never releases a seat");
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: twoRequest.id,
    allocations: [{ installmentId: twoQueueItem.installmentId, amountMnt: 450000 }],
    source: 'staff_manual_bank', receivedAt: '2026-08-11T07:53:00.000Z', idempotencyKey: 'two-initial-exact',
  }, new Date('2026-08-13T09:15:00.000Z'));
  assert.equal(database.query(`SELECT canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [twoInstallment.draftId])[0].enrollmentId, null, "tentative confirmation preserves a correction window before enrollment finalizes");
  await finalizeDuePaymentConfirmations(env(database), new Date('2026-08-13T09:21:00.000Z'));
  const duplicatePayment = await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: twoRequest.id,
    allocations: [{ installmentId: twoQueueItem.installmentId, amountMnt: 450000 }],
    source: 'staff_manual_bank', receivedAt: '2026-08-11T07:53:00.000Z', idempotencyKey: 'two-initial-exact',
  }, new Date('2026-08-13T09:16:00.000Z'));
  assert.equal(duplicatePayment.idempotent, true, "retrying the same manual confirmation does not create a duplicate payment");
  assert.equal(database.query(`SELECT received_at AS receivedAt, confirmed_at AS confirmedAt FROM received_payment WHERE idempotency_key = 'two-initial-exact'`)[0].receivedAt, '2026-08-11T07:53:00.000Z', "actual receipt time is preserved separately");
  assert.equal(database.query(`SELECT confirmed_at AS confirmedAt FROM received_payment WHERE idempotency_key = 'two-initial-exact'`)[0].confirmedAt, '2026-08-13T09:15:00.000Z', "staff confirmation time is preserved separately");
  const autoTwoChild = database.query(`SELECT id, canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [twoInstallment.draftId])[0];
  assert.ok(autoTwoChild.enrollmentId, "a full scheduled first installment automatically confirms a two-installment seat after grace");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${autoTwoChild.id}' AND status = 'active'`), 0, "automatic promotion transfers the original reservation without consuming a second seat");
  assert.equal(database.query(`SELECT remaining_payment_due_at AS remainingDueAt FROM payment_confirmation WHERE payment_request_id = ? ORDER BY created_at DESC LIMIT 1`, [twoRequest.id])[0].remainingDueAt, null,
    "the ordinary later-installment due date is not duplicated as a custom remaining-payment deadline");
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'later'`, [twoRequest.id])[0].status, 'pending', "later installment remains independent of initial seat confirmation");
  const confirmedTwoQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()));
  const confirmedTwoItem = confirmedTwoQueue.items.find((item) => item.paymentRequestId === twoRequest.id);
  assert.equal(confirmedTwoItem.allocatedAmountMnt, 450000, "the initial allocation remains the actual received amount");
  assert.equal(confirmedTwoItem.totalPaidMnt, 450000, "the confirmed-row paid projection includes authoritative allocations, not the required amount by label alone");
  assert.equal(confirmedTwoItem.totalRemainingMnt, 450000, "the confirmed-row remaining projection includes the independently pending later installment");
  const additionalPreviewCounts = Object.fromEntries(["registration_draft", "registration_capacity_hold", "payment_request", "discount_award", "audit_event", "outbound_email"]
    .map((table) => [table, count(database, table)]));
  const additionalPreview = await getAdditionalClassPreview(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id,
    targetClassSessionId: "class-roomy",
    paymentPlanCode: "two_installment",
    proposeBaseDiscount: true,
  }, new Date(iso()));
  const additionalTarget = additionalPreview.targets.find((target) => target.id === "class-roomy");
  assert.ok(additionalTarget, "staff additional-class preview uses a staff-eligible target even without consulting a public registration window");
  assert.notEqual(database.query(`SELECT test_run_id AS testRunId FROM registration_draft_child WHERE id = ?`, [autoTwoChild.id])[0].testRunId, "catalog-test", "the synthetic registration has its own scoped test run rather than the shared fixture run");
  const existingClassId = additionalPreview.currentClasses[0].classSessionId;
  assert.equal(additionalPreview.targets.some((target) => target.id === existingClassId), false, "an existing current enrollment in the same class is excluded from additional-class choices");
  assert.equal(additionalPreview.targets.find((target) => target.id === "class-full-preferred")?.selectable, false, "a full target is visible without becoming selectable or reserving a seat");
  assert.equal(additionalPreview.proposal.originalTotalMnt, 1000000, "preview keeps the selected two-installment agreement total rather than borrowing the one-payment price");
  assert.equal(database.query(`SELECT SUM(amount_mnt) AS totalMnt FROM payment_installment WHERE registration_draft_child_id = ?`, [autoTwoChild.id])[0].totalMnt, 900000,
    "the source agreement snapshot remains 900,000 MNT while the selected target's authoritative agreement is 1,000,000 MNT");
  assert.notEqual(additionalPreview.proposal.originalTotalMnt, 900000,
    "target preview pricing is derived from the target offering rather than copied from the source agreement");
  assert.equal(additionalPreview.proposal.firstInstallmentMnt, 500000, "a proposed base award leaves the original first installment intact");
  assert.equal(additionalPreview.proposal.secondInstallmentMnt, 400000, "a proposed ten-percent base award reduces the second installment");
  assert.equal(additionalPreview.proposal.totalAfterDiscountMnt, 900000, "preview arithmetic retains the selected-plan total less the proposed base award");
  assert.deepEqual(Object.fromEntries(["registration_draft", "registration_capacity_hold", "payment_request", "discount_award", "audit_event", "outbound_email"]
    .map((table) => [table, count(database, table)])), additionalPreviewCounts, "additional-class preview performs no business write");
  await assert.rejects(createAdditionalClassAdmissionService(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-stale-proposal-0001",
    policyUpdatedAt: additionalPreview.baseDiscount.policyUpdatedAt, proposedSourceAwardMnt: 0, proposedTargetAwardMnt: 0,
  }, new Date("2026-08-13T09:34:00.000Z")), (error) => error?.code === "stale",
  "the service rejects a browser proposal whose configured award totals no longer match the authoritative source and target calculation");
  database.query("UPDATE discount_policy_setting SET family_multi_child_basis_points = 750, updated_at = '2026-08-13T09:30:00.000Z' WHERE singleton = 1");
  const configuredRatePreview = await getAdditionalClassPreview(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment", proposeBaseDiscount: true,
  }, new Date(iso()));
  assert.equal(configuredRatePreview.baseDiscount.basisPoints, 750, "the preview exposes the configured family-policy rate rather than a hard-coded percentage");
  assert.equal(configuredRatePreview.proposal.baseDiscountMnt, 75000, "the proposed discount arithmetic uses the configured rate");
  assert.equal(configuredRatePreview.proposal.secondInstallmentMnt, 425000, "the configured rate still leaves the original first installment intact");
  database.query("UPDATE discount_policy_setting SET family_multi_child_basis_points = 0, updated_at = '2026-08-13T09:31:00.000Z' WHERE singleton = 1");
  const disabledRatePreview = await getAdditionalClassPreview(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment", proposeBaseDiscount: true,
  }, new Date(iso()));
  assert.equal(disabledRatePreview.baseDiscount.enabled, false, "a disabled policy does not fall back to a default discount");
  assert.equal(disabledRatePreview.proposal, null, "a disabled policy does not present an admission proposal without its configured award");
  database.query("UPDATE discount_policy_setting SET family_multi_child_basis_points = 1000, updated_at = '2026-08-13T09:32:00.000Z' WHERE singleton = 1");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${autoTwoChild.id}' AND award_type = 'family_multi_child' AND status = 'active'`), 0,
    "the source begins without a base award, so confirmation must activate both promises");
  const officialTwoInstallment = effectiveInstallments([
    { id: "official-source-first", registrationDraftChildId: "official-source", installmentNumber: 1, amountMnt: 650000, allocatedAmountMnt: 650000 },
    { id: "official-source-second", registrationDraftChildId: "official-source", installmentNumber: 2, amountMnt: 650000, allocatedAmountMnt: 0 },
    { id: "official-target-first", registrationDraftChildId: "official-target", installmentNumber: 1, amountMnt: 650000, allocatedAmountMnt: 0 },
    { id: "official-target-second", registrationDraftChildId: "official-target", installmentNumber: 2, amountMnt: 650000, allocatedAmountMnt: 0 },
  ], new Map([
    ["official-source", [{ awardAmountMnt: 130000, reason: "additional_class_canonical_confirmation" }]],
    ["official-target", [{ awardAmountMnt: 130000, reason: "additional_class_canonical_confirmation" }]],
  ]));
  assert.deepEqual(officialTwoInstallment.map((item) => item.effectiveAmountMnt), [650000, 520000, 650000, 520000],
    "a configured 10% award applies to each 1,300,000 MNT agreement's second installment, preserving both 650,000 MNT first installments");
  assert.equal(officialTwoInstallment.reduce((sum, item) => sum + item.effectiveAmountMnt, 0), 2340000,
    "the two agreement example totals 1,300,000 MNT first installments and 1,040,000 MNT second installments");
  const sourcePaymentHistory = count(database, "received_payment", `payment_request_id = '${twoRequest.id}'`);
  const sourceSeatCount = count(database, "enrollment", `id = '${autoTwoChild.enrollmentId}' AND status = 'confirmed'`);
  const admission = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-idempotency-0001",
  }, new Date("2026-08-13T09:35:00.000Z"));
  assert.equal(admission.created, true, "staff additional admission creates an ordinary pending draft");
  const admissionChild = admission.registrationDraftChildId;
  assert.ok(admissionChild, "the new class has its own draft child");
  assert.equal(count(database, "additional_class_admission", `target_registration_draft_child_id = '${admissionChild}' AND status = 'pending_confirmation'`), 1, "the accepted award promise is durable before payment");
  assert.equal(count(database, "enrollment", `student_id = (SELECT canonical_student_id FROM registration_draft_child WHERE id = '${autoTwoChild.id}') AND status = 'confirmed'`), sourceSeatCount, "creation does not insert a second canonical enrollment directly");
  assert.equal(count(database, "received_payment", `payment_request_id = '${twoRequest.id}'`), sourcePaymentHistory, "creation never changes source payment history");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${admissionChild}' AND status = 'active'`), 1, "the new class uses an ordinary atomic initial-payment hold");
  const admissionInstallments = database.query(`SELECT installment_kind AS kind, amount_mnt AS amountMnt FROM payment_installment WHERE registration_draft_child_id = ? ORDER BY installment_number`, [admissionChild]);
  assert.deepEqual(admissionInstallments.map((row) => Number(row.amountMnt)), [500000, 500000], "raw selected-plan installments remain immutable before confirmation");
  const replayAdmission = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-idempotency-0001",
  }, new Date("2026-08-13T09:36:00.000Z"));
  assert.equal(replayAdmission.created, false, "idempotent replay cannot create a second additional admission or hold");
  await assert.rejects(createAdditionalClassAdmission(env(database), { ...registrationStaff, capabilities: ["payment.view"] }, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-second-offering", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-denied-0001",
  }), AdditionalClassAdmissionError, "accountant-like staff cannot create an additional admission");
  const admissionRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [admission.draftId])[0];
  const admissionInitial = database.query(`SELECT id, amount_mnt AS amountMnt FROM payment_installment
    WHERE registration_draft_child_id = ? AND installment_kind = 'initial'`, [admissionChild])[0];
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: admissionRequest.id, allocations: [{ installmentId: admissionInitial.id, amountMnt: Number(admissionInitial.amountMnt) }],
    source: "staff_manual_bank", idempotencyKey: "additional-admission-first-payment-0001",
  }, new Date("2026-08-13T09:37:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:43:00.000Z"));
  assert.equal(count(database, "enrollment", `id = '${admissionChild}:enrollment' AND status = 'confirmed'`), 1, "ordinary finalization promotes only the additional class after its first installment");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${autoTwoChild.id}' AND award_type = 'family_multi_child' AND status = 'active'`), 1,
    "when neither agreement had the base award, target confirmation activates the source award exactly once");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${admissionChild}' AND award_type = 'family_multi_child' AND status = 'active'`), 1, "confirmation activates the target's missing base award once");
  assert.deepEqual(database.query(`SELECT basis_points AS basisPoints, base_amount_mnt AS baseAmountMnt, award_amount_mnt AS awardAmountMnt
    FROM discount_award WHERE registration_draft_child_id IN (?, ?) AND award_type = 'family_multi_child' AND status = 'active'
    ORDER BY base_amount_mnt`, [autoTwoChild.id, admissionChild]), [
    { basisPoints: 1000, baseAmountMnt: 900000, awardAmountMnt: 90000 },
    { basisPoints: 1000, baseAmountMnt: 1000000, awardAmountMnt: 100000 },
  ], "both awards use the configured policy instead of hard-coded percentages");
  // Simulate an interruption after durable enrollment promotion but before
  // award activation. The ordinary finalizer must recover this exact pending
  // admission without another payment, enrollment, or capacity mutation.
  database.query(`UPDATE additional_class_admission SET status = 'pending_confirmation', activated_at = NULL
    WHERE target_registration_draft_child_id = ?;
    DELETE FROM discount_award WHERE registration_draft_child_id IN (?, ?) AND award_type = 'family_multi_child'`,
    [admissionChild, autoTwoChild.id, admissionChild]);
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:43:30.000Z"));
  assert.equal(count(database, "additional_class_admission", `target_registration_draft_child_id = '${admissionChild}' AND status = 'confirmed'`), 1,
    "the finalizer durably recovers award activation after an interrupted promotion");
  assert.equal(count(database, "discount_award", `registration_draft_child_id IN ('${autoTwoChild.id}', '${admissionChild}') AND award_type = 'family_multi_child' AND status = 'active'`), 2,
    "recovery restores exactly one award on each agreement without another enrollment");
  assert.equal(count(database, "enrollment", `id = '${admissionChild}:enrollment' AND status = 'confirmed'`), 1,
    "award recovery does not duplicate the already confirmed target enrollment");
  const additionalQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()));
  const sourceQueue = additionalQueue.items.find((item) => item.registrationDraftChildId === autoTwoChild.id);
  const targetQueue = additionalQueue.items.find((item) => item.registrationDraftChildId === admissionChild);
  assert.deepEqual({
    originalTotalMnt: 900000,
    awardMnt: 90000,
    paidMnt: sourceQueue.totalPaidMnt,
    netRemainingMnt: sourceQueue.totalRemainingMnt,
  }, {
    originalTotalMnt: 900000,
    awardMnt: 90000,
    paidMnt: 450000,
    netRemainingMnt: 360000,
  }, "the authoritative staff queue exposes the source agreement's net post-award balance, not its raw second installment");
  assert.deepEqual({
    originalTotalMnt: 1000000,
    awardMnt: 100000,
    paidMnt: targetQueue.totalPaidMnt,
    netRemainingMnt: targetQueue.totalRemainingMnt,
  }, {
    originalTotalMnt: 1000000,
    awardMnt: 100000,
    paidMnt: 500000,
    netRemainingMnt: 400000,
  }, "the authoritative staff queue applies the target agreement's own award and price snapshot independently of the source");
  const additionalEffective = await getAdditionalClassPreview(env(database), registrationStaff, { registrationDraftChildId: admissionChild }, new Date(iso()));
  const admitted = additionalEffective.currentClasses.find((entry) => entry.classSessionId === "class-roomy");
  assert.ok(admitted, `the admitted class appears alongside the existing class: ${JSON.stringify(additionalEffective.currentClasses)}`);
  assert.equal(admitted.discountMnt, 100000, "the admitted class projects its promised configured award");
  assert.equal(database.query(`SELECT effective_due_at AS dueAt, amount_mnt AS amountMnt FROM payment_installment
    WHERE registration_draft_child_id = ? AND installment_kind = 'later'`, [admissionChild])[0].amountMnt, 500000, "the raw second-installment snapshot stays immutable");
  assert.equal(count(database, "additional_class_admission", `target_registration_draft_child_id = '${admissionChild}' AND status = 'confirmed'`), 1, "activation is durably marked for retry-safe promotion");
  const confirmedReplay = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-idempotency-0001",
  }, new Date("2026-08-13T09:44:00.000Z"));
  assert.equal(confirmedReplay.lifecycleStatus, "confirmed", "a replay after promotion returns the existing confirmed admission even though its hold is gone");
  assert.equal(count(database, "enrollment", `id = '${admissionChild}:enrollment' AND status = 'confirmed'`), 1, "confirmed-admission replay cannot create another enrollment");
  database.query(`UPDATE enrollment SET transferred_out_at = ? WHERE id = ?`, [iso(), autoTwoChild.enrollmentId]);
  const replayAfterSourceChange = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-idempotency-0001",
  }, new Date("2026-08-13T09:44:30.000Z"));
  assert.equal(replayAfterSourceChange.lifecycleStatus, "confirmed", "a completed operation remains recoverable after a later source lifecycle change");
  database.query(`UPDATE enrollment SET transferred_out_at = NULL WHERE id = ?`, [autoTwoChild.enrollmentId]);
  await assert.rejects(createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-last-seat", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-idempotency-0001",
  }), (error) => error?.code === "conflict", "an operation key cannot be replayed against another target class");
  await cancelRegistration(env(database), registrationStaff, { registrationDraftChildId: admissionChild, reason: "guardian_request" }, new Date("2026-08-13T09:45:00.000Z"));
  const existingAwardTarget = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-existing-award-0001",
  }, new Date("2026-08-13T09:46:00.000Z"));
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${autoTwoChild.id}' AND award_type = 'family_multi_child' AND status = 'active'`), 1,
    "a source with an existing base award remains unchanged when a later target admission is created");
  const existingAwardRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [existingAwardTarget.draftId])[0];
  const existingAwardInitial = database.query(`SELECT id, amount_mnt AS amountMnt FROM payment_installment
    WHERE registration_draft_child_id = ? AND installment_kind = 'initial'`, [existingAwardTarget.registrationDraftChildId])[0];
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: existingAwardRequest.id, allocations: [{ installmentId: existingAwardInitial.id, amountMnt: Number(existingAwardInitial.amountMnt) }],
    source: "staff_manual_bank", idempotencyKey: "additional-admission-existing-award-payment",
  }, new Date("2026-08-13T09:47:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:53:00.000Z"));
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${autoTwoChild.id}' AND award_type = 'family_multi_child' AND status = 'active'`), 1,
    "promotion never duplicates the source's pre-existing base award");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${existingAwardTarget.registrationDraftChildId}' AND award_type = 'family_multi_child' AND status = 'active'`), 1,
    "only the newly confirmed target receives its missing base award");
  await cancelRegistration(env(database), registrationStaff, { registrationDraftChildId: existingAwardTarget.registrationDraftChildId, reason: "guardian_request" }, new Date("2026-08-13T09:54:00.000Z"));
  const pendingCancellation = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-cancelled-0001",
  }, new Date("2026-08-13T09:55:00.000Z"));
  await cancelRegistration(env(database), registrationStaff, { registrationDraftChildId: pendingCancellation.registrationDraftChildId, reason: "guardian_request" }, new Date("2026-08-13T09:56:00.000Z"));
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${pendingCancellation.registrationDraftChildId}' AND award_type = 'family_multi_child' AND status = 'active'`), 0,
    "cancellation before target confirmation activates neither a new target award nor another source award");
  const cancelledReplay = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-cancelled-0001",
  }, new Date("2026-08-13T09:48:00.000Z"));
  assert.equal(cancelledReplay.lifecycleStatus, "cancelled", "a terminal admission replay reports its truthful state without recreating a hold");
  const pendingExpiry = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-expired-0001",
  }, new Date("2026-08-13T09:49:00.000Z"));
  database.query(`UPDATE registration_draft SET status = 'expired' WHERE id = ?`, [pendingExpiry.draftId]);
  assert.equal((await promotePaidDraftChild(env(database), paymentStaff, pendingExpiry.registrationDraftChildId, null, new Date("2026-08-13T09:50:00.000Z"))).state, "not_eligible",
    "an expired pending target cannot be promoted by a late payment finalizer");
  assert.equal(count(database, "additional_class_admission", `target_registration_draft_child_id = '${pendingExpiry.registrationDraftChildId}' AND status = 'expired'`), 1,
    "expiry marks the proposal terminal before any target confirmation");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${pendingExpiry.registrationDraftChildId}' AND status = 'active'`), 0,
    "expiry before confirmation activates no proposed award");
  const expiredReplay = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-expired-0001",
  }, new Date("2026-08-13T09:51:00.000Z"));
  assert.equal(expiredReplay.lifecycleStatus, "expired", "an expired admission replay remains terminal and does not recreate a reservation");
  database.query(`UPDATE registration_capacity_hold SET status = 'released', release_reason = 'test_expiry_cleanup'
    WHERE registration_draft_child_id = ? AND status = 'active'`, [pendingExpiry.registrationDraftChildId]);
  const cancellationRace = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-cancellation-race-0001",
  }, new Date("2026-08-13T09:52:00.000Z"));
  const raceRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [cancellationRace.draftId])[0];
  const raceInitial = database.query(`SELECT id, amount_mnt AS amountMnt FROM payment_installment
    WHERE registration_draft_child_id = ? AND installment_kind = 'initial'`, [cancellationRace.registrationDraftChildId])[0];
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: raceRequest.id, allocations: [{ installmentId: raceInitial.id, amountMnt: Number(raceInitial.amountMnt) }],
    source: "staff_manual_bank", idempotencyKey: "additional-admission-cancellation-race-payment",
  }, new Date("2026-08-13T09:53:00.000Z"));
  await cancelRegistration(env(database), registrationStaff, { registrationDraftChildId: cancellationRace.registrationDraftChildId, reason: "guardian_request" }, new Date("2026-08-13T09:54:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T10:00:00.000Z"));
  assert.equal(count(database, "enrollment", `id = '${cancellationRace.registrationDraftChildId}:enrollment' AND status = 'confirmed'`), 0,
    "a cancellation winning the race against finalization cannot produce a late target enrollment");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${cancellationRace.registrationDraftChildId}' AND status = 'active'`), 0,
    "a cancellation winning the race cannot activate a target award");
  const sourceChangeRace = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-source-change-race-0001",
  }, new Date("2026-08-13T10:01:00.000Z"));
  const sourceChangeRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [sourceChangeRace.draftId])[0];
  const sourceChangeInitial = database.query(`SELECT id, amount_mnt AS amountMnt FROM payment_installment
    WHERE registration_draft_child_id = ? AND installment_kind = 'initial'`, [sourceChangeRace.registrationDraftChildId])[0];
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: sourceChangeRequest.id, allocations: [{ installmentId: sourceChangeInitial.id, amountMnt: Number(sourceChangeInitial.amountMnt) }],
    source: "staff_manual_bank", idempotencyKey: "additional-admission-source-change-race-payment",
  }, new Date("2026-08-13T10:02:00.000Z"));
  database.query(`UPDATE enrollment SET transferred_out_at = ? WHERE id = ?`, [iso(), autoTwoChild.enrollmentId]);
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T10:08:00.000Z"));
  assert.equal(count(database, "enrollment", `id = '${sourceChangeRace.registrationDraftChildId}:enrollment' AND status = 'confirmed'`), 0,
    "a source superseded before target confirmation blocks target promotion");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${sourceChangeRace.registrationDraftChildId}' AND status = 'active'`), 0,
    "a superseded source cannot silently produce a target award");
  database.query(`UPDATE enrollment SET transferred_out_at = NULL WHERE id = ?`, [autoTwoChild.enrollmentId]);
  await cancelRegistration(env(database), registrationStaff, { registrationDraftChildId: sourceChangeRace.registrationDraftChildId, reason: "guardian_request" }, new Date("2026-08-13T10:09:00.000Z"));
  database.query("UPDATE activity_offering SET is_test = 0, test_run_id = NULL WHERE id IN (SELECT activity_offering_id FROM class_session WHERE academic_year_id = 'year-test')");
  const provenanceMismatchPreview = await getAdditionalClassPreview(env(database), registrationStaff, { registrationDraftChildId: autoTwoChild.id }, new Date(iso()));
  assert.equal(provenanceMismatchPreview.targetAvailability, "source_provenance_mismatch", "an inconsistent source aggregate is reported separately from an empty target selector");
  database.query("UPDATE activity_offering SET is_test = 1, test_run_id = 'catalog-test' WHERE id IN (SELECT activity_offering_id FROM class_session WHERE academic_year_id = 'year-test')");
  database.query("UPDATE discount_policy_setting SET family_multi_child_basis_points = 1000, updated_at = '2026-08-13T09:33:00.000Z' WHERE singleton = 1");
  await assert.rejects(getAdditionalClassPreview(env(database), { ...registrationStaff, capabilities: ["payment.view"] }, {
    registrationDraftChildId: autoTwoChild.id,
  }, new Date(iso())), AdditionalClassPreviewError, "accountant-like staff cannot open the additional-class preview");

  // A durable confirmation claim is the exact boundary between target
  // promotion and promised-award activation. While it is live, a source
  // transfer or cancellation must retry instead of overtaking the admission.
  const claimedAdmission = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-live-claim-0001",
  }, new Date("2026-08-13T10:10:00.000Z"));
  const claimedRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [claimedAdmission.draftId])[0];
  const claimedInitial = database.query(`SELECT id, amount_mnt AS amountMnt FROM payment_installment
    WHERE registration_draft_child_id = ? AND installment_kind = 'initial'`, [claimedAdmission.registrationDraftChildId])[0];
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: claimedRequest.id, allocations: [{ installmentId: claimedInitial.id, amountMnt: Number(claimedInitial.amountMnt) }],
    source: "staff_manual_bank", approveSeatConfirmation: true, idempotencyKey: "additional-admission-live-claim-payment",
  }, new Date("2026-08-13T10:11:00.000Z"));
  // Freeze the ordinary payment finalization at its completed boundary so the
  // following interleaving isolates only additional-admission coordination.
  database.query(`UPDATE payment_confirmation SET status = 'finalized', finalized_at = ?, updated_at = ?
    WHERE payment_request_id = ?`, ["2026-08-13T10:11:00.000Z", "2026-08-13T10:11:00.000Z", claimedRequest.id]);
  database.query(`UPDATE payment_installment SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?`,
    ["2026-08-13T10:11:00.000Z", "2026-08-13T10:11:00.000Z", claimedInitial.id]);
  const staleWorkerClaim = await claimAdditionalAdmissionConfirmation(env(database), claimedAdmission.registrationDraftChildId,
    new Date("2026-08-13T10:12:00.000Z"));
  assert.equal(staleWorkerClaim.state, "claimed", "worker A acquires a durable confirmation claim");
  const transferTargets = await listClassTransferTargets(env(database), registrationStaff, autoTwoChild.id, new Date("2026-08-13T10:12:30.000Z"));
  const transferTarget = transferTargets.targets.find((target) => target.classSessionId === "class-second-offering");
  assert.ok(transferTarget, "an active source still has an eligible lower-price transfer target while confirmation is claimed");
  const sourceVersion = database.query(`SELECT updated_at AS version FROM enrollment WHERE id = ?`, [autoTwoChild.enrollmentId])[0].version;
  const claimedTransfer = await initiateClassTransfer(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-second-offering", reason: "Claim race",
    idempotencyKey: "additional-admission-live-claim-transfer", expectedSourceVersion: sourceVersion,
    expectedTargetVersion: transferTarget.eligibilityVersion,
  }, new Date("2026-08-13T10:12:30.000Z"));
  await assert.rejects(() => completeClassTransfer(env(database), registrationStaff, {
    transferId: claimedTransfer.transferId, expectedVersion: claimedTransfer.version,
  }, new Date("2026-08-13T10:12:45.000Z")), (error) => error?.code === "confirmation_in_progress",
  "source transfer completion is blocked by the live durable confirmation claim");
  assert.equal(count(database, "enrollment", `id = '${autoTwoChild.enrollmentId}' AND transferred_out_at IS NOT NULL`), 0,
    "a blocked transfer leaves the source enrollment current");
  await assert.rejects(() => cancelRegistration(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, reason: "guardian_request",
  }, new Date("2026-08-13T10:12:50.000Z")), (error) => error?.code === "confirmation_in_progress",
  "source cancellation is also blocked by the same live confirmation claim");
  await closeClassTransfer(env(database), registrationStaff, {
    transferId: claimedTransfer.transferId, reason: "Race test closed", expectedVersion: claimedTransfer.version,
  }, new Date("2026-08-13T10:13:00.000Z"));
  const reclaimingWorkerClaim = await claimAdditionalAdmissionConfirmation(env(database), claimedAdmission.registrationDraftChildId,
    new Date("2026-08-13T10:15:00.000Z"));
  assert.equal(reclaimingWorkerClaim.state, "claimed", "worker B reclaims the expired confirmation claim with a new fence");
  const staleCompletion = await finalizeAdditionalAdmissionClaim(env(database), paymentStaff, claimedAdmission.registrationDraftChildId,
    staleWorkerClaim, "2026-08-13T10:15:00.000Z");
  assert.equal(staleCompletion, null, "a resumed worker A cannot write after worker B has reclaimed its fence");
  assert.equal(count(database, "enrollment", `id = '${claimedAdmission.registrationDraftChildId}:enrollment'`), 0,
    "a stale continuation creates neither enrollment nor award side effects");
  const winningCompletion = await finalizeAdditionalAdmissionClaim(env(database), paymentStaff, claimedAdmission.registrationDraftChildId,
    reclaimingWorkerClaim, "2026-08-13T10:15:00.000Z");
  assert.ok(winningCompletion?.enrollmentId, "the fence owner completes the admission once");
  assert.equal(count(database, "additional_class_admission", `target_registration_draft_child_id = '${claimedAdmission.registrationDraftChildId}' AND status = 'confirmed'`), 1,
    "a stale claimed admission is recovered to one terminal confirmed result by concurrent finalizer retries");
  assert.equal(count(database, "enrollment", `id = '${claimedAdmission.registrationDraftChildId}:enrollment' AND status = 'confirmed'`), 1,
    "recovery after an interrupted claim creates exactly one target enrollment");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${claimedAdmission.registrationDraftChildId}' AND award_type = 'family_multi_child' AND status = 'active'`), 1,
    "recovery activates the promised target award exactly once");
  await cancelRegistration(env(database), registrationStaff, {
    registrationDraftChildId: claimedAdmission.registrationDraftChildId, reason: "guardian_request",
  }, new Date("2026-08-13T10:18:30.000Z"));

  // A source action must not silently strand an unpaid target. Until the target
  // is explicitly resolved through its own lifecycle, the source action is
  // actionable-but-blocked; after target cancellation, source cancellation is
  // safe and no finalizer can revive the terminal target.
  const sourceCancellationWins = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, targetClassSessionId: "class-roomy", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-source-cancellation-wins-0001",
  }, new Date("2026-08-13T10:19:00.000Z"));
  await assert.rejects(() => cancelRegistration(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, reason: "guardian_request",
  }, new Date("2026-08-13T10:19:30.000Z")), (error) => error?.code === "additional_admission_pending",
  "source cancellation explains that its pending additional admission must be resolved first");
  await cancelRegistration(env(database), registrationStaff, {
    registrationDraftChildId: sourceCancellationWins.registrationDraftChildId, reason: "guardian_request",
  }, new Date("2026-08-13T10:19:45.000Z"));
  await cancelRegistration(env(database), registrationStaff, {
    registrationDraftChildId: autoTwoChild.id, reason: "guardian_request",
  }, new Date("2026-08-13T10:20:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T10:26:00.000Z"));
  assert.equal(count(database, "additional_class_admission", `target_registration_draft_child_id = '${sourceCancellationWins.registrationDraftChildId}' AND status = 'cancelled'`), 1,
    "an explicitly cancelled pending target remains terminal after later source cancellation");
  assert.equal(count(database, "enrollment", `id = '${sourceCancellationWins.registrationDraftChildId}:enrollment'`), 0,
    "a finalizer cannot resurrect a target after the source cancellation won");

  const strandedInput = submission("class-priced", undefined, 1, "two_installment");
  strandedInput.children[0].givenName = "Finalizer retry";
  const strandedPromotion = await createRegistrationDraft(env(database), strandedInput, new Date(iso(-3)));
  const strandedRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [strandedPromotion.draftId])[0];
  const strandedQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()));
  const strandedItem = strandedQueue.items.find((item) => item.paymentRequestId === strandedRequest.id);
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: strandedRequest.id,
    allocations: [{ installmentId: strandedItem.installmentId, amountMnt: Number(strandedItem.expectedAmountMnt) }],
    source: 'staff_manual_bank', idempotencyKey: 'stranded-finalizer-retry',
  }, new Date('2026-08-13T09:15:00.000Z'));
  await finalizeDuePaymentConfirmations(env(database), new Date('2026-08-13T09:21:00.000Z'));
  const strandedChildId = database.query(`SELECT id FROM registration_draft_child WHERE registration_draft_id = ?`, [strandedPromotion.draftId])[0].id;
  database.query(`UPDATE registration_draft_child SET canonical_enrollment_id = NULL, canonical_student_id = NULL,
    canonical_application_child_id = NULL, identity_resolution_status = 'not_eligible', promotion_status = 'not_eligible'
    WHERE registration_draft_id = ?`, [strandedPromotion.draftId]);
  database.query(`DELETE FROM enrollment WHERE test_run_id = 'registration-test' AND id LIKE ?`, [`${strandedChildId}:enrollment`]);
  database.query(`UPDATE registration_capacity_hold SET status = 'active', converted_at = NULL, release_reason = NULL
    WHERE registration_draft_child_id = ?`, [strandedChildId]);
  await finalizeDuePaymentConfirmations(env(database), new Date('2026-08-13T09:22:00.000Z'));
  assert.ok(database.query(`SELECT canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [strandedPromotion.draftId])[0].enrollmentId,
    "the finalizer retries only a finalized approved child stranded by a stale not_eligible promotion state");
  assert.equal(count(database, "audit_event", `action = 'payment_confirmation_promotion_retried' AND subject_id = '${strandedPromotion.draftId}'`), 1,
    "the narrowly scoped finalizer recovery remains auditable");

  const approvedTwoInput = submission("class-priced", undefined, 1, "two_installment");
  approvedTwoInput.children[0].givenName = "Авто баталгаа";
  const approvedTwoInstallment = await createRegistrationDraft(env(database), approvedTwoInput, new Date(iso(-3)));
  const approvedTwoRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [approvedTwoInstallment.draftId])[0];
  const approvedTwoQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()));
  const approvedTwoItem = approvedTwoQueue.items.find((item) => item.paymentRequestId === approvedTwoRequest.id);
  const approvedTwoPayment = await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: approvedTwoRequest.id,
    allocations: [{ installmentId: approvedTwoItem.installmentId, amountMnt: Number(approvedTwoItem.expectedAmountMnt) }],
    source: 'staff_manual_bank', idempotencyKey: 'two-initial-approved',
  }, new Date('2026-08-13T09:15:00.000Z'));
  assert.equal(database.query(`SELECT seat_confirmation_approved AS approved, remaining_payment_due_at AS remainingDueAt FROM payment_confirmation WHERE received_payment_id = ?`, [approvedTwoPayment.id])[0].approved, 1,
    "a full first installment automatically persists the durable seat-approval decision");
  assert.equal(database.query(`SELECT remaining_payment_due_at AS remainingDueAt FROM payment_confirmation WHERE received_payment_id = ?`, [approvedTwoPayment.id])[0].remainingDueAt, null,
    "the existing later-installment due date is not replaced with an artificial remaining-balance deadline");
  await finalizeDuePaymentConfirmations(env(database), new Date('2026-08-13T09:21:00.000Z'));
  const approvedTwoChild = database.query(`SELECT id, canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [approvedTwoInstallment.draftId])[0];
  assert.ok(approvedTwoChild.enrollmentId, "a finalized full first installment creates the canonical enrollment before the later installment is paid");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${approvedTwoChild.id}' AND status = 'active'`), 0,
    "promotion replaces the original hold instead of consuming a second seat");
  assert.equal(count(database, "enrollment", `id = '${approvedTwoChild.enrollmentId}' AND status = 'confirmed'`), 1,
    "checked first-installment promotion creates exactly one confirmed enrollment");
  assert.equal(database.query(`SELECT effective_due_at AS dueAt, status FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'later'`, [approvedTwoRequest.id])[0].status, 'pending',
    "seat confirmation leaves the later installment active and independently due");
  const approvedTwoRetry = await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: approvedTwoRequest.id,
    allocations: [{ installmentId: approvedTwoItem.installmentId, amountMnt: Number(approvedTwoItem.expectedAmountMnt) }],
    source: 'staff_manual_bank', idempotencyKey: 'two-initial-approved',
  }, new Date('2026-08-13T09:22:00.000Z'));
  assert.equal(approvedTwoRetry.idempotent, true, "retrying an automatically confirmed first installment cannot create a second payment or seat");

  // Child credit is an immutable child-level ledger. It supplements the normal
  // agreement allocations without manufacturing another received payment.
  const approvedTwoStudent = database.query(`SELECT canonical_student_id AS studentId FROM registration_draft_child WHERE id = ?`, [approvedTwoChild.id])[0];
  const approvedTwoLater = database.query(`SELECT id FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'later'`, [approvedTwoRequest.id])[0];
  const receivedBeforeCredit = count(database, "received_payment", `payment_request_id = '${approvedTwoRequest.id}'`);
  const addCreditOperation = randomUUID();
  const addedCredit = await addManualChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, amountMnt: 200000, reason: "Илүү төлөлтийн нягтлангийн засвар", externalReference: "CASH-TEST-01", operationId: addCreditOperation,
  }, new Date('2026-08-13T09:23:00.000Z'));
  await assert.rejects(applyChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, paymentInstallmentId: approvedTwoItem.installmentId,
    amountMnt: 1, reason: "Эхний төлбөрт хэрэглэхгүй", operationId: randomUUID(),
  }), { code: "invalid" }, "a two-installment agreement's first installment remains cash-only even when child credit exists");
  assert.equal(addedCredit.availableAmountMnt, 200000, "a manual accounting adjustment creates usable child credit");
  assert.equal(count(database, "received_payment", `payment_request_id = '${approvedTwoRequest.id}'`), receivedBeforeCredit,
    "a manual credit is never fabricated as a bank or cash receipt");
  const repeatedCredit = await addManualChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, amountMnt: 200000, reason: "Илүү төлөлтийн нягтлангийн засвар", externalReference: "CASH-TEST-01", operationId: addCreditOperation,
  }, new Date('2026-08-13T09:23:30.000Z'));
  assert.equal(repeatedCredit.idempotent, true, "a duplicate manual-credit retry returns the same immutable operation");
  assert.equal(count(database, "child_credit_operation", `id = '${addCreditOperation}'`), 1, "a retry cannot create a second manual adjustment");
  const manualRoot = (await childCreditSummary(database, approvedTwoStudent.studentId)).roots.find((entry) => entry.entryKind === "manual_addition");
  assert.ok(manualRoot, "manual credit has a durable ledger root");
  await correctChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, entryId: manualRoot.id, adjustmentMnt: 50000, reason: "Дутуу бүртгэгдсэн засвар", operationId: randomUUID(),
  }, new Date('2026-08-13T09:24:00.000Z'));
  const appliedCredit = await applyChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, paymentInstallmentId: approvedTwoLater.id, amountMnt: 100000, reason: "Дараагийн төлбөрт тооцсон", operationId: randomUUID(),
  }, new Date('2026-08-13T09:25:00.000Z'));
  assert.equal(appliedCredit.availableAmountMnt, 150000, "credit application reduces only the available ledger balance");
  assert.equal(count(database, "received_payment", `payment_request_id = '${approvedTwoRequest.id}'`), receivedBeforeCredit,
    "applying child credit does not alter immutable received-payment history");
  assert.equal(Number(database.query(`SELECT SUM(-amount_mnt) AS applied FROM child_credit_entry WHERE payment_installment_id = ? AND entry_kind = 'credit_application'`, [approvedTwoLater.id])[0].applied), 100000,
    "the later installment receives one explicit credit allocation");
  const creditQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date('2026-08-13T09:25:30.000Z'));
  const creditedAgreement = creditQueue.items.find((item) => item.paymentRequestId === approvedTwoRequest.id);
  assert.equal(creditedAgreement.totalPaidMnt, 500000, "credit application does not inflate the received-payment total shown to staff");
  assert.equal(creditedAgreement.totalCreditAppliedMnt, 100000, "staff see applied credit separately from cash payment history");
  assert.equal(creditedAgreement.totalRemainingMnt, 400000, "the next outstanding installment is reduced by the authoritative credit allocation");
  assert.equal(creditedAgreement.creditApplicationInstallmentId, approvedTwoLater.id, "the staff credit action targets the actual later obligation after the initial installment is satisfied");
  await assert.rejects(correctChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, entryId: manualRoot.id, adjustmentMnt: -200000, reason: "Хэт засвар", operationId: randomUUID(),
  }, new Date('2026-08-13T09:26:00.000Z')), (error) => error?.code === "insufficient",
  "a correction cannot erase credit already applied to an obligation");
  const afterPartialCorrection = await correctChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, entryId: manualRoot.id, adjustmentMnt: -50000, reason: "Хэсэгчилсэн засвар", operationId: randomUUID(),
  }, new Date('2026-08-13T09:26:30.000Z'));
  assert.equal(afterPartialCorrection.availableAmountMnt, 100000, "a linked correction may reduce only still-available value");
  const transferredCredit = await transferChildCredit(env(database), paymentStaff, {
    sourceRegistrationDraftChildId: approvedTwoChild.id, targetRegistrationDraftChildId: strandedChildId, amountMnt: 25000, reason: "Өөр хүүхдэд шилжүүлсэн", operationId: randomUUID(),
  }, new Date('2026-08-13T09:27:00.000Z'));
  assert.equal(transferredCredit.source.availableAmountMnt, 75000, "cross-child transfer debits the source ledger once");
  assert.equal(transferredCredit.target.availableAmountMnt, 25000, "cross-child transfer creates one destination ledger credit");
  const reviewBefore = await creditPaymentReviewState(database, approvedTwoChild.id, approvedTwoLater.id);
  assert.equal(reviewBefore.availableCreditMnt, 75000,
    "the review sees the partial usable credit remaining after a linked cross-child transfer");
  assert.equal(reviewBefore.outstandingAmountMnt, 400000,
    "the review retains the larger cash obligation rather than requiring full credit coverage");
  assert.equal(reviewBefore.reviewed, false, "usable credit keeps the affected cash demand awaiting a staff decision");
  await leaveChildCreditUnused(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, paymentInstallmentId: approvedTwoLater.id, reason: "Асран хамгаалагч бэлнээр үргэлжлүүлнэ", operationId: randomUUID(),
  }, new Date('2026-08-13T09:27:30.000Z'));
  assert.equal((await creditPaymentReviewState(database, approvedTwoChild.id, approvedTwoLater.id)).reviewed, true,
    "an explicit leave-unused decision releases only this reviewed demand to the ordinary scheduler");
  await addManualChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, amountMnt: 1, reason: "Шинэ нөхцөл", operationId: randomUUID(),
  }, new Date('2026-08-13T09:28:00.000Z'));
  assert.equal((await creditPaymentReviewState(database, approvedTwoChild.id, approvedTwoLater.id)).reviewed, false,
    "a changed credit balance invalidates an earlier leave-unused decision and requires review again");
  const reminderProvider = { async send() { return { providerMessageId: randomUUID() }; } };
  const reminderNow = new Date('2026-12-01T10:00:00.000Z');
  await processDuePaymentReminders(env(database, { RESEND_API_KEY: 'test-reminder-key', STAGING_EMAIL_OVERRIDE_TO: 'safe@example.test' }), reminderNow, reminderProvider);
  assert.equal(database.query(`SELECT status FROM payment_notification_milestone WHERE payment_installment_id = ? AND milestone_type = 'later_reminder'`, [approvedTwoLater.id])[0].status, 'pending',
    "usable unallocated credit defers the affected cash reminder without recording delivery");
  assert.equal(count(database, "outbound_email", `id = '${approvedTwoLater.id}:later-reminder:email'`), 0,
    "a deferred credit-review demand creates no reminder Outbox row");
  await leaveChildCreditUnused(env(database), paymentStaff, {
    registrationDraftChildId: approvedTwoChild.id, paymentInstallmentId: approvedTwoLater.id, reason: "Асран хамгаалагч бэлнээр үргэлжлүүлнэ", operationId: randomUUID(),
  }, new Date('2026-12-01T10:01:00.000Z'));
  await processDuePaymentReminders(env(database, { RESEND_API_KEY: 'test-reminder-key', STAGING_EMAIL_OVERRIDE_TO: 'safe@example.test' }), new Date('2026-12-01T10:02:00.000Z'), reminderProvider);
  assert.equal(database.query(`SELECT status FROM payment_notification_milestone WHERE payment_installment_id = ? AND milestone_type = 'later_reminder'`, [approvedTwoLater.id])[0].status, 'sent',
    "after an explicit current-state decision, the ordinary reminder scheduler resumes exactly once");

  // A staff adjustment may settle an ordinary draft before it has any canonical
  // identity. Promotion must attach the same ledger rows rather than creating
  // cash payment or a second child credit balance.
  const creditOnlyInput = submission("class-priced", undefined, 1, "single");
  creditOnlyInput.children[0].givenName = "Кредитээр баталсан";
  const creditOnlyDraft = await createRegistrationDraft(env(database), creditOnlyInput, new Date(iso(-3)));
  const creditOnlyRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [creditOnlyDraft.draftId])[0];
  const creditOnlyChild = database.query(`SELECT id, canonical_student_id AS studentId FROM registration_draft_child WHERE registration_draft_id = ?`, [creditOnlyDraft.draftId])[0];
  assert.equal(creditOnlyChild.studentId, null, "an ordinary unpaid draft has no canonical student before credit is applied");
  const creditOnlyItem = (await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()))).items
    .find((item) => item.paymentRequestId === creditOnlyRequest.id);
  const creditOnlyOperation = randomUUID();
  const creditOnlyAdded = await addManualChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: creditOnlyChild.id, amountMnt: Number(creditOnlyItem.expectedAmountMnt),
    reason: "Нэг удаагийн төлбөрийг кредитээр тооцсон", operationId: creditOnlyOperation,
  }, new Date('2026-08-13T09:29:00.000Z'));
  assert.equal(creditOnlyAdded.canonicalStudentId, null, "the pre-confirmation ledger remains owned by the draft child");
  await applyChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: creditOnlyChild.id, paymentInstallmentId: creditOnlyItem.installmentId,
    amountMnt: Number(creditOnlyItem.expectedAmountMnt), reason: "Төлбөрт тооцсон", operationId: randomUUID(),
  }, new Date('2026-08-13T09:30:00.000Z'));
  assert.equal(count(database, "received_payment", `payment_request_id = '${creditOnlyRequest.id}'`), 0,
    "credit-only initial settlement never fabricates a received cash payment");
  await finalizeDuePaymentConfirmations(env(database), new Date('2026-08-13T09:36:00.000Z'));
  const promotedCreditOnly = database.query(`SELECT canonical_student_id AS studentId, canonical_enrollment_id AS enrollmentId
    FROM registration_draft_child WHERE id = ?`, [creditOnlyChild.id])[0];
  assert.ok(promotedCreditOnly.enrollmentId && promotedCreditOnly.studentId,
    "normal credit finalization promotes the ordinary registration after its grace period");
  assert.equal(count(database, "child_credit_entry", `registration_draft_child_id = '${creditOnlyChild.id}' AND canonical_student_id = '${promotedCreditOnly.studentId}'`), 2,
    "promotion attaches the original credit root and application to the canonical child without duplicating them");
  assert.equal(count(database, "child_credit_operation", `source_registration_draft_child_id = '${creditOnlyChild.id}' AND source_student_id = '${promotedCreditOnly.studentId}'`), 2,
    "the durable operation identities gain their canonical owner during promotion");
  const laterCredit = await addManualChildCredit(env(database), paymentStaff, {
    registrationDraftChildId: creditOnlyChild.id, amountMnt: 20000, reason: "Дараагийн төлбөрийн кредит", operationId: randomUUID(),
  }, new Date('2026-08-13T09:37:00.000Z'));
  assert.equal(laterCredit.availableAmountMnt, 20000,
    "a later visible 20,000 MNT balance is scoped to unused credit, not the earlier credit-only settlement");
  assert.equal(Number(database.query(`SELECT SUM(-amount_mnt) AS applied FROM child_credit_entry
    WHERE registration_draft_child_id = ? AND entry_kind = 'credit_application'`, [creditOnlyChild.id])[0].applied), Number(creditOnlyItem.expectedAmountMnt),
  "the ledger retains the full cumulative credit settlement after promotion");

  const autoSingleInput = submission("class-priced");
  autoSingleInput.children[0].givenName = "Нэг удаагийн авто";
  const autoSingleDraft = await createRegistrationDraft(env(database), autoSingleInput, new Date(iso(-3)));
  const autoSingleRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [autoSingleDraft.draftId])[0];
  const autoSingleQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()));
  const autoSingleItem = autoSingleQueue.items.find((item) => item.paymentRequestId === autoSingleRequest.id);
  const autoSinglePayment = await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: autoSingleRequest.id,
    allocations: [{ installmentId: autoSingleItem.installmentId, amountMnt: Number(autoSingleItem.expectedAmountMnt) }],
    source: 'staff_manual_bank', idempotencyKey: 'single-auto-seat-confirmation',
  }, new Date('2026-08-13T09:15:00.000Z'));
  assert.equal(database.query(`SELECT seat_confirmation_approved AS approved FROM payment_confirmation WHERE received_payment_id = ?`, [autoSinglePayment.id])[0].approved, 1,
    "a full one-time effective obligation automatically persists seat approval");
  await finalizeDuePaymentConfirmations(env(database), new Date('2026-08-13T09:21:00.000Z'));
  const autoSingleChild = database.query(`SELECT id, canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [autoSingleDraft.draftId])[0];
  assert.ok(autoSingleChild.enrollmentId, "a finalized full one-time payment creates the canonical enrollment without a seat checkbox");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${autoSingleChild.id}' AND status = 'active'`), 0,
    "one-time automatic promotion transfers the original seat reservation exactly once");

  const onePaymentPreview = await getAdditionalClassPreview(env(database), registrationStaff, {
    registrationDraftChildId: autoSingleChild.id, targetClassSessionId: "class-second-offering", paymentPlanCode: "single", proposeBaseDiscount: true,
  }, new Date(iso()));
  assert.deepEqual(onePaymentPreview.targets.find((target) => target.id === "class-second-offering")?.paymentOptions.map((plan) => plan.code), ["single"],
    "the staff preview exposes a target's authoritative one-payment agreement");
  assert.deepEqual(onePaymentPreview.proposal, {
    paymentPlanCode: "single", originalTotalMnt: 700000, baseDiscountMnt: 70000,
    totalAfterDiscountMnt: 630000, firstInstallmentMnt: 630000, secondInstallmentMnt: null,
    secondInstallmentDueOn: null, unresolved: [],
  }, "the target's configured 10% award reduces its one-payment initial obligation without borrowing the source price");
  assert.deepEqual(onePaymentPreview.creditProposal, {
    eligibleNow: true, targetInstallmentNumber: 1, availableChildCreditMnt: 0,
    useExistingCredit: true, useSourceAwardCredit: true, proposedExistingCreditMnt: 0,
    proposedSourceAwardCreditMnt: 95000, cashRequiredMnt: 535000, remainingChildCreditMnt: 0,
    note: null,
  }, "a fully paid source proposes only its contingent award credit against an eligible one-payment target");
  const onePaymentAdmission = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: autoSingleChild.id, targetClassSessionId: "class-second-offering", paymentPlanCode: "single",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-single-target-0001",
    useExistingCredit: true, useSourceAwardCredit: true,
    proposedExistingCreditMnt: 0, proposedSourceAwardCreditMnt: 95000,
  }, new Date("2026-08-13T09:22:30.000Z"));
  const onePaymentTargetId = onePaymentAdmission.registrationDraftChildId;
  assert.equal(database.query(`SELECT amount_mnt AS amountMnt FROM payment_installment WHERE registration_draft_child_id = ?`, [onePaymentTargetId])[0].amountMnt, 700000,
    "the target retains its immutable gross selected-plan snapshot before confirmation");
  const onePaymentTargetQueue = (await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso())))
    .items.find((item) => item.registrationDraftChildId === onePaymentTargetId);
  assert.equal(onePaymentTargetQueue.expectedAmountMnt, 630000,
    "the pending one-payment promise projects its discounted initial confirmation threshold before award activation");
  assert.equal(onePaymentTargetQueue.reservedCreditMnt, 95000,
    "the payment queue identifies the frozen contingent credit separately from an applied payment");
  assert.equal(onePaymentTargetQueue.cashRequiredMnt, 535000,
    "the payment queue asks only for the authoritative cash remainder while the reservation remains valid");
  const onePaymentTargetRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [onePaymentAdmission.draftId])[0];
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: onePaymentTargetRequest.id,
    allocations: [{ installmentId: onePaymentTargetQueue.installmentId, amountMnt: 535000 }],
    source: "staff_manual_bank", idempotencyKey: "additional-admission-single-target-payment-0001",
  }, new Date("2026-08-13T09:23:00.000Z"));
  assert.equal(count(database, "enrollment", `id = '${onePaymentTargetId}:enrollment'`), 0,
    "recording the reduced cash receipt alone never creates a target enrollment");
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE registration_draft_child_id = ? AND installment_kind = 'initial'`, [onePaymentTargetId])[0].status, "pending",
    "a reservation is not treated as an independently settled installment before protected finalization");
  assert.equal(count(database, "child_credit_entry", `registration_draft_child_id = '${onePaymentTargetId}' AND entry_kind = 'credit_application'`), 0,
    "the contingent source award is not written as spendable or applied credit before the fenced finalizer");
  assert.equal(count(database, "additional_class_credit_reservation", `admission_id = '${onePaymentAdmission.admissionId}' AND status = 'pending'`), 1,
    "the exact proposed credit stays reserved through the cash-only recording step");
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:29:00.000Z"));
  assert.equal(count(database, "enrollment", `id = '${onePaymentTargetId}:enrollment' AND status = 'confirmed'`), 1,
    "cash plus the fenced contingent award credit completes the one-payment target confirmation path");
  assert.equal(count(database, "child_credit_entry", `source_discount_award_id = (SELECT id FROM discount_award
    WHERE registration_draft_child_id = '${autoSingleChild.id}' AND reason = 'additional_class_canonical_confirmation')`), 1,
  "a fully paid source receives one durable child-credit root linked to its newly earned award");
  const fullyPaidSourceAward = database.query(`SELECT award_amount_mnt AS awardAmountMnt FROM discount_award
    WHERE registration_draft_child_id = ? AND reason = 'additional_class_canonical_confirmation'`, [autoSingleChild.id])[0];
  assert.equal(Number(database.query(`SELECT amount_mnt AS amountMnt FROM child_credit_entry WHERE source_discount_award_id = (
    SELECT id FROM discount_award WHERE registration_draft_child_id = ? AND reason = 'additional_class_canonical_confirmation')`, [autoSingleChild.id])[0].amountMnt), Number(fullyPaidSourceAward.awardAmountMnt),
  "the fully paid source's entire configured award becomes available credit without changing received cash history");
  assert.equal(Number(database.query(`SELECT COALESCE(SUM(-amount_mnt), 0) AS appliedMnt FROM child_credit_entry
    WHERE registration_draft_child_id = ? AND entry_kind = 'credit_application'`, [onePaymentTargetId])[0].appliedMnt), 95000,
  "the fenced completion applies exactly the reservation to the target installment");
  assert.equal(count(database, "additional_class_credit_reservation", `admission_id = '${onePaymentAdmission.admissionId}' AND status = 'pending'`), 0,
    "completed settlement consumes the reservation and leaves no independently spendable duplicate");

  const partialAdditionalInput = submission("class-award-source");
  partialAdditionalInput.guardian.primaryPhone = "98123456";
  partialAdditionalInput.children[0].givenName = "Хэсэгчилсэн эх";
  const partialAdditionalDraft = await createRegistrationDraft(env(database), partialAdditionalInput, new Date("2026-08-13T09:30:00.000Z"));
  const partialAdditionalRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [partialAdditionalDraft.draftId])[0];
  const partialAdditionalQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date("2026-08-13T09:30:00.000Z"));
  const partialAdditionalItem = partialAdditionalQueue.items.find((item) => item.paymentRequestId === partialAdditionalRequest.id);
  const partialSourceGrossMnt = Number(partialAdditionalItem.expectedAmountMnt);
  const partialSourcePaidMnt = partialSourceGrossMnt - 25000;
  const partialSourceAwardMnt = Math.floor(partialSourceGrossMnt * 1000 / 10000);
  assert.ok(partialSourceGrossMnt > partialSourcePaidMnt, "the independent source starts with an authoritative one-payment agreement");
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: partialAdditionalRequest.id, allocations: [{ installmentId: partialAdditionalItem.installmentId, amountMnt: partialSourcePaidMnt }],
    source: "staff_manual_bank", approveSeatConfirmation: true, remainingPaymentDueAt: "2026-09-30T09:30:00.000Z",
    idempotencyKey: "additional-admission-partial-source-payment-0001",
  }, new Date("2026-08-13T09:31:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:37:00.000Z"));
  const partialAdditionalSource = database.query(`SELECT id, canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [partialAdditionalDraft.draftId])[0];
  assert.ok(partialAdditionalSource.enrollmentId, "an explicitly approved partial source is a normal confirmed enrollment before adding another class");
  const partialSourcePreview = await getAdditionalClassPreview(env(database), registrationStaff, {
    registrationDraftChildId: partialAdditionalSource.id, targetClassSessionId: "class-award-target", paymentPlanCode: "two_installment",
  }, new Date("2026-08-13T09:38:00.000Z"));
  assert.deepEqual(partialSourcePreview.sourceEffect, { awardMnt: partialSourceAwardMnt, reducesUnpaidMnt: 25000, createsCreditMnt: partialSourceAwardMnt - 25000 },
    "the preview distinguishes the unpaid source reduction from its residual child credit");
  const partialSourceAdmission = await createAdditionalClassAdmission(env(database), registrationStaff, {
    registrationDraftChildId: partialAdditionalSource.id, targetClassSessionId: "class-award-target", paymentPlanCode: "two_installment",
    parentAcknowledged: true, childAcknowledged: true, idempotencyKey: "additional-admission-partial-source-0001",
  }, new Date("2026-08-13T09:39:00.000Z"));
  assert.equal(count(database, "child_credit_entry", `registration_draft_child_id = '${partialAdditionalSource.id}'`), 0,
    "creating an additional admission freezes the promise without changing the partially paid source ledger");
  const partialTargetQueue = (await getInitialPaymentQueue(env(database), paymentStaff, new Date("2026-08-13T09:39:00.000Z")))
    .items.find((item) => item.registrationDraftChildId === partialSourceAdmission.registrationDraftChildId);
  const partialTargetRawFirstMnt = Number(database.query(`SELECT amount_mnt AS amountMnt FROM payment_installment
    WHERE registration_draft_child_id = ? AND installment_kind = 'initial'`, [partialSourceAdmission.registrationDraftChildId])[0].amountMnt);
  assert.equal(partialTargetQueue.expectedAmountMnt, partialTargetRawFirstMnt, "the target's own first installment remains the net confirmation threshold");
  const partialTargetRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [partialSourceAdmission.draftId])[0];
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: partialTargetRequest.id, allocations: [{ installmentId: partialTargetQueue.installmentId, amountMnt: partialTargetRawFirstMnt }],
    source: "staff_manual_bank", idempotencyKey: "additional-admission-partial-source-target-payment-0001",
  }, new Date("2026-08-13T09:40:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:46:00.000Z"));
  const partialSourceAward = database.query(`SELECT id, applied_amount_mnt AS appliedMnt, credit_amount_mnt AS creditMnt
    FROM discount_award WHERE registration_draft_child_id = ? AND reason = 'additional_class_canonical_confirmation'`, [partialAdditionalSource.id])[0];
  assert.deepEqual({ appliedMnt: Number(partialSourceAward.appliedMnt), creditMnt: Number(partialSourceAward.creditMnt) }, { appliedMnt: 25000, creditMnt: partialSourceAwardMnt - 25000 },
    "a partially paid source reduces only its unpaid obligation and leaves the residual award as credit");
  assert.equal(Number(database.query(`SELECT amount_mnt AS amountMnt FROM child_credit_entry WHERE source_discount_award_id = ?`, [partialSourceAward.id])[0].amountMnt), partialSourceAwardMnt - 25000,
    "the residual source award is linked to exactly one available child-credit root");
  assert.equal(count(database, "received_payment", `payment_request_id = '${partialAdditionalRequest.id}'`), 1,
    "the award-credit split preserves the source's immutable cash-payment history");

  const legacyCorrectionInput = submission("class-priced", undefined, 1, "two_installment");
  legacyCorrectionInput.children[0].givenName = "Засвар баталгаа";
  const legacyCorrectionDraft = await createRegistrationDraft(env(database), legacyCorrectionInput, new Date(iso(-3)));
  const correctionRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [legacyCorrectionDraft.draftId])[0];
  const correctionQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date(iso()));
  const correctionItem = correctionQueue.items.find((item) => item.paymentRequestId === correctionRequest.id);
  const correctionPayment = await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: correctionRequest.id,
    allocations: [{ installmentId: correctionItem.installmentId, amountMnt: Number(correctionItem.expectedAmountMnt) }],
    source: 'staff_manual_bank', idempotencyKey: 'legacy-seat-correction-payment',
  }, new Date('2026-08-13T09:15:00.000Z'));
  database.query(`UPDATE payment_confirmation SET seat_confirmation_approved = 0 WHERE received_payment_id = ?`, [correctionPayment.id]);
  await finalizeDuePaymentConfirmations(env(database), new Date('2026-08-13T09:21:00.000Z'));
  assert.equal(database.query(`SELECT canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [legacyCorrectionDraft.draftId])[0].enrollmentId, null,
    "a legacy sufficient payment without approval remains correctable without recording another payment");
  const paymentsBeforeCorrection = count(database, "received_payment", `payment_request_id = '${correctionRequest.id}'`);
  await confirmSeatForSufficientPayment(env(database), paymentStaff, correctionRequest.id, new Date('2026-08-13T09:22:00.000Z'));
  assert.equal(count(database, "received_payment", `payment_request_id = '${correctionRequest.id}'`), paymentsBeforeCorrection,
    "correction-only seat confirmation creates no received payment");
  assert.ok(database.query(`SELECT canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [legacyCorrectionDraft.draftId])[0].enrollmentId,
    "correction-only seat confirmation safely promotes the existing sufficient payment");
  assert.equal(database.query(`SELECT effective_due_at AS dueAt, status FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'later'`, [correctionRequest.id])[0].status, 'pending',
    "correction-only confirmation leaves the scheduled second installment intact");
  assert.equal((await confirmSeatForSufficientPayment(env(database), paymentStaff, correctionRequest.id)).idempotent, true,
    "replaying correction-only confirmation does not duplicate payment or enrollment");
  const multiChild = submission("class-priced", undefined, 1, "two_installment");
  multiChild.children.push({ ...multiChild.children[0], givenName: "Хүүхэд 2", selectedClassSessionId: "class-second-offering", paymentPlanCode: "single" });
  const multiChildDraft = await createRegistrationDraft(env(database), multiChild, new Date(iso(-4)));
  assert.deepEqual(database.query(`SELECT position, payment_plan_code AS paymentPlanCode, initial_payment_amount_mnt AS initialAmount
    FROM registration_draft_child WHERE registration_draft_id = ? ORDER BY position`, [multiChildDraft.draftId]),
  [{ position: 0, paymentPlanCode: "two_installment", initialAmount: 500000 }, { position: 1, paymentPlanCode: "single", initialAmount: 700000 }],
  "siblings may retain independent Offering prices and payment plans");
  assert.equal(count(database, "discount_award", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${multiChildDraft.draftId}') AND award_type = 'family_multi_child' AND status = 'active'`), 2,
    "two children accepted together each receive one family award before payment");
  assert.deepEqual(database.query(`SELECT award_amount_mnt AS amountMnt FROM discount_award WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?) ORDER BY registration_draft_child_id`, [multiChildDraft.draftId]).map((row) => row.amountMnt).sort((a, b) => a - b), [70000, 100000],
    "family awards snapshot ten percent of each selected plan, including independent installment plans");
  const multiChallenge = addChallenge(database, multiChildDraft.draftId, multiChildDraft.normalizedEmail, iso(-4), iso(56));
  const multiSession = session(iso(-3), iso(57));
  await confirmRegistrationChallenge(env(database), multiChallenge, multiSession, new Date(iso(-3)));
  const multiRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [multiChildDraft.draftId])[0];
  const multiInstallments = database.query(`SELECT id, amount_mnt AS amountMnt FROM payment_installment
    WHERE payment_request_id = ? AND installment_kind = 'initial' ORDER BY id`, [multiRequest.id]);
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: multiRequest.id,
    allocations: multiInstallments.map((item) => ({ installmentId: item.id, amountMnt: Number(item.amountMnt) === 500000 ? 400000 : 630000 })),
    receivedAmountMnt: 1201000, source: 'staff_manual_bank', idempotencyKey: 'multi-child-transfer',
  }, new Date(iso(-2)));
  assert.equal(count(database, "payment_allocation", `received_payment_id = (SELECT id FROM received_payment WHERE idempotency_key = 'multi-child-transfer')`), 2, "one received payment can allocate across two children's initial obligations");
  assert.equal(database.query(`SELECT received_amount_mnt AS amountMnt FROM received_payment WHERE idempotency_key = 'multi-child-transfer'`)[0].amountMnt, 1201000, "unallocated overpayment remains representable without inventing a credit");
  const manipulated = submission("class-priced");
  manipulated.children[0].initialPaymentAmountMnt = 1;
  const manipulatedDraft = await createRegistrationDraft(env(database), manipulated, new Date(iso(-1)));
  assert.equal(database.query(`SELECT initial_payment_amount_mnt AS initialAmount FROM registration_draft_child WHERE registration_draft_id = ?`, [manipulatedDraft.draftId])[0].initialAmount, 950000, "browser-provided amounts are ignored in favor of the server pricing plan");
  database.query("UPDATE payment_collection_settings SET account_number = NULL, iban = NULL");
  await assert.rejects(createRegistrationDraft(env(database), submission("class-priced"), new Date(iso(-1))),
    (error) => error instanceof RegistrationSubmissionError && error.code === "pricing_unavailable", "incomplete transfer instructions prevent a new payment request");
  database.query("UPDATE payment_collection_settings SET account_number = '0000000000', iban = 'MN00TEST0000000000'");

  const competing = await Promise.allSettled([
    createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(1))),
    createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(1))),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 0, "an existing hold protects the last seat");
  assert.equal(count(database, "registration_capacity_hold", "class_session_id = 'class-last-seat' AND deadline_at > '2026-08-11T08:01:00.000Z'"), 1);

  database.query("UPDATE registration_capacity_hold SET status = 'released', released_at = ?, release_reason = 'test_staff_release' WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)", [iso(1), one.draftId]);
  const replacement = await createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(2)));
  assert.equal(replacement.hasPaymentHold, true, "an immediate payment reservation restores capacity without cleanup");

  await assert.rejects(
    createRegistrationDraft(env(database), submission("class-roomy", undefined, 4), new Date(iso(3))),
    (error) => error instanceof RegistrationSubmissionError && error.code === "capacity_changed",
  );
  const partialDraft = database.query("SELECT id FROM registration_draft WHERE status = 'seat_unavailable' ORDER BY created_at DESC LIMIT 1")[0];
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${partialDraft.id}')`), 0, "multi-child failure creates no partial hold");

  const waitlistOnly = await createRegistrationDraft(env(database), submission(undefined, "class-full-preferred"), new Date(iso(4)));
  assert.equal(waitlistOnly.hasPaymentHold, false);
  assert.equal(count(database, "registration_draft_waitlist_entry", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${waitlistOnly.draftId}')`), 1, "accepted waitlist-only draft enters its FIFO queue without email verification");
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
  assert.equal(fallbackConfirmed.paymentDeadlineAt, iso(12), "existing accepted payment hold retains its snapshotted deadline through email confirmation");
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
  assert.equal(reacquired.lateReacquired, false, "email verification does not renew an existing initial-payment reservation");
  assert.equal(reacquired.hasPaymentHold, true);

  database.query("UPDATE registration_capacity_hold SET status = 'released', released_at = ?, release_reason = 'test_staff_release' WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)", [iso(9), replacement.draftId]);
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
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:16:00.000Z"));
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE id = ?`, [cashInstallment.id])[0].status, 'partially_paid', "partial first payment does not confirm the obligation");
  await assert.rejects(recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: cashRequest.id, allocations: [{ installmentId: cashInstallment.id, amountMnt: Number(cashInstallment.amountMnt) }],
    source: 'staff_manual_cash', idempotencyKey: 'cash-overpayment',
  }), "allocation cannot exceed the remaining obligation");

  const approvedPartialInput = submission("class-second-offering");
  approvedPartialInput.children[0].givenName = "Тусгай зөвшөөрөл";
  const approvedPartialDraft = await createRegistrationDraft(env(database), approvedPartialInput, new Date("2026-08-13T09:12:00.000Z"));
  const approvedPartialChallenge = addChallenge(database, approvedPartialDraft.draftId, approvedPartialDraft.normalizedEmail, "2026-08-13T09:12:00.000Z", "2026-08-14T09:12:00.000Z");
  const approvedPartialSession = session("2026-08-13T09:13:00.000Z", "2026-08-16T10:13:00.000Z");
  await confirmRegistrationChallenge(env(database), approvedPartialChallenge, approvedPartialSession, new Date("2026-08-13T09:13:00.000Z"));
  const approvedPartialRequest = database.query(`SELECT id FROM payment_request WHERE registration_draft_id = ?`, [approvedPartialDraft.draftId])[0];
  const approvedPartialQueue = await getInitialPaymentQueue(env(database), paymentStaff, new Date("2026-08-13T09:14:00.000Z"));
  const approvedPartialItem = approvedPartialQueue.items.find((item) => item.paymentRequestId === approvedPartialRequest.id);
  const approvedPartialAmount = Math.floor(Number(approvedPartialItem.expectedAmountMnt) / 2);
  await assert.rejects(recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: approvedPartialRequest.id, allocations: [{ installmentId: approvedPartialItem.installmentId, amountMnt: approvedPartialAmount }],
    source: 'staff_manual_bank', approveSeatConfirmation: true, idempotencyKey: 'approved-partial-needs-deadline',
  }, new Date("2026-08-13T09:14:00.000Z")), "a newly approved partial seat requires its first remaining-payment deadline");
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: approvedPartialRequest.id,
    allocations: [{ installmentId: approvedPartialItem.installmentId, amountMnt: approvedPartialAmount }],
    source: 'staff_manual_bank', approveSeatConfirmation: true,
    remainingPaymentDueAt: "2026-09-30T09:14:00.000Z", idempotencyKey: 'approved-partial-promotion',
  }, new Date("2026-08-13T09:14:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:20:00.000Z"));
  const approvedPartialChild = database.query(`SELECT id, canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE registration_draft_id = ?`, [approvedPartialDraft.draftId])[0];
  assert.ok(approvedPartialChild.enrollmentId, "a finalized teacher-approved partial payment creates the canonical enrollment");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${approvedPartialChild.id}' AND status = 'active'`), 0, "partial promotion releases its former hold only after canonical enrollment exists");
  assert.equal(count(database, "enrollment", `id = '${approvedPartialChild.enrollmentId}' AND status = 'confirmed'`), 1, "partial promotion creates exactly one confirmed enrollment");
  const referralQueue = await getInitialPaymentQueue(env(database), { ...paymentStaff, capabilities: ['payment.view', 'payment.manage', 'registration.manage'] }, new Date("2026-08-13T09:25:00.000Z"));
  const referralItem = referralQueue.items.find((item) => item.paymentRequestId === approvedPartialRequest.id);
  assert.match(referralItem.ownReferralCode, /^NE-[A-Z2-9]{7}$/, "teacher/admin queue projection exposes the confirmed child's own active referral code");
  assert.equal(referralItem.usedReferralCode ?? null, null, "a registration without a captured referral never fabricates a used code");
  assert.equal((await getInitialPaymentQueue(env(database), paymentStaff, new Date("2026-08-13T09:25:00.000Z"))).canManageReferrals, false,
    "accountant-style payment access does not receive the staff referral surface");
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'initial'`, [approvedPartialRequest.id])[0].status, 'partially_paid', "remaining tuition remains an independent financial obligation after enrollment promotion");
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-13T09:25:00.000Z"));
  assert.equal(count(database, "enrollment", `id = '${approvedPartialChild.enrollmentId}'`), 1, "finalizer replay does not duplicate the approved-partial enrollment");
  const approvedPartialRemaining = Number(approvedPartialItem.expectedAmountMnt) - approvedPartialAmount;
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: approvedPartialRequest.id, allocations: [{ installmentId: approvedPartialItem.installmentId, amountMnt: 10000 }],
    source: 'staff_manual_bank', idempotencyKey: 'approved-partial-follow-up-preserves-deadline',
  }, new Date("2026-08-14T08:00:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-14T08:06:00.000Z"));
  assert.equal(database.query(`SELECT remaining_payment_due_at AS dueAt FROM payment_confirmation WHERE payment_request_id = ? AND status = 'finalized' ORDER BY created_at DESC, id DESC LIMIT 1`, [approvedPartialRequest.id])[0].dueAt,
    "2026-09-30T09:14:00.000Z", "a later partial payment preserves the existing approved-seat deadline without requiring it again");
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: approvedPartialRequest.id, allocations: [{ installmentId: approvedPartialItem.installmentId, amountMnt: 10000 }],
    source: 'staff_manual_bank', remainingPaymentDueAt: "2026-10-01T09:14:00.000Z", idempotencyKey: 'approved-partial-follow-up-changes-deadline',
  }, new Date("2026-08-14T08:10:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-14T08:16:00.000Z"));
  assert.equal(database.query(`SELECT remaining_payment_due_at AS dueAt FROM payment_confirmation WHERE payment_request_id = ? AND status = 'finalized' ORDER BY created_at DESC, id DESC LIMIT 1`, [approvedPartialRequest.id])[0].dueAt,
    "2026-10-01T09:14:00.000Z", "an explicit later-payment deadline change persists authoritatively");
  await recordManualPayment(env(database), paymentStaff, {
    paymentRequestId: approvedPartialRequest.id,
    allocations: [{ installmentId: approvedPartialItem.installmentId, amountMnt: approvedPartialRemaining - 20000 }],
    source: 'staff_manual_bank', idempotencyKey: 'approved-partial-settlement',
  }, new Date("2026-08-14T09:14:00.000Z"));
  await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-14T09:20:00.000Z"));
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'initial'`, [approvedPartialRequest.id])[0].status, 'paid', "a later full settlement resolves the remaining initial balance");
  assert.equal(database.query(`SELECT remaining_payment_due_at AS dueAt FROM payment_confirmation WHERE payment_request_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [approvedPartialRequest.id])[0].dueAt, null,
    "a full remaining-balance settlement creates no artificial future deadline");
  assert.ok(count(database, "payment_confirmation", `payment_request_id = '${approvedPartialRequest.id}' AND seat_confirmation_approved = 1 AND status = 'finalized'`) >= 1,
    "later settlement never removes the earlier durable seat approval");
  assert.equal(count(database, "enrollment", `id = '${approvedPartialChild.enrollmentId}' AND status = 'confirmed'`), 1, "later settlement preserves the existing canonical enrollment");
  await claimParentPayment(database, cashRequest.id, cashDraft.draftId, cashSession.rawToken, new Date("2026-08-15T10:00:00.000Z"));
  await assert.rejects(claimParentPayment(database, cashRequest.id, cashDraft.draftId, "not-this-family", new Date("2026-08-15T10:00:00.000Z")), "another session cannot claim a family's payment");
  const released = await releaseUnpaidSeat(env(database), paymentStaff, cashRequest.id, new Date("2026-08-15T10:00:00.000Z"));
  assert.equal(released.released, true, "staff can explicitly release a genuinely unpaid overdue seat");
  assert.equal(released.parentClaimed, true, "release surfaces the parent's non-authoritative payment claim");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${cashDraft.draftId}') AND status = 'active'`), 0, "explicit release, not elapsed time, frees the seat");
  assert.ok(count(database, "guardian_account") >= 3, "routine sufficient payments and teacher-approved partials become canonical guardians only after finalization");
  assert.ok(count(database, "student") >= 3, "routine sufficient payments and teacher-approved partials create canonical students while ordinary partial or released payments do not");

  const closureDraft = await createRegistrationDraft(env(database), submission("class-second-offering"), new Date("2026-08-13T09:50:00.000Z"));
  const closureChallenge = addChallenge(
    database,
    closureDraft.draftId,
    closureDraft.normalizedEmail,
    "2026-08-13T09:50:00.000Z",
    "2026-08-14T09:50:00.000Z",
  );
  const replayDraft = await createRegistrationDraft(env(database), submission(undefined, "class-full-preferred"), new Date("2026-08-13T10:00:00.000Z"));
  const replayChallenge = addChallenge(
    database,
    replayDraft.draftId,
    replayDraft.normalizedEmail,
    "2026-08-13T10:00:00.000Z",
    "2026-08-14T10:00:00.000Z",
  );
  database.query(`UPDATE registration_window SET ends_on = '2026-08-12', updated_at = ?
    WHERE id = 'window-active-test'`, [iso(120)]);
  await assert.rejects(
    createRegistrationDraft(env(database), submission("class-priced"), new Date("2026-08-13T10:00:30.000Z")),
    (error) => error instanceof RegistrationSubmissionError && error.code === "registration_closed",
    "a stale browser cannot create a new draft after its Offering window closes",
  );
  await verifyEmailToken(env(database), closureChallenge.rawToken, "", new Date("2026-08-13T10:00:30.000Z"));
  assert.equal(database.query(`SELECT status FROM registration_draft WHERE id = ?`, [closureDraft.draftId])[0].status, "awaiting_initial_payment", "an accepted held draft continues through email confirmation after its window closes");
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
  const twoLaterInstallment = database.query(`SELECT payment_installment.id,
    payment_installment.amount_mnt - COALESCE(SUM(payment_allocation.allocated_amount_mnt), 0) AS remainingMnt
    FROM payment_installment LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    WHERE payment_installment.payment_request_id = ? AND payment_installment.installment_kind = 'later'
    GROUP BY payment_installment.id`, [twoRequest.id])[0];
  // This fixture only establishes a fully paid historical agreement for the
  // export projection. Payment workflow behavior is exercised above.
  database.query(`INSERT INTO received_payment (
    id, payment_request_id, received_amount_mnt, received_at, payment_source,
    reconciliation_status, confirmed_at, confirmed_by_staff_account_id,
    idempotency_key, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, 'staff_manual_bank', 'confirmed', ?, ?, ?, ?, ?, 1, ?)`, [
    'two-later-export-payment', twoRequest.id, Number(twoLaterInstallment.remainingMnt),
    '2026-08-13T09:30:00.000Z', '2026-08-13T09:31:00.000Z', paymentStaff.staffAccountId,
    'two-later-export-plan-test', '2026-08-13T09:31:00.000Z', '2026-08-13T09:31:00.000Z', `test:${twoInstallment.draftId}`,
  ]);
  database.query(`INSERT INTO payment_allocation (
    id, received_payment_id, payment_installment_id, allocated_amount_mnt,
    allocated_at, allocated_by_staff_account_id, created_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, [
    'two-later-export-allocation', 'two-later-export-payment', twoLaterInstallment.id,
    Number(twoLaterInstallment.remainingMnt), '2026-08-13T09:31:00.000Z', paymentStaff.staffAccountId,
    '2026-08-13T09:31:00.000Z', `test:${twoInstallment.draftId}`,
  ]);
  const exportRows = await getRegistrationExportRows(env(database), exportStaff);
  assert.ok(exportRows.rows.some((row) => row.paymentPlan === 'Нэг удаа'), "the generated export retains one-time agreement snapshots");
  assert.ok(exportRows.rows.some((row) => row.paymentPlan === '2 хувааж' && Number(row.paid) > 0 && Number(row.remaining) === 0),
    "the generated export retains a fully paid two-installment agreement instead of inferring one-time payment");
  assert.equal(exportRows.rows.at(-1)?.status, 'Цуцлагдсан', "the generated export places terminal cancellations after active operational rows");
  const crossBrowserChallenge = addChallenge(database, twoInstallment.draftId, twoInstallment.normalizedEmail, "2026-08-13T10:01:00.000Z", "2026-08-14T10:01:00.000Z");
  const crossBrowserVerification = await verifyEmailToken(env(database), crossBrowserChallenge.rawToken, sessionToken, verificationTime);
  assert.match(crossBrowserVerification.redirectUrl, /status=confirmed/, "an unrelated browser session never changes which registration an email challenge verifies");
  assert.notEqual(crossBrowserVerification.cookie, firstVerification.cookie, "email verification creates a new session for the challenged registration rather than reusing an unrelated one");

  const production = env(database, {
    APP_ENV: "production",
    REGISTRATION_WRITE_ENABLED: "false",
    EMAIL_ENABLED: "false",
    AUTH_EMAIL_ENABLED: "false",
  });
  await assert.rejects(createRegistrationDraft(production, submission("class-roomy")), (error) => error.code === "disabled");
  assert.equal(registrationWriteEnabled(env(database, { APP_ENV: "unknown" })), false, "unknown environment fails closed");
  assert.equal(registrationWriteEnabled(env(database, {
    APP_ENV: "production",
    REGISTRATION_WRITE_ENABLED: "true",
    TURNSTILE_SITE_KEY: "production-site-key",
    TURNSTILE_SECRET_KEY: undefined,
  })), false, "production requires a Turnstile secret");
  assert.equal(registrationWriteEnabled(env(database, {
    APP_ENV: "production",
    REGISTRATION_WRITE_ENABLED: "true",
    TURNSTILE_SITE_KEY: "production-site-key",
    TURNSTILE_SECRET_KEY: "production-secret",
  })), true, "production reaches the normal registration path only with its reviewed gate and real Turnstile configuration");

  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, created_at, updated_at)
    VALUES ('year-production', 'Бодит жил', 'closed', 1, 0, ?, ?),
      ('year-production-outside', 'Өөр бодит жил', 'closed', 0, 0, ?, ?);
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, created_at, updated_at)
    VALUES ('offering-production', 'annual_course', 'Бодит сургалт', 'year-production', 'stage_1', 1, 'paid', 'active', 0, ?, ?),
      ('offering-production-outside', 'annual_course', 'Хаалттай цонхтой', 'year-production-outside', 'stage_1', 1, 'paid', 'active', 0, ?, ?);
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, created_at, updated_at)
    VALUES ('class-production', 'offering-production', 'year-production', 'stage_1', 'Бодит анги', 'Бямба', '09:00', '10:20', 2, 'available', 0, 0, ?, ?),
      ('class-production-closed', 'offering-production', 'year-production', 'stage_1', 'Бодит хаалттай анги', 'Бямба', '11:00', '12:20', 2, 'closed', 0, 0, ?, ?),
      ('class-production-outside', 'offering-production-outside', 'year-production-outside', 'stage_1', 'Цонхны гаднах анги', 'Бямба', '13:00', '14:20', 2, 'available', 0, 0, ?, ?);
    INSERT INTO offering_course_pricing (activity_offering_id, one_time_amount_mnt, two_installment_enabled, created_at, updated_at)
    VALUES ('offering-production', 800000, 0, ?, ?), ('offering-production-outside', 800000, 0, ?, ?);
    INSERT INTO registration_window (id, name, starts_on, ends_on, is_test, created_at, updated_at)
    VALUES ('window-production', 'Бодит бүртгэл', '2026-08-01', '2026-08-31', 0, ?, ?);
    INSERT INTO registration_window_offering (registration_window_id, activity_offering_id, created_at)
    VALUES ('window-production', 'offering-production', ?);
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, created_at, updated_at)
    VALUES ('referrer-guardian', 'Уригч асран', '99110000', '99110000', 'referrer@example.test', 'referrer@example.test', 'Тест хаяг', 'active', 0, ?, ?);
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, created_at, updated_at)
    VALUES ('referrer-student', 'Уригч', 'Хүүхэд', 'female', '2014-01-01', 'active', 0, ?, ?);
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, created_at, updated_at)
    VALUES ('referrer-pre-registration', 'referrer-guardian', 'year-production', 'completed', 0, ?, ?);
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, selected_class_session_id, status, is_test, created_at, updated_at)
    VALUES ('referrer-application', 'referrer-pre-registration', 'referrer-student', 5, 'new', 'class-production', 'enrolled', 0, ?, ?);
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, created_at, updated_at)
    VALUES ('referrer-enrollment', 'referrer-application', 'referrer-student', 'year-production', 'class-production', 'confirmed', ?, 0, ?, ?);
    INSERT INTO enrollment_referral_code (id, enrollment_id, student_id, code, status, activated_at, is_test, created_at, updated_at)
    VALUES ('referrer-code', 'referrer-enrollment', 'referrer-student', 'NE-REF2345', 'active', ?, 0, ?, ?);`,
  Array.from({ length: 35 }, () => iso()));
  const productionEnabled = env(database, {
    APP_ENV: "production", REGISTRATION_WRITE_ENABLED: "true", EMAIL_ENABLED: "false", AUTH_EMAIL_ENABLED: "false",
    TURNSTILE_SITE_KEY: "production-site-key", TURNSTILE_SECRET_KEY: "production-secret",
  });
  const productionSubmission = submission("class-production");
  productionSubmission.children[0].codeInput = "ne-ref2345";
  const productionIdempotencyKey = "registration-test-idempotency-key";
  const acceptedProductionDraft = await createRegistrationDraft(productionEnabled, productionSubmission, new Date(iso(-2)), {
    idempotencyKey: productionIdempotencyKey,
  });
  assert.equal(acceptedProductionDraft.hasPaymentHold, true, "a production-like non-test class accepts through the same guarded service");
  assert.equal(count(database, "registration_draft", `id = '${acceptedProductionDraft.draftId}' AND is_test = 0`), 1, "accepted production draft is not test provenance");
  assert.equal(count(database, "registration_draft_child", `registration_draft_id = '${acceptedProductionDraft.draftId}' AND is_test = 0`), 1);
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${acceptedProductionDraft.draftId}') AND is_test = 0 AND status = 'active'`), 1);
  assert.equal(count(database, "payment_request", `registration_draft_id = '${acceptedProductionDraft.draftId}' AND is_test = 0`), 1);
  assert.equal(count(database, "payment_installment", `payment_request_id = (SELECT id FROM payment_request WHERE registration_draft_id = '${acceptedProductionDraft.draftId}') AND is_test = 0`), 1);
  assert.equal(count(database, "registration_draft_referral", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${acceptedProductionDraft.draftId}')`), 1, "a valid active code is captured canonically at acceptance");
  assert.equal(count(database, "discount_award", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${acceptedProductionDraft.draftId}') AND award_type = 'referral_referred' AND status = 'active' AND is_test = 0`), 1,
    "a valid active referral immediately awards the referred child using the selected plan snapshot");
  assert.equal(database.query(`SELECT award_amount_mnt AS amountMnt FROM discount_award WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?) AND award_type = 'referral_referred'`, [acceptedProductionDraft.draftId])[0].amountMnt, 16000,
    "the referred-child award uses the default two percent of the one-time plan");
  const retriedProductionDraft = await createRegistrationDraft(productionEnabled, productionSubmission, new Date(iso(-2)), {
    idempotencyKey: productionIdempotencyKey,
  });
  assert.equal(retriedProductionDraft.created, false, "a repeated submission key returns the existing registration");
  assert.equal(retriedProductionDraft.draftId, acceptedProductionDraft.draftId);
  const replayedStatus = await registrationStatusForDraftId(database, retriedProductionDraft.draftId, new Date(iso(-2)));
  assert.equal(replayedStatus.children.length, 1, "an idempotent replay can reconstruct the original registration status without a browser access cookie");
  assert.equal(replayedStatus.children[0].holdType, "initial_payment", "the recovered status retains the committed payment hold");
  assert.equal(count(database, "registration_capacity_hold", "class_session_id = 'class-production' AND status = 'active'"), 1,
    "an idempotent retry does not reserve a second seat");
  assert.equal(count(database, "discount_award", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${acceptedProductionDraft.draftId}') AND award_type = 'referral_referred'`), 1,
    "idempotent registration retry does not duplicate a referral award");
  await assert.rejects(createRegistrationDraft(productionEnabled, submission("class-roomy"), new Date(iso(-2))),
    (error) => error.code === "invalid_class", "production rejects an attacker-supplied test fixture class");
  await assert.rejects(createRegistrationDraft(productionEnabled, submission("class-production-closed"), new Date(iso(-2))),
    (error) => error.code === "invalid_class", "production rejects a closed class server-side");
  await assert.rejects(createRegistrationDraft(productionEnabled, submission("class-production-outside"), new Date(iso(-2))),
    (error) => error.code === "registration_closed", "production rejects a class outside its active registration window");
  const invalidReferral = submission("class-production"); invalidReferral.children[0].codeInput = "NE-NOTFOUND";
  await assert.rejects(createRegistrationDraft(productionEnabled, invalidReferral, new Date(iso(-2))),
    (error) => error.code === "invalid_referral_code", "an invalid referral code is rejected for correction rather than stored as a relationship");
  database.query("UPDATE enrollment_referral_code SET status = 'inactive' WHERE id = 'referrer-code'");
  const inactiveReferral = submission("class-production"); inactiveReferral.children[0].codeInput = "NE-REF2345";
  await assert.rejects(createRegistrationDraft(productionEnabled, inactiveReferral, new Date(iso(-2))),
    (error) => error.code === "invalid_referral_code", "an inactive referral code cannot be captured");
  database.query("UPDATE enrollment_referral_code SET status = 'active' WHERE id = 'referrer-code'");
  database.query("UPDATE enrollment SET status = 'awaiting_initial_payment' WHERE id = 'referrer-enrollment'");
  const unconfirmedReferral = submission("class-production"); unconfirmedReferral.children[0].codeInput = "NE-REF2345";
  await assert.rejects(createRegistrationDraft(productionEnabled, unconfirmedReferral, new Date(iso(-2))),
    (error) => error.code === "invalid_referral_code", "a code cannot be used until its source enrollment is confirmed");

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
