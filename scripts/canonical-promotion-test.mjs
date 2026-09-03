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
const actor = { staffAccountId: "teacher", displayName: "Тест Багш", roles: ["teacher"], capabilities: ["payment.view", "payment.manage"], sessionId: "test", sessionExpiresAt: now, sessionAbsoluteExpiresAt: now };

function env(DB) {
  return { APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "true", EMAIL_ENABLED: "true", AUTH_EMAIL_ENABLED: "true", STAFF_AUTH_EMAIL_ENABLED: "true", APP_ORIGIN: "https://staging.example.test", EMAIL_FROM: "Наран Эрдэм <burtgel@mail.naranerdem.com>", DB };
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
    VALUES (?, ?, ?, ?, ?, 1, 'promotion-test')`, [`${id}-request`, id, `NE-${id.slice(0, 6).toUpperCase()}`, now, now]);
  database.query(`INSERT INTO payment_installment (
    id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt,
    original_due_at, effective_due_at, status, paid_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, 1, 'initial', 100000, '2026-08-16T04:00:00.000Z', '2026-08-16T04:00:00.000Z', 'paid', ?, 1, 'promotion-test', ?, ?)`,
  [`${id}-initial`, `${id}-request`, `${id}-child`, now, now, now]);
  return { id, childId: `${id}-child`, email: email.toLowerCase() };
}

function markFinalizedApprovedPartial(database, draft, amount = 20000) {
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
  ) VALUES (?, ?, ?, 'finalized', ?, 1, ?, ?, ?, ?, 1, 'promotion-test')`,
  [`${draft.id}-confirmation`, `${draft.id}-payment`, `${draft.id}-request`, now, '2026-09-30T04:00:00.000Z', now, now, now]);
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

try {
  const migrations = readdirSync("migrations").filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().map((name) => readFileSync(path.join("migrations", name), "utf8")).join("\n");
  sqlite(migrations);
  const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");
  const bundled = spawnSync(esbuild, ["src/server/services/canonical-enrollment-promotion.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" });
  if (bundled.status !== 0) throw new Error(bundled.stderr);
  const { promotePaidDraftChild, getPromotionReviewQueue, resolvePromotionIdentity, CanonicalPromotionError } = await import(pathToFileURL(bundlePath).href);
  const capacityBundled = spawnSync(esbuild, ["src/server/services/class-capacity.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${capacityBundlePath}`], { encoding: "utf8" });
  if (capacityBundled.status !== 0) throw new Error(capacityBundled.stderr);
  const { getClassCapacityProjections } = await import(pathToFileURL(capacityBundlePath).href);
  const discountsBundle = spawnSync(esbuild, ["src/server/services/discounts.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${discountBundlePath}`], { encoding: "utf8" });
  if (discountsBundle.status !== 0) throw new Error(discountsBundle.stderr);
  const { getDiscountPolicySetting, updateDiscountPolicySetting, effectiveInstallments, DiscountPolicyError } = await import(pathToFileURL(discountBundlePath).href);
  const database = new SqliteD1();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year', 'Тест жил', 'open', 1, 1, 'promotion-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('class-1', 'year', 'stage_1', '1-р шат', 'Бямба', '10:00', '11:20', 20, 'available', 1, 1, 'promotion-test', '${now}', '${now}');`);

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
  assert.equal((await promotePaidDraftChild(env(database), actor, review.childId)).state, "needs_identity_review");
  assert.equal(count(database, "enrollment", `id = '${review.childId}:enrollment'`), 0, "returning child without an exact linked match is never guessed");
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id = '${review.childId}' AND status = 'active'`), 1, "paid identity-review seat remains protected");

  const elsewhere = seedDraft(database, "different-guardian", { email: "other@example.test", surname: "Бат", givenName: "Сараа", returning: "returning" });
  assert.equal((await promotePaidDraftChild(env(database), actor, elsewhere.childId)).state, "needs_identity_review", "global exact match is never automatic for another verified guardian");
  const reviewQueue = await getPromotionReviewQueue(env(database), actor);
  assert.ok(reviewQueue.items.find((item) => item.childId === elsewhere.childId)?.candidates.some((candidate) => candidate.id === "student-returning"), "staff review sees only strict exact candidates");
  await resolvePromotionIdentity(env(database), actor, elsewhere.childId, { kind: "existing", studentId: "student-returning" });
  assert.equal(count(database, "guardian_student_relationship", "guardian_id = (SELECT canonical_guardian_account_id FROM registration_draft WHERE id = 'different-guardian') AND student_id = 'student-returning' AND status = 'active'"), 1, "explicit staff decision adds an authorized guardian relationship");

  const manualNew = seedDraft(database, "manual-new", { email: existingGuardianEmail, surname: "Шинэ", givenName: "Хүүхэд", returning: "returning" });
  await promotePaidDraftChild(env(database), actor, manualNew.childId);
  await resolvePromotionIdentity(env(database), actor, manualNew.childId, { kind: "new" });
  assert.equal(database.query(`SELECT identity_resolution_status AS status FROM registration_draft_child WHERE id = ?`, [manualNew.childId])[0].status, "promoted");

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

  await assert.rejects(() => promotePaidDraftChild(env(database), { ...actor, roles: ["accountant"], capabilities: ["payment.view"] }, first.childId), CanonicalPromotionError, "accountant cannot promote identity or enrollment");
  console.log("ok canonical enrollment promotion identity, capacity, and waitlist tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
