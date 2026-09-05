import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-canonical-promotion-"));
const databasePath = path.join(tempDir, "promotion.sqlite3");
const bundlePath = path.join(tempDir, "canonical-promotion.mjs");
const discountBundlePath = path.join(tempDir, "discounts.mjs");
const capacityBundlePath = path.join(tempDir, "class-capacity.mjs");
const cancellationBundlePath = path.join(tempDir, "registration-cancellation.mjs");
const paymentBundlePath = path.join(tempDir, "payment-reconciliation.mjs");
const parentCommunicationBundlePath = path.join(tempDir, "parent-communication.mjs");
const verificationBundlePath = path.join(tempDir, "email-verification.mjs");

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
  const output = sql.replaceAll("?", () => sqlValue(values[index++]));
  assert.equal(index, values.length);
  return output;
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
    const output = sqlite(`CREATE TEMP TABLE _batch_changes (idx INTEGER, changes INTEGER); BEGIN IMMEDIATE;
${statements.map((statement, index) => `${bindSql(statement.sql, statement.values)}; INSERT INTO _batch_changes VALUES (${index}, changes());`).join("\n")}
COMMIT; SELECT * FROM _batch_changes ORDER BY idx;`, true);
    return (output ? JSON.parse(output) : []).map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } }));
  }
}

function count(database, table, where = "1 = 1") { return Number(database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)[0].count); }
const now = "2026-08-15T04:00:00.000Z";
const actor = { staffAccountId: "teacher", displayName: "Тест Багш", roles: ["teacher"], capabilities: ["payment.view", "payment.manage", "registration.manage"], sessionId: "test", sessionExpiresAt: now, sessionAbsoluteExpiresAt: now };

function env(DB) {
  return { APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "true", EMAIL_ENABLED: "true", AUTH_EMAIL_ENABLED: "false", STAFF_AUTH_EMAIL_ENABLED: "true", APP_ORIGIN: "https://staging.example.test", EMAIL_FROM: "Наран Эрдэм <burtgel@mail.naranerdem.com>", RESEND_API_KEY: "test-resend-key", STAGING_EMAIL_OVERRIDE_TO: "safe@example.test", DB };
}

function seedDraft(database, id, options = {}) {
  const email = options.email ?? `${id}@example.test`;
  const surname = options.surname ?? "Тест";
  const givenName = options.givenName ?? id;
  const birth = options.birth ?? "2015-05-10";
  const gender = options.gender ?? "female";
  const returning = options.returning ?? "new";
  const classId = options.classId ?? "class-1";
  database.query(`INSERT INTO registration_draft (
    id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone,
    email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version,
    status, verified_at, expires_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 'year', ?, 'Ээж', '99000000', ?, ?, 'Тест хаяг', 'single', 'parent-rules-v1', 'student-rules-v1',
    'awaiting_initial_payment', ?, '2026-08-22T04:00:00.000Z', 1, 'promotion-test', ?, ?)`,
  [id, `${id}`.padEnd(64, "x"), `Асран ${id}`, email, email.toLowerCase(), now, now, now]);
  database.query(`INSERT INTO registration_draft_child (
    id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade,
    current_school, returning_status, selected_stage_code, selected_class_session_id, payment_plan_code,
    initial_payment_amount_mnt, status, initial_payment_reconciled_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 0, ?, ?, ?, ?, '5', 'Тест сургууль', ?, 'stage_1', ?, 'single', 100000,
    'awaiting_initial_payment', ?, 1, 'promotion-test', ?, ?)`, [
    `${id}-child`, id, surname, givenName, gender, birth, returning, classId, now, now, now,
  ]);
  database.query(`INSERT INTO registration_capacity_hold (
    id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, 'initial_payment', 'active', '2026-08-16T04:00:00.000Z', 1, 'promotion-test', ?, ?)`,
  [`${id}-hold`, `${id}-child`, classId, now, now]);
  database.query(`INSERT INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
    VALUES (?, ?, ?, ?, ?, 1, 'promotion-test')`, [`${id}-request`, id, `NE-${id.toUpperCase()}`, now, now]);
  database.query(`INSERT INTO payment_installment (
    id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt,
    original_due_at, effective_due_at, status, paid_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, 1, 'initial', 100000, '2026-08-16T04:00:00.000Z', '2026-08-16T04:00:00.000Z', 'paid', ?, 1, 'promotion-test', ?, ?)`,
  [`${id}-initial`, `${id}-request`, `${id}-child`, now, now, now]);
  return { id, childId: `${id}-child`, email: email.toLowerCase() };
}

function markApprovedPartial(database, draft, amount = 20000, confirmationStatus = "finalized") {
  database.query(`UPDATE payment_installment SET status = 'partially_paid', paid_at = NULL WHERE id = ?`, [`${draft.id}-initial`]);
  database.query(`INSERT INTO received_payment (
    id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status,
    confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, 'staff_manual_bank', 'confirmed', ?, ?, ?, ?, 1, 'promotion-test')`,
  [`${draft.id}-payment`, `${draft.id}-request`, amount, now, now, `${draft.id}-partial`, now, now]);
  database.query(`INSERT INTO payment_allocation (
    id, received_payment_id, payment_installment_id, allocated_amount_mnt, allocated_at,
    created_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, ?, ?, 1, 'promotion-test')`,
  [`${draft.id}-allocation`, `${draft.id}-payment`, `${draft.id}-initial`, amount, now, now]);
  database.query(`INSERT INTO payment_confirmation (
    id, received_payment_id, payment_request_id, status, finalize_after, seat_confirmation_approved,
    remaining_payment_due_at, finalized_at, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 'promotion-test')`,
  [`${draft.id}-confirmation`, `${draft.id}-payment`, `${draft.id}-request`, confirmationStatus, now, '2026-09-30T04:00:00.000Z', confirmationStatus === "finalized" ? now : null, now, now]);
}

function markFinalizedApprovedPartial(database, draft, amount = 20000) {
  markApprovedPartial(database, draft, amount, "finalized");
}

function seedGuardian(database, id, email) {
  database.query(`INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
    VALUES (?, 'Өмнөх асран', '99112233', '99112233', ?, ?, 'Тест хаяг', 'active', 1, 'promotion-test', ?, ?)`, [id, email, email, now, now]);
}

function seedStudent(database, id, surname, givenName, birth = "2015-05-10", gender = "female") {
  database.query(`INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', 1, 'promotion-test', ?, ?)`, [id, surname, givenName, gender, birth, now, now]);
}

function link(database, guardianId, studentId, id = `${guardianId}-${studentId}`) {
  database.query(`INSERT INTO guardian_student_relationship (id, guardian_id, student_id, relationship_label, is_authorized_to_register, status, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, ?, 'Ээж', 1, 'active', 1, 'promotion-test', ?, ?)`, [id, guardianId, studentId, now, now]);
}

const originalFetch = globalThis.fetch;
const emailRequests = [];
try {
  globalThis.fetch = async (_url, request) => {
    emailRequests.push(JSON.parse(request.body));
    return new Response(JSON.stringify({ id: `email-${crypto.randomUUID()}` }), {
    status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const migrations = readdirSync("migrations").filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().map((name) => readFileSync(path.join("migrations", name), "utf8")).join("\n");
  sqlite(migrations);
  const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");
  const bundled = spawnSync(esbuild, ["src/server/services/canonical-enrollment-promotion.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" });
  if (bundled.status !== 0) throw new Error(bundled.stderr);
  const { promotePaidDraftChild, getPromotionReviewQueue, resolvePromotionIdentity, CanonicalPromotionError } = await import(pathToFileURL(bundlePath).href);
  const capacityBundled = spawnSync(esbuild, ["src/server/services/class-capacity.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${capacityBundlePath}`], { encoding: "utf8" });
  if (capacityBundled.status !== 0) throw new Error(capacityBundled.stderr);
  const { getClassCapacityProjections } = await import(pathToFileURL(capacityBundlePath).href);
  const cancellationBundled = spawnSync(esbuild, ["src/server/staff/registration-cancellation.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${cancellationBundlePath}`], { encoding: "utf8" });
  if (cancellationBundled.status !== 0) throw new Error(cancellationBundled.stderr);
  const { cancelRegistration, reinstateRegistration, getRegistrationReinstatementEligibility, RegistrationCancellationError } = await import(pathToFileURL(cancellationBundlePath).href);
  const paymentBundled = spawnSync(esbuild, ["src/server/staff/payment-reconciliation.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${paymentBundlePath}`], { encoding: "utf8" });
  if (paymentBundled.status !== 0) throw new Error(paymentBundled.stderr);
  const { finalizeDuePaymentConfirmations } = await import(pathToFileURL(paymentBundlePath).href);
  const parentCommunicationBundled = spawnSync(esbuild, ["src/server/staff/parent-communication.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${parentCommunicationBundlePath}`], { encoding: "utf8" });
  if (parentCommunicationBundled.status !== 0) throw new Error(parentCommunicationBundled.stderr);
  const verificationBundled = spawnSync(esbuild, ["src/server/auth/email-verification.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${verificationBundlePath}`], { encoding: "utf8" });
  if (verificationBundled.status !== 0) throw new Error(verificationBundled.stderr);
  const { resendParentEnrollmentSummary, ParentCommunicationError } = await import(pathToFileURL(parentCommunicationBundlePath).href);
  const { verifyEmailToken } = await import(pathToFileURL(verificationBundlePath).href);
  const discountsBundle = spawnSync(esbuild, ["src/server/services/discounts.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${discountBundlePath}`], { encoding: "utf8" });
  if (discountsBundle.status !== 0) throw new Error(discountsBundle.stderr);
  const { getDiscountPolicySetting, updateDiscountPolicySetting, effectiveInstallments, DiscountPolicyError } = await import(pathToFileURL(discountBundlePath).href);
  const database = new SqliteD1();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year', 'Тест жил', 'open', 1, 1, 'promotion-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('class-1', 'year', 'stage_1', '1-р шат', 'Бямба', '10:00', '11:20', 20, 'available', 1, 1, 'promotion-test', '${now}', '${now}');`);
  database.query(`INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('class-cancel', 'year', 'stage_1', 'Цуцлалтын анги', 'Мягмар', '10:00', '11:20', 3, 'available', 1, 1, 'promotion-test', '${now}', '${now}'),
      ('class-wait', 'year', 'stage_1', 'Хүлээлтийн анги', 'Пүрэв', '10:00', '11:20', 1, 'available', 1, 1, 'promotion-test', '${now}', '${now}');`);

  const policy = await getDiscountPolicySetting(env(database));
  assert.deepEqual({ family: policy.familyMultiChildBasisPoints, referrer: policy.referrerBasisPoints, referred: policy.referredChildBasisPoints }, { family: 1000, referrer: 500, referred: 200 }, "the typed policy starts at the reviewed 10/5/2 defaults");
  const admin = { ...actor, roles: ["admin"], capabilities: ["admin.settings.manage"] };
  const changedPolicy = await updateDiscountPolicySetting(env(database), admin, { familyMultiChildBasisPoints: 1100, referrerBasisPoints: 500, referredChildBasisPoints: 200, expectedUpdatedAt: policy.updatedAt });
  assert.equal(changedPolicy.familyMultiChildBasisPoints, 1100, "admin policy update applies to future awards");
  assert.equal(count(database, "audit_event", "action = 'discount_policy_changed'"), 1, "policy change is audited");
  await assert.rejects(() => updateDiscountPolicySetting(env(database), actor, { familyMultiChildBasisPoints: 1000, referrerBasisPoints: 500, referredChildBasisPoints: 200, expectedUpdatedAt: changedPolicy.updatedAt }), DiscountPolicyError, "teacher cannot change discount policy");
  await assert.rejects(() => updateDiscountPolicySetting(env(database), { ...actor, roles: ["accountant"], capabilities: ["payment.view"] }, { familyMultiChildBasisPoints: 1000, referrerBasisPoints: 500, referredChildBasisPoints: 200, expectedUpdatedAt: changedPolicy.updatedAt }), DiscountPolicyError, "accountant cannot change discount policy");
  await updateDiscountPolicySetting(env(database), admin, { familyMultiChildBasisPoints: 1000, referrerBasisPoints: 500, referredChildBasisPoints: 200, expectedUpdatedAt: changedPolicy.updatedAt });
  assert.deepEqual(effectiveInstallments([
    { id: "first", registrationDraftChildId: "child", installmentNumber: 1, amountMnt: 40001 },
    { id: "later", registrationDraftChildId: "child", installmentNumber: 2, amountMnt: 59999 },
  ], new Map([["child", [{ awardAmountMnt: 10000 }]]])), [
    { id: "first", registrationDraftChildId: "child", installmentNumber: 1, amountMnt: 40001, discountAmountMnt: 4000, effectiveAmountMnt: 36001 },
    { id: "later", registrationDraftChildId: "child", installmentNumber: 2, amountMnt: 59999, discountAmountMnt: 6000, effectiveAmountMnt: 53999 },
  ], "integer MNT discounts allocate proportionally with final-installment reconciliation");
  assert.deepEqual(effectiveInstallments([
    { id: "first", registrationDraftChildId: "equal", installmentNumber: 1, amountMnt: 650000 },
    { id: "later", registrationDraftChildId: "equal", installmentNumber: 2, amountMnt: 650000 },
  ], new Map([["equal", [{ awardAmountMnt: 130000 }]]])).map((item) => item.effectiveAmountMnt), [585000, 585000], "known ten-percent awards reduce equal installments proportionally");
  assert.deepEqual(effectiveInstallments([
    { id: "single", registrationDraftChildId: "one-time", installmentNumber: 1, amountMnt: 1200000 },
  ], new Map([["one-time", [{ awardAmountMnt: 120000 }]]])).map((item) => item.effectiveAmountMnt), [1080000], "one-time pricing remains exact after a family award");
  assert.deepEqual(effectiveInstallments([
    { id: "first", registrationDraftChildId: "unequal", installmentNumber: 1, amountMnt: 40001 },
    { id: "later", registrationDraftChildId: "unequal", installmentNumber: 2, amountMnt: 59999 },
  ], new Map([["unequal", [{ awardAmountMnt: 10001 }]]])).map((item) => item.effectiveAmountMnt), [36001, 53998], "unequal installments reconcile integer rounding on the final unpaid installment");
  assert.deepEqual(effectiveInstallments([
    { id: "first", registrationDraftChildId: "stacked-plan", installmentNumber: 1, amountMnt: 650000 },
    { id: "later", registrationDraftChildId: "stacked-plan", installmentNumber: 2, amountMnt: 650000 },
  ], new Map([["stacked-plan", [{ awardAmountMnt: 130000 }, { awardAmountMnt: 26000 }]]])).map((item) => item.effectiveAmountMnt), [572000, 572000], "stacked original-plan awards total 156,000 MNT and remain proportional");
  assert.deepEqual(effectiveInstallments([
    { id: "first", registrationDraftChildId: "paid", installmentNumber: 1, amountMnt: 650000, allocatedAmountMnt: 650000 },
    { id: "later", registrationDraftChildId: "paid", installmentNumber: 2, amountMnt: 650000 },
  ], new Map([["paid", [{ awardAmountMnt: 65000 }]]])).map((item) => item.effectiveAmountMnt), [650000, 585000], "later awards reduce only the remaining unpaid installment");
  assert.deepEqual(
    effectiveInstallments([{ id: "stacked", registrationDraftChildId: "ordered", installmentNumber: 1, amountMnt: 1300000 }], new Map([["ordered", [{ awardAmountMnt: 130000 }, { awardAmountMnt: 26000 }]]])),
    effectiveInstallments([{ id: "stacked", registrationDraftChildId: "ordered", installmentNumber: 1, amountMnt: 1300000 }], new Map([["ordered", [{ awardAmountMnt: 26000 }, { awardAmountMnt: 130000 }]]])),
    "award insertion order cannot change the effective installment result",
  );
  const stackedInputs = [{ id: "single", registrationDraftChildId: "stacked", installmentNumber: 1, amountMnt: 100000 }];
  assert.deepEqual(
    effectiveInstallments(stackedInputs, new Map([["stacked", [{ awardAmountMnt: 10000 }, { awardAmountMnt: 2000 }]]])),
    effectiveInstallments(stackedInputs, new Map([["stacked", [{ awardAmountMnt: 2000 }, { awardAmountMnt: 10000 }]]])),
    "stacked awards have an order-independent payable result",
  );

  const first = seedDraft(database, "new-family");
  assert.deepEqual(await promotePaidDraftChild(env(database), actor, first.childId), { state: "promoted", enrollmentId: `${first.childId}:enrollment` });
  assert.equal(count(database, "guardian_account"), 1, "new verified family creates one guardian");
  assert.equal(count(database, "student"), 1, "new child creates one student");
  assert.equal(count(database, "pre_registration"), 1, "source draft has one canonical application container");
  assert.equal(count(database, "application_child"), 1);
  assert.equal(count(database, "enrollment", "status = 'confirmed'"), 1);
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${first.childId}' AND status = 'active'`), 0, "draft reservation resolves only with the confirmed enrollment");
  assert.equal(count(database, "payment_installment", `canonical_enrollment_id = '${first.childId}:enrollment'`), 1, "installment retains canonical linkage");
  assert.deepEqual(await promotePaidDraftChild(env(database), actor, first.childId), { state: "promoted", enrollmentId: `${first.childId}:enrollment` }, "promotion retry is idempotent");
  assert.equal(count(database, "enrollment"), 1);
  const firstReferralCode = database.query(`SELECT id, code FROM enrollment_referral_code WHERE enrollment_id = ?`, [`${first.childId}:enrollment`])[0];
  assert.match(firstReferralCode.code, /^NE-[A-Z2-9]{7}$/, "a confirmed child receives a short opaque referral code");
  assert.doesNotMatch(firstReferralCode.code, /Тест|Хүүхэд|example/i, "a referral code contains no child or contact information");
  const firstResend = await resendParentEnrollmentSummary(env(database), actor, first.childId);
  assert.deepEqual(firstResend, { ok: true }, "transactional enrollment resend works while optional auth email is disabled");
  assert.equal(count(database, "outbound_email", `registration_draft_id = '${first.id}' AND event_type = 'parent_enrollment_resend' AND status = 'sent'`), 1,
    "a resend has one durably sent outbox item");
  assert.equal(count(database, "email_verification_challenge", `registration_draft_id = '${first.id}' AND status = 'pending'`), 1,
    "resend leaves one fresh pending parent-access challenge");
  assert.equal(database.query(`SELECT email_sensitivity AS sensitivity, bcc_recipients_json AS bccRecipients FROM outbound_email
    WHERE registration_draft_id = ? AND event_type = 'parent_enrollment_resend'`, [first.id])[0].sensitivity, "sensitive_capability",
    "a capability email is excluded from the archive BCC path");
  await assert.rejects(() => resendParentEnrollmentSummary(env(database), actor, first.childId),
    (error) => error instanceof ParentCommunicationError && error.code === "cooldown", "rapid resend repeats are blocked before another challenge is created");
  database.query(`UPDATE outbound_email SET queued_at = '2026-08-15T03:00:00.000Z' WHERE registration_draft_id = ? AND event_type = 'parent_enrollment_resend'`, [first.id]);
  await resendParentEnrollmentSummary(env(database), actor, first.childId);
  assert.equal(count(database, "outbound_email", `registration_draft_id = '${first.id}' AND event_type = 'parent_enrollment_resend' AND status = 'sent'`), 2,
    "a later deliberate resend creates a fresh durable outbox item");
  assert.equal(count(database, "email_verification_challenge", `registration_draft_id = '${first.id}' AND status = 'pending'`), 1,
    "a fresh resend invalidates the earlier unused challenge");
  const lastEnrollmentEmail = emailRequests.at(-1);
  assert.match(lastEnrollmentEmail.html, /Бүртгэлээ харах/, "the delivered resend includes parent access");
  const accessToken = new URL(lastEnrollmentEmail.html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&")).hash.match(/token=([^&]+)/)[1];
  const exchange = await verifyEmailToken(env(database), decodeURIComponent(accessToken));
  assert.equal(exchange.redirectUrl, "https://staging.example.test/parent/", "the resend link establishes parent access");
  assert.equal(count(database, "verified_email_session", `registration_draft_id = '${first.id}'`), 1, "the exchanged resend link creates one parent session");

  const referred = seedDraft(database, "referred-family", { email: "referred@example.test" });
  database.query(`INSERT INTO registration_draft_referral (
    registration_draft_child_id, referral_code_id, referring_enrollment_id, captured_code,
    status, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'captured', 1, 'promotion-test', ?, ?)`,
  [referred.childId, firstReferralCode.id, `${first.childId}:enrollment`, firstReferralCode.code, now, now]);
  await promotePaidDraftChild(env(database), actor, referred.childId);
  assert.equal(count(database, "referral", `referred_application_child_id = '${referred.childId}:application' AND status = 'qualified'`), 1,
    "a captured active code becomes a qualified canonical referral only after the referred child is confirmed");
  assert.equal(count(database, "discount_award", `registration_draft_child_id = '${referred.childId}' AND award_type = 'referral_referred' AND status = 'active'`), 0,
    "this fixture captures the historic referral directly, so it does not invent a referred-child registration award");
  assert.equal(count(database, "discount_award", `source_referral_id = '${referred.childId}:referral' AND award_type = 'referral_referrer' AND status = 'active'`), 1,
    "the referrer earns one award only after the referred child is confirmed");
  assert.equal(count(database, "enrollment_referral_code", `enrollment_id = '${referred.childId}:enrollment' AND status = 'active'`), 1,
    "the newly confirmed referred child also receives an independent code");
  await promotePaidDraftChild(env(database), actor, referred.childId);
  assert.equal(count(database, "referral", `referred_application_child_id = '${referred.childId}:application'`), 1,
    "promotion retry does not duplicate a referral relationship");
  assert.equal(count(database, "discount_award", `source_referral_id = '${referred.childId}:referral' AND award_type = 'referral_referrer'`), 1,
    "promotion retry does not duplicate the referrer award");

  const selfReferral = seedDraft(database, "self-referral", { email: first.email, surname: "Өөр", givenName: "Дүү" });
  database.query(`INSERT INTO registration_draft_referral (
    registration_draft_child_id, referral_code_id, referring_enrollment_id, captured_code,
    status, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'captured', 1, 'promotion-test', ?, ?)`,
  [selfReferral.childId, firstReferralCode.id, `${first.childId}:enrollment`, firstReferralCode.code, now, now]);
  await promotePaidDraftChild(env(database), actor, selfReferral.childId);
  assert.equal(count(database, "referral", `referred_application_child_id = '${selfReferral.childId}:application' AND status = 'disqualified' AND qualification_reason = 'same_family'`), 1,
    "a same-family referral is retained for audit but cannot qualify for a future benefit");

  const existingGuardianEmail = "returning@example.test";
  seedGuardian(database, "guardian-returning", existingGuardianEmail);
  seedStudent(database, "student-returning", "Бат", "Сараа");
  link(database, "guardian-returning", "student-returning");
  const returning = seedDraft(database, "exact-returning", { email: existingGuardianEmail, surname: "  Бат ", givenName: "Сараа", returning: "returning" });
  const exact = await promotePaidDraftChild(env(database), actor, returning.childId);
  assert.equal(exact.state, "promoted");
  assert.equal(database.query(`SELECT canonical_student_id AS studentId FROM registration_draft_child WHERE id = ?`, [returning.childId])[0].studentId, "student-returning", "exact normalized linked child is reused");

  const duplicate = seedDraft(database, "new-selects-existing", { email: existingGuardianEmail, surname: "Бат", givenName: "Сараа", returning: "new" });
  await promotePaidDraftChild(env(database), actor, duplicate.childId);
  assert.equal(database.query(`SELECT canonical_student_id AS studentId FROM registration_draft_child WHERE id = ?`, [duplicate.childId])[0].studentId, "student-returning", "exact existing child wins even when parent selected new");

  const review = seedDraft(database, "returning-missing", { email: existingGuardianEmail, surname: "Өөр", givenName: "Хүүхэд", returning: "returning" });
  assert.equal((await promotePaidDraftChild(env(database), actor, review.childId)).state, "promoted");
  assert.equal(count(database, "enrollment", `id = '${review.childId}:enrollment' AND status = 'confirmed'`), 1, "a returning child with zero plausible matches gets a new canonical record automatically");
  assert.equal(count(database, "outbound_email", `registration_draft_id = '${review.id}' AND event_type = 'enrollment_confirmed'`), 1, "automatic zero-match promotion queues one enrollment confirmation email");

  const elsewhere = seedDraft(database, "different-guardian", { email: "other@example.test", surname: "Бат", givenName: "Сараа", returning: "returning" });
  assert.equal((await promotePaidDraftChild(env(database), actor, elsewhere.childId)).state, "needs_identity_review", "global exact match is never automatic for another verified guardian");
  const reviewQueue = await getPromotionReviewQueue(env(database), actor);
  assert.ok(reviewQueue.items.find((item) => item.childId === elsewhere.childId)?.candidates.some((candidate) => candidate.id === "student-returning"), "staff review sees only strict exact candidates");
  await resolvePromotionIdentity(env(database), actor, elsewhere.childId, { kind: "existing", studentId: "student-returning" });
  assert.equal(count(database, "guardian_student_relationship", "guardian_id = (SELECT canonical_guardian_account_id FROM registration_draft WHERE id = 'different-guardian') AND student_id = 'student-returning' AND status = 'active'"), 1, "explicit staff decision adds an authorized guardian relationship");
  assert.equal(count(database, "outbound_email", `registration_draft_id = '${elsewhere.id}' AND event_type = 'enrollment_confirmed'`), 1, "manual existing-child resolution queues exactly one enrollment confirmation email");
  await resolvePromotionIdentity(env(database), actor, elsewhere.childId, { kind: "existing", studentId: "student-returning" });
  assert.equal(count(database, "outbound_email", `registration_draft_id = '${elsewhere.id}' AND event_type = 'enrollment_confirmed'`), 1, "manual existing-child replay does not duplicate the logical confirmation email");

  const newElsewhere = seedDraft(database, "new-different-guardian", { email: "new-other@example.test", surname: "Бат", givenName: "Сараа", returning: "new" });
  assert.equal((await promotePaidDraftChild(env(database), actor, newElsewhere.childId)).state, "needs_identity_review",
    "a strict global match never becomes an automatic new canonical child under another guardian");

  const manualNew = seedDraft(database, "manual-new", { email: "manual-new@example.test", surname: "Бат", givenName: "Сараа", returning: "returning" });
  assert.equal((await promotePaidDraftChild(env(database), actor, manualNew.childId)).state, "needs_identity_review", "a conflicting strict returning match still requires staff review");
  await resolvePromotionIdentity(env(database), actor, manualNew.childId, { kind: "new" });
  assert.equal(database.query(`SELECT identity_resolution_status AS status FROM registration_draft_child WHERE id = ?`, [manualNew.childId])[0].status, "promoted");
  assert.equal(count(database, "outbound_email", `registration_draft_id = '${manualNew.id}' AND event_type = 'enrollment_confirmed'`), 1, "manual new-child resolution queues exactly one enrollment confirmation email");

  const approvedPartial = seedDraft(database, "approved-partial", { email: "approved-partial@example.test" });
  markFinalizedApprovedPartial(database, approvedPartial);
  const approvedPartialBefore = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-1"]))[0];
  assert.equal((await promotePaidDraftChild(env(database), actor, approvedPartial.childId)).state, "promoted", "a finalized, teacher-approved partial payment is promotion-eligible");
  assert.equal(count(database, "enrollment", `id = '${approvedPartial.childId}:enrollment' AND status = 'confirmed'`), 1, "remaining tuition does not block canonical enrollment");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${approvedPartial.childId}' AND status = 'active'`), 0, "promotion swaps the partial-payment hold for the canonical enrollment");
  const approvedPartialAfter = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-1"]))[0];
  assert.equal(approvedPartialAfter.freeSeats, approvedPartialBefore.freeSeats, "the approved partial promotion keeps exactly one consumed seat");
  assert.equal(approvedPartialAfter.confirmedCount, approvedPartialBefore.confirmedCount + 1, "promotion transfers capacity from the hold to the canonical enrollment");
  assert.equal(approvedPartialAfter.reservedInitialPaymentCount, approvedPartialBefore.reservedInitialPaymentCount - 1, "the old hold no longer consumes capacity after promotion");
  assert.equal((await promotePaidDraftChild(env(database), actor, approvedPartial.childId)).state, "promoted", "approved partial promotion retries without duplicating enrollment or capacity");
  assert.equal(count(database, "enrollment", `id = '${approvedPartial.childId}:enrollment'`), 1, "replay creates no second canonical enrollment");

  seedStudent(database, "student-partial-review-a", "Шийдэх", "Хүүхэд");
  seedStudent(database, "student-partial-review-b", "Шийдэх", "Хүүхэд");
  link(database, "guardian-returning", "student-partial-review-a");
  link(database, "guardian-returning", "student-partial-review-b");
  const partialNeedsReview = seedDraft(database, "partial-needs-review", { email: existingGuardianEmail, surname: "Шийдэх", givenName: "Хүүхэд", returning: "returning" });
  markFinalizedApprovedPartial(database, partialNeedsReview);
  assert.equal((await promotePaidDraftChild(env(database), actor, partialNeedsReview.childId)).state, "needs_identity_review", "ambiguous approved partial payments retain their protected seat for review");
  const partialReviewQueue = await getPromotionReviewQueue(env(database), actor);
  assert.ok(partialReviewQueue.items.find((item) => item.childId === partialNeedsReview.childId), "staff review includes finalized approved partial payments");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${partialNeedsReview.childId}' AND status = 'active'`), 1, "identity review preserves the one capacity-consuming hold");
  const partialReviewCapacity = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-1"]))[0];
  assert.ok(partialReviewCapacity.identityReviewCount >= 1, "capacity projection identifies protected seats awaiting identity review separately from ordinary payment waiting");
  await resolvePromotionIdentity(env(database), actor, partialNeedsReview.childId, { kind: "new" });
  assert.equal(count(database, "enrollment", `id = '${partialNeedsReview.childId}:enrollment' AND status = 'confirmed'`), 1, "staff identity resolution promotes the approved partial exactly once");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${partialNeedsReview.childId}' AND status = 'active'`), 0, "identity resolution swaps, rather than adds to, occupied capacity");
  const resolvedPartialReviewCapacity = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-1"]))[0];
  assert.equal(resolvedPartialReviewCapacity.identityReviewCount, partialReviewCapacity.identityReviewCount - 1, "resolving the identity review removes only that review classification, not capacity");

  const unapprovedPartial = seedDraft(database, "unapproved-partial", { email: "unapproved-partial@example.test" });
  database.query(`UPDATE payment_installment SET status = 'partially_paid', paid_at = NULL WHERE id = ?`, [`${unapprovedPartial.id}-initial`]);
  assert.equal((await promotePaidDraftChild(env(database), actor, unapprovedPartial.childId)).state, "not_eligible", "a partial payment without finalized seat approval cannot promote");

  seedGuardian(database, "guardian-ambiguous", "ambiguous@example.test");
  seedStudent(database, "student-twin-a", "Ижил", "Хүүхэд");
  seedStudent(database, "student-twin-b", "Ижил", "Хүүхэд");
  link(database, "guardian-ambiguous", "student-twin-a");
  link(database, "guardian-ambiguous", "student-twin-b");
  const ambiguous = seedDraft(database, "ambiguous-child", { email: "ambiguous@example.test", surname: "Ижил", givenName: "Хүүхэд", returning: "returning" });
  assert.equal((await promotePaidDraftChild(env(database), actor, ambiguous.childId)).state, "needs_identity_review", "multiple exact linked children are never guessed");

  const siblings = seedDraft(database, "siblings", { email: "siblings@example.test", surname: "Ах", givenName: "Нэг" });
  database.query(`INSERT INTO registration_draft_child (
    id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade,
    current_school, returning_status, selected_stage_code, selected_class_session_id, payment_plan_code,
    initial_payment_amount_mnt, status, initial_payment_reconciled_at, is_test, test_run_id, created_at, updated_at
  ) VALUES ('siblings-child-two', 'siblings', 1, 'Ах', 'Хоёр', 'female', '2016-06-10', '4', 'Тест сургууль',
    'new', 'stage_1', 'class-1', 'single', 100000, 'awaiting_initial_payment', ?, 1, 'promotion-test', ?, ?)
  `, [now, now, now]);
  database.query(`INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
    VALUES ('siblings-hold-two', 'siblings-child-two', 'class-1', 'initial_payment', 'active', '2026-08-16T04:00:00.000Z', 1, 'promotion-test', ?, ?)`, [now, now]);
  database.query(`INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, status, paid_at, is_test, test_run_id, created_at, updated_at)
    VALUES ('siblings-initial-two', 'siblings-request', 'siblings-child-two', 1, 'initial', 100000, '2026-08-16T04:00:00.000Z', '2026-08-16T04:00:00.000Z', 'paid', ?, 1, 'promotion-test', ?, ?)`, [now, now, now]);
  await promotePaidDraftChild(env(database), actor, siblings.childId);
  await promotePaidDraftChild(env(database), actor, "siblings-child-two");
  assert.equal(count(database, "pre_registration", "id = 'siblings:pre-registration'"), 1, "siblings share one canonical registration container");
  assert.equal(count(database, "guardian_account", "email_normalized = 'siblings@example.test'"), 1, "siblings resolve one guardian");
  assert.equal(count(database, "enrollment", "id IN ('siblings-child:enrollment', 'siblings-child-two:enrollment') AND status = 'confirmed'"), 2, "safe siblings promote independently");
  assert.equal(count(database, "discount_award", "registration_draft_child_id IN ('siblings-child', 'siblings-child-two') AND award_type = 'family_multi_child' AND status = 'active'"), 2,
    "two confirmed children under one canonical guardian each receive exactly one family award");
  assert.equal(database.query(`SELECT award_amount_mnt AS amountMnt FROM discount_award WHERE registration_draft_child_id = 'siblings-child' AND award_type = 'family_multi_child'`)[0].amountMnt, 10000,
    "family award snapshots the default ten percent of the selected plan");

  const fallback = seedDraft(database, "fallback", { email: "fallback@example.test" });
  database.query(`INSERT INTO registration_draft_waitlist_entry (id, registration_draft_child_id, class_session_id, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('fallback-waitlist', ?, 'class-1', 'active', 1, 'promotion-test', '2026-08-01T04:00:00.000Z', ?)`, [fallback.childId, now]);
  await promotePaidDraftChild(env(database), actor, fallback.childId);
  const preservedWaitlist = database.query(`SELECT status, created_at AS createdAt, canonical_application_child_id AS applicationId FROM registration_draft_waitlist_entry WHERE id = 'fallback-waitlist'`)[0];
  assert.deepEqual(preservedWaitlist, { status: "active", createdAt: "2026-08-01T04:00:00.000Z", applicationId: `${fallback.childId}:application` }, "draft FIFO waitlist remains the one active authority with original priority");

  const unpaidCancellation = seedDraft(database, "cancel-unpaid", { classId: "class-cancel", email: "cancel-unpaid@example.test" });
  database.query(`UPDATE payment_installment SET status = 'pending', paid_at = NULL WHERE id = ?`, [`${unpaidCancellation.id}-initial`]);
  const unpaidBefore = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0];
  const unpaidCancelled = await cancelRegistration(env(database), actor, { registrationDraftChildId: unpaidCancellation.childId, reason: "guardian_request" });
  assert.equal(unpaidCancelled.cancelled, true, "an unresolved initial-payment reservation can be cancelled");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${unpaidCancellation.childId}' AND status = 'active'`), 0, "cancellation resolves the active hold");
  assert.equal(database.query(`SELECT status FROM registration_draft_child WHERE id = ?`, [unpaidCancellation.childId])[0].status, "cancelled");
  const unpaidAfter = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0];
  assert.equal(unpaidAfter.freeSeats, unpaidBefore.freeSeats + 1, "an unpaid cancellation releases exactly one seat");
  assert.equal((await cancelRegistration(env(database), actor, { registrationDraftChildId: unpaidCancellation.childId, reason: "guardian_request" })).idempotent, true, "a replay cannot release another seat");
  assert.equal((await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0].freeSeats, unpaidAfter.freeSeats, "replay leaves capacity unchanged");

  const reviewCancellation = seedDraft(database, "cancel-review", { classId: "class-cancel", email: existingGuardianEmail, surname: "Хянах", givenName: "Хүүхэд", returning: "returning" });
  markFinalizedApprovedPartial(database, reviewCancellation);
  assert.equal((await promotePaidDraftChild(env(database), actor, reviewCancellation.childId)).state, "promoted");
  database.query(`INSERT INTO payment_notification_milestone (id, milestone_key, registration_draft_id, registration_draft_child_id, payment_installment_id, channel, milestone_type, scheduled_at, status, created_at, updated_at, is_test, test_run_id)
    VALUES ('cancel-review-reminder', 'cancel-review-reminder', ?, ?, ?, 'email', 'initial_reminder', ?, 'pending', ?, ?, 1, 'promotion-test')`, [reviewCancellation.id, reviewCancellation.childId, `${reviewCancellation.id}-initial`, now, now, now]);
  await cancelRegistration(env(database), actor, { registrationDraftChildId: reviewCancellation.childId, reason: "payment_overdue" });
  assert.equal(database.query(`SELECT status FROM enrollment WHERE id = ?`, [`${reviewCancellation.childId}:enrollment`])[0].status, "cancelled", "cancellation ends a confirmed partial enrollment");
  assert.equal(database.query(`SELECT status FROM payment_notification_milestone WHERE id = 'cancel-review-reminder'`)[0].status, "cancelled", "cancellation stops future reminder work immediately");
  assert.equal((await promotePaidDraftChild(env(database), actor, reviewCancellation.childId)).state, "not_eligible", "promotion replay cannot resurrect a cancelled review");
  assert.ok(!(await getPromotionReviewQueue(env(database), actor)).items.some((item) => item.childId === reviewCancellation.childId), "cancelled enrollment is absent from the staff review queue");

  const tentativeCancellation = seedDraft(database, "cancel-tentative", { classId: "class-cancel", email: "cancel-tentative@example.test" });
  markApprovedPartial(database, tentativeCancellation, 20000, "tentative");
  await cancelRegistration(env(database), actor, { registrationDraftChildId: tentativeCancellation.childId, reason: "guardian_request" });
  assert.equal(database.query(`SELECT status FROM payment_confirmation WHERE id = ?`, [`${tentativeCancellation.id}-confirmation`])[0].status, "undone", "cancellation ends an unshared tentative confirmation before Cron can finalize it");
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE id = ?`, [`${tentativeCancellation.id}-initial`])[0].status, "released", "a cancelled tentative payment cannot become collectable again");
  assert.equal(count(database, "payment_credit", `received_payment_id = '${tentativeCancellation.id}-payment' AND status = 'available'`), 1, "a cancelled tentative payment is retained as available credit rather than erased");
  assert.equal(await finalizeDuePaymentConfirmations(env(database), new Date("2026-08-16T04:00:00.000Z")), 0, "Cron skips the terminally undone confirmation");

  const partialCancellation = seedDraft(database, "cancel-partial", { classId: "class-cancel", email: "cancel-partial@example.test" });
  markFinalizedApprovedPartial(database, partialCancellation);
  await promotePaidDraftChild(env(database), actor, partialCancellation.childId);
  const partialBefore = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0];
  await cancelRegistration(env(database), actor, { registrationDraftChildId: partialCancellation.childId, reason: "other", note: "Тест" });
  assert.equal(database.query(`SELECT status FROM enrollment WHERE id = ?`, [`${partialCancellation.childId}:enrollment`])[0].status, "cancelled", "confirmed partial enrollment becomes non-capacity-consuming");
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE id = ?`, [`${partialCancellation.id}-initial`])[0].status, "released", "remaining partial obligation stops collecting");
  assert.equal(count(database, "received_payment", `id = '${partialCancellation.id}-payment'`), 1, "received partial payment remains immutable history");
  assert.equal(count(database, "payment_credit", `received_payment_id = '${partialCancellation.id}-payment' AND status = 'available'`), 1, "an unshared received partial payment becomes available credit");
  const partialAfter = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0];
  assert.equal(partialAfter.freeSeats, partialBefore.freeSeats + 1, "confirmed partial cancellation releases one seat");

  const reinstatement = seedDraft(database, "cancel-reinstate", { classId: "class-cancel", email: "cancel-reinstate@example.test" });
  database.query(`INSERT INTO payment_installment (
    id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt,
    original_due_at, effective_due_at, status, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, 2, 'later', 65000, '2027-01-25T04:00:00.000Z', '2027-01-25T04:00:00.000Z', 'pending', 1, 'promotion-test', ?, ?)`,
  [`${reinstatement.id}-later`, `${reinstatement.id}-request`, reinstatement.childId, now, now]);
  database.query(`INSERT INTO received_payment (
    id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status,
    confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, 100000, ?, 'staff_manual_bank', 'confirmed', ?, ?, ?, ?, 1, 'promotion-test')`,
  [`${reinstatement.id}-payment`, `${reinstatement.id}-request`, now, now, `${reinstatement.id}-payment-key`, now, now]);
  database.query(`INSERT INTO payment_allocation (
    id, received_payment_id, payment_installment_id, allocated_amount_mnt, allocated_at,
    created_at, is_test, test_run_id
  ) VALUES (?, ?, ?, 100000, ?, ?, 1, 'promotion-test')`,
  [`${reinstatement.id}-allocation`, `${reinstatement.id}-payment`, `${reinstatement.id}-initial`, now, now]);
  database.query(`INSERT INTO payment_confirmation (
    id, received_payment_id, payment_request_id, status, finalize_after, seat_confirmation_approved,
    remaining_payment_due_at, finalized_at, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, 'finalized', ?, 1, NULL, ?, ?, ?, 1, 'promotion-test')`,
  [`${reinstatement.id}-confirmation`, `${reinstatement.id}-payment`, `${reinstatement.id}-request`, now, now, now, now]);
  await promotePaidDraftChild(env(database), actor, reinstatement.childId);
  database.query(`INSERT INTO payment_notification_milestone (
    id, milestone_key, registration_draft_id, registration_draft_child_id, payment_installment_id,
    channel, milestone_type, scheduled_at, status, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, ?, 'email', 'later_reminder', '2027-01-20T04:00:00.000Z', 'pending', ?, ?, 1, 'promotion-test')`,
  [`${reinstatement.id}-later-reminder`, `${reinstatement.id}-later-reminder`, reinstatement.id, reinstatement.childId, `${reinstatement.id}-later`, now, now]);
  const reinstatementBefore = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0];
  await cancelRegistration(env(database), actor, { registrationDraftChildId: reinstatement.childId, reason: "guardian_request" });
  const reinstatementCancelled = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0];
  assert.equal(reinstatementCancelled.freeSeats, reinstatementBefore.freeSeats + 1, "cancellation releases the confirmed seat before a guarded reinstatement");
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE id = ?`, [`${reinstatement.id}-later`])[0].status, "released", "cancellation releases only the unpaid later installment");
  assert.equal(database.query(`SELECT status FROM payment_credit WHERE received_payment_id = ?`, [`${reinstatement.id}-payment`])[0].status, "available", "cancellation creates an available, auditable credit for the received money");
  assert.equal(await getRegistrationReinstatementEligibility(env(database), reinstatement.childId, new Date(now)), true, "a pre-attendance cancellation with untouched credit and capacity is eligible for reinstatement");
  const restored = await reinstateRegistration(env(database), actor, { registrationDraftChildId: reinstatement.childId }, new Date(now));
  assert.equal(restored.reinstated, true, "the guarded service restores an eligible cancelled registration");
  assert.equal(count(database, "enrollment", `id = '${reinstatement.childId}:enrollment' AND status = 'confirmed'`), 1, "reinstatement reuses the same canonical enrollment");
  assert.equal(count(database, "received_payment", `id = '${reinstatement.id}-payment'`), 1, "reinstatement never fabricates or rewrites received payment history");
  assert.deepEqual(database.query(`SELECT status, amount_mnt AS amountMnt, original_due_at AS originalDueAt, effective_due_at AS effectiveDueAt
    FROM payment_installment WHERE id = ?`, [`${reinstatement.id}-later`])[0], {
    status: "pending", amountMnt: 65000, originalDueAt: "2027-01-25T04:00:00.000Z", effectiveDueAt: "2027-01-25T04:00:00.000Z",
  }, "reinstatement restores the released later installment with its original terms");
  assert.equal(database.query(`SELECT status FROM payment_credit WHERE received_payment_id = ?`, [`${reinstatement.id}-payment`])[0].status, "allocated", "only the cancellation-generated unsettled credit is closed on reinstatement");
  assert.equal(database.query(`SELECT status FROM payment_notification_milestone WHERE id = ?`, [`${reinstatement.id}-later-reminder`])[0].status, "pending", "future later-payment reminder resumes without duplicating history");
  const reinstatementAfter = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0];
  assert.equal(reinstatementAfter.freeSeats, reinstatementCancelled.freeSeats - 1, "reinstatement restores exactly one occupied seat");
  assert.equal(count(database, "audit_event", `subject_id = '${reinstatement.childId}' AND action IN ('registration_cancelled', 'registration_reinstated')`), 2, "cancellation and reinstatement preserve an explicit audit lineage");
  assert.equal((await reinstateRegistration(env(database), actor, { registrationDraftChildId: reinstatement.childId }, new Date(now))).idempotent, true, "replay cannot consume a second seat");
  assert.equal((await getClassCapacityProjections(database, "staging", new Date(now), ["class-cancel"]))[0].freeSeats, reinstatementAfter.freeSeats, "reinstatement replay leaves capacity unchanged");
  await assert.rejects(() => reinstateRegistration(env(database), { ...actor, roles: ["accountant"], capabilities: ["payment.view"] }, { registrationDraftChildId: reinstatement.childId }), RegistrationCancellationError, "accountant cannot reinstate a registration");

  const refundedReinstatement = seedDraft(database, "cancel-refunded", { classId: "class-cancel", email: "cancel-refunded@example.test" });
  database.query(`INSERT INTO received_payment (id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status, confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id)
    VALUES (?, ?, 100000, ?, 'staff_manual_bank', 'confirmed', ?, ?, ?, ?, 1, 'promotion-test');
    INSERT INTO payment_allocation (id, received_payment_id, payment_installment_id, allocated_amount_mnt, allocated_at, created_at, is_test, test_run_id)
    VALUES (?, ?, ?, 100000, ?, ?, 1, 'promotion-test');`,
  [`${refundedReinstatement.id}-payment`, `${refundedReinstatement.id}-request`, now, now, `${refundedReinstatement.id}-payment-key`, now, now,
    `${refundedReinstatement.id}-allocation`, `${refundedReinstatement.id}-payment`, `${refundedReinstatement.id}-initial`, now, now]);
  await promotePaidDraftChild(env(database), actor, refundedReinstatement.childId);
  await cancelRegistration(env(database), actor, { registrationDraftChildId: refundedReinstatement.childId, reason: "guardian_request" });
  database.query(`UPDATE payment_credit SET status = 'refunded', refunded_at = ? WHERE received_payment_id = ?`, [now, `${refundedReinstatement.id}-payment`]);
  await assert.rejects(() => reinstateRegistration(env(database), actor, { registrationDraftChildId: refundedReinstatement.childId }), RegistrationCancellationError, "a completed refund blocks reinstatement");

  const fullCancellation = seedDraft(database, "cancel-full", { classId: "class-cancel", email: "cancel-full@example.test" });
  await promotePaidDraftChild(env(database), actor, fullCancellation.childId);
  await cancelRegistration(env(database), actor, { registrationDraftChildId: fullCancellation.childId, reason: "guardian_request" });
  assert.equal(database.query(`SELECT status FROM enrollment WHERE id = ?`, [`${fullCancellation.childId}:enrollment`])[0].status, "cancelled", "fully paid canonical enrollment can be cancelled without deleting history");
  assert.equal(database.query(`SELECT status FROM payment_installment WHERE id = ?`, [`${fullCancellation.id}-initial`])[0].status, "paid", "fully paid installment remains historical rather than being rewritten as refunded");
  await assert.rejects(() => cancelRegistration(env(database), { ...actor, roles: ["accountant"], capabilities: ["payment.view"] }, { registrationDraftChildId: fullCancellation.childId, reason: "guardian_request" }), RegistrationCancellationError, "accountant cannot cancel registrations");

  const waitOccupied = seedDraft(database, "cancel-wait-occupied", { classId: "class-wait", email: "cancel-wait-occupied@example.test" });
  await promotePaidDraftChild(env(database), actor, waitOccupied.childId);
  const waiter = seedDraft(database, "cancel-waiter", { classId: "class-wait", email: "cancel-waiter@example.test" });
  database.query(`UPDATE registration_capacity_hold SET status = 'released', released_at = ? WHERE registration_draft_child_id = ?;
    UPDATE registration_draft_child SET selected_class_session_id = NULL, preferred_waitlist_class_session_id = 'class-wait', status = 'waitlisted' WHERE id = ?;
    INSERT INTO registration_draft_waitlist_entry (id, registration_draft_child_id, class_session_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('cancel-waiter-entry', ?, 'class-wait', 'active', 1, 'promotion-test', '2026-08-01T00:00:00.000Z', ?);`, [now, waiter.childId, waiter.childId, waiter.childId, now]);
  await cancelRegistration(env(database), actor, { registrationDraftChildId: waitOccupied.childId, reason: "guardian_request" });
  assert.equal(count(database, "waitlist_seat_offer", "class_session_id = 'class-wait' AND status = 'active'"), 1, "cancellation delegates one released seat to the FIFO offer allocator");
  const waitProjection = (await getClassCapacityProjections(database, "staging", new Date(now), ["class-wait"]))[0];
  assert.equal(waitProjection.confirmedCount, 0);
  assert.equal(waitProjection.offeredWaitlistCount, 1);
  assert.equal(waitProjection.freeSeats, 0, "the replacement offer consumes the same released seat without overbooking");

  await assert.rejects(() => promotePaidDraftChild(env(database), { ...actor, roles: ["accountant"], capabilities: ["payment.view"] }, first.childId), CanonicalPromotionError, "accountant cannot promote identity or enrollment");
  console.log("ok canonical enrollment promotion identity, capacity, and waitlist tests");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
}
