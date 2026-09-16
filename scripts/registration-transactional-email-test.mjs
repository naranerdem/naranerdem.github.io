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

function seedCanonicalEnrollment(database, draftId, childId, position, givenName) {
  const nowValue = now();
  if (position > 0) {
    database.query(`INSERT INTO registration_draft_child (
      id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status,
      selected_stage_code, selected_class_session_id, status, initial_payment_amount_mnt, payment_plan_code, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'Тест', ?, 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class',
      'awaiting_initial_payment', 1200000, 'single', 1, 'email-test', ?, ?)`, [childId, draftId, position, givenName, nowValue, nowValue]);
    database.query(`INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind,
      amount_mnt, original_due_at, effective_due_at, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'initial', 1200000, '2026-09-03T03:00:00.000Z', '2026-09-03T03:00:00.000Z', 'paid', 1, 'email-test', ?, ?)`,
    [`${childId}-installment`, `${draftId}-request`, childId, nowValue, nowValue]);
  }
  const guardianId = `${draftId}-guardian`;
  const preRegistrationId = `${draftId}-pre-registration`;
  if (position === 0) {
    database.query(`INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      SELECT ?, guardian_full_name, primary_phone, primary_phone, email, normalized_email, home_address, 'active', 1, 'email-test', ?, ?
      FROM registration_draft WHERE id = ?`, [guardianId, nowValue, nowValue, draftId]);
    database.query(`INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, 'year', 'completed', 1, 'email-test', ?, ?)`, [preRegistrationId, guardianId, nowValue, nowValue]);
  }
  database.query(`INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
    SELECT ?, surname, given_name, gender, date_of_birth, 'active', 1, 'email-test', ?, ? FROM registration_draft_child WHERE id = ?;
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, ?, 5, 'new', 'enrolled', 1, 'email-test', ?, ?);
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, ?, 'year', 'class', 'confirmed', ?, 1, 'email-test', ?, ?);
    UPDATE registration_draft_child SET canonical_student_id = ?, canonical_application_child_id = ?, canonical_enrollment_id = ? WHERE id = ?`,
  [`${childId}-student`, nowValue, nowValue, childId, `${childId}-application`, preRegistrationId, `${childId}-student`, nowValue, nowValue,
    `${childId}-enrollment`, `${childId}-application`, `${childId}-student`, nowValue, nowValue, nowValue,
    `${childId}-student`, `${childId}-application`, `${childId}-enrollment`, childId]);
}

try {
  sql(readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort().map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const build = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/email/registration-transactional.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
  const verificationBuild = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/auth/email-verification.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${verificationBundle}`], { encoding: "utf8" });
  if (verificationBuild.status !== 0) throw new Error(verificationBuild.stderr);
  const { sendEnrollmentConfirmationEmail, sendRegistrationReceipt, sendPaymentConfirmedEmail, sendConditionalSeatConfirmationEmail, sendInternalEnrollmentConfirmationNotice, reconcileInternalEnrollmentConfirmationNotices } = await import(pathToFileURL(bundle).href);
  const { startEmailVerification, EmailVerificationError } = await import(pathToFileURL(verificationBundle).href);
  const database = new Database();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at) VALUES ('year', 'Тест', 'open', 1, 1, 'email-test', ?, ?);
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at) VALUES ('offering', 'annual_course', 'Тест сургалт', 'year', 'stage_1', 1, 'paid', 'active', 1, 'email-test', ?, ?);
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at) VALUES ('class', 'offering', 'year', 'stage_1', 'Тест анги', 'Мягмар', '09:00', '10:20', 10, 'available', 1, 1, 'email-test', ?, ?);
    UPDATE payment_collection_settings SET bank_name = 'Тест банк', account_holder_name = 'Тест эзэмшигч', account_number = '0000000000', updated_at = ? WHERE singleton = 1;`,
  [now(), now(), now(), now(), now(), now(), now()]);
  seedDraft(database, "receipt");
  database.query(`INSERT INTO received_payment (
    id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status,
    confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id
  ) VALUES ('receipt-payment', 'receipt-request', 1200000, ?, 'staff_manual_bank', 'confirmed', ?, 'receipt-payment-key', ?, ?, 1, 'email-test');
  INSERT INTO payment_allocation (id, received_payment_id, payment_installment_id, allocated_amount_mnt, allocated_at, created_at, is_test, test_run_id)
    VALUES ('receipt-allocation', 'receipt-payment', 'receipt-installment', 1200000, ?, ?, 1, 'email-test');
  INSERT INTO payment_confirmation (id, received_payment_id, payment_request_id, status, finalize_after, seat_confirmation_approved, finalized_at, created_at, updated_at, is_test, test_run_id)
    VALUES ('receipt-confirmation', 'receipt-payment', 'receipt-request', 'finalized', ?, 0, ?, ?, ?, 1, 'email-test');`,
  [now(), now(), now(), now(), now(), now(), now(), now(), now(), now()]);
  database.query(`INSERT INTO discount_award (
    id, registration_draft_child_id, award_type, basis_points, base_amount_mnt, award_amount_mnt,
    status, reason, awarded_at, is_test, test_run_id, created_at, updated_at
  ) VALUES ('receipt-discount', 'receipt-child', 'family_multi_child', 1000, 1200000, 120000,
    'active', 'test', ?, 1, 'email-test', ?, ?)`, [now(), now(), now()]);
  const messages = [];
  const provider = { async send(message, options) { messages.push({ message, options }); return { providerMessageId: `provider-${messages.length}` }; } };
  assert.equal(await sendRegistrationReceipt(env(database), "receipt", provider), true, "EMAIL_ENABLED sends an ordinary registration receipt even when auth email is disabled");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.to, "safe@example.test", "staging delivery remains safely overridden");
  assert.deepEqual(messages[0].message.bcc, ["archive@example.test"], "the ordinary receipt is archive-BCC safe");
  assert.match(messages[0].message.text, /Таны хүүхдийн мэдээлэл бүртгэгдлээ\./);
  assert.match(messages[0].message.text, /Төлбөр хийгдсэнээр суудал баталгаажна\./);
  assert.match(messages[0].message.html, /Төлбөр хийгдсэнээр суудал баталгаажна\./);
  assert.doesNotMatch(messages[0].message.text, /эхний төлбөр/i, "a single-payment receipt is plan-neutral");
  assert.match(messages[0].message.text, /Сургалтын төлбөр: 1,200,000 ₮/);
  assert.match(messages[0].message.text, /Хөнгөлөлт: 120,000 ₮/);
  assert.match(messages[0].message.text, /Төлөх нийт дүн: 1,080,000 ₮/);
  assert.match(messages[0].message.text, /Одоо төлөх: 1,080,000 ₮/);
  assert.doesNotMatch(messages[0].message.text, /verify-email|token=/i, "receipt contains no capability link");
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'receipt:registration-receipt'")[0].status, "sent");
  assert.equal(database.query("SELECT email_sensitivity AS sensitivity FROM outbound_email WHERE id = 'receipt:registration-receipt'")[0].sensitivity, "archive_bcc_safe");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM email_verification_challenge")[0].count, 0, "receipt creates no verification challenge");
  await sendRegistrationReceipt(env(database), "receipt", provider);
  assert.equal(messages.length, 1, "receipt retries are idempotent after success");
  assert.equal(await sendPaymentConfirmedEmail(env(database), "receipt", "receipt-confirmation", provider), true, "payment confirmation is also independent of auth email");
  assert.equal(messages.length, 2);
  assert.match(messages[1].message.text, /Таны төлбөрийг хүлээн авч баталгаажууллаа\./);
  assert.match(messages[1].message.text, /Тест Хүүхэд/);
  assert.match(messages[1].message.text, /Анги: Тест анги · Мягмар 09:00–10:20/);
  assert.match(messages[1].message.text, /Хүлээн авсан төлбөр: 1,200,000 ₮/);
  assert.match(messages[1].message.text, /Үлдсэн төлбөр: 0 ₮/);
  assert.match(messages[1].message.text, /Суудал хараахан баталгаажаагүй байна\./);
  assert.doesNotMatch(messages[1].message.text, /эхний төлбөр/i, "payment confirmation is plan-neutral");
  assert.deepEqual(messages[1].message.bcc, ["archive@example.test"], "ordinary payment receipts remain archive-BCC safe");
  assert.equal(database.query("SELECT status FROM outbound_email WHERE event_type = 'registration_initial_payment_confirmed'")[0].status, "sent");
  database.query(`UPDATE email_archive_bcc_setting SET recipients_json = '["admin@example.test"]', teacher_recipients_json = '[]' WHERE singleton = 1`);
  seedDraft(database, "sequential-confirmation", "sequential@example.test");
  seedCanonicalEnrollment(database, "sequential-confirmation", "sequential-confirmation-child", 0, "A");
  seedCanonicalEnrollment(database, "sequential-confirmation", "sequential-confirmation-child-b", 1, "B");
  const originalFetch = globalThis.fetch;
  const enrollmentMessages = [];
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    enrollmentMessages.push(body);
    return new Response(JSON.stringify({ id: `sequential-${enrollmentMessages.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(await sendEnrollmentConfirmationEmail({ ...env(database), APP_ENV: "production" }, "sequential-confirmation", { registrationDraftChildId: "sequential-confirmation-child" }), true,
      "the first confirmed child creates its own parent and internal enrollment notices");
    assert.equal(await sendEnrollmentConfirmationEmail({ ...env(database), APP_ENV: "production" }, "sequential-confirmation", { registrationDraftChildId: "sequential-confirmation-child-b" }), true,
      "the later confirmed child is not suppressed by the first child's registration-scoped history");
    await sendEnrollmentConfirmationEmail({ ...env(database), APP_ENV: "production" }, "sequential-confirmation", { registrationDraftChildId: "sequential-confirmation-child-b" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = 'sequential-confirmation' AND event_type = 'enrollment_confirmed'`)[0].count, 2,
    "each child has one durable parent enrollment-confirmation unit");
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = 'sequential-confirmation' AND event_type = 'internal_enrollment_confirmed'`)[0].count, 2,
    "each child has one durable token-free internal enrollment notice");
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM email_verification_challenge WHERE registration_draft_id = 'sequential-confirmation' AND status = 'pending'`)[0].count, 2,
    "the later child notice preserves the earlier pending parent-access challenge");
  assert.equal(enrollmentMessages.length, 4, "two logical confirmations produce one parent and one internal message each, with replay suppressed");
  assert.ok(enrollmentMessages.some((entry) => entry.text?.includes('Тест Хүүхэд') && !entry.text?.includes('Тест B')),
    "A's parent confirmation names A without asserting B is already confirmed");
  assert.ok(enrollmentMessages.some((entry) => entry.text?.includes('Тест B') && !entry.text?.includes('Тест A')),
    "B's later confirmation names B without replaying or broadening A's event");
  seedDraft(database, "legacy-confirmation", "legacy@example.test");
  seedCanonicalEnrollment(database, "legacy-confirmation", "legacy-confirmation-child", 0, "Өмнөх");
  const legacyMessages = [];
  globalThis.fetch = async (_url, request) => {
    legacyMessages.push(JSON.parse(request.body));
    return new Response(JSON.stringify({ id: `legacy-${legacyMessages.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(await sendEnrollmentConfirmationEmail({ ...env(database), APP_ENV: "production" }, "legacy-confirmation"), true,
      "a released registration-scoped confirmation remains deliverable by the new runtime");
    assert.equal(await sendEnrollmentConfirmationEmail({ ...env(database), APP_ENV: "production" }, "legacy-confirmation", {
      registrationDraftChildId: "legacy-confirmation-child",
    }), true, "a delivered legacy registration event remains the durable confirmation for an already-confirmed child");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email
    WHERE registration_draft_id = 'legacy-confirmation' AND event_type = 'enrollment_confirmed'`)[0].count, 1,
  "deploying child-scoped notifications does not backfill a delivered legacy parent confirmation");
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email
    WHERE registration_draft_id = 'legacy-confirmation' AND event_type = 'internal_enrollment_confirmed'`)[0].count, 1,
  "deploying child-scoped notifications does not backfill a delivered legacy internal notice");
  database.query(`UPDATE outbound_email SET status = 'queued', sent_at = NULL
    WHERE id = 'legacy-confirmation:internal-enrollment-confirmation'`);
  const legacyRetryMessages = [];
  globalThis.fetch = async (_url, request) => {
    legacyRetryMessages.push(JSON.parse(request.body));
    return new Response(JSON.stringify({ id: `legacy-retry-${legacyRetryMessages.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(await reconcileInternalEnrollmentConfirmationNotices({ ...env(database), APP_ENV: "production" }, new Date("2099-01-01T00:00:00.000Z")), 1,
      "scheduled recovery retries the existing legacy internal event by its original identity");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email
    WHERE registration_draft_id = 'legacy-confirmation' AND event_type = 'internal_enrollment_confirmed'`)[0].count, 1,
  "legacy internal retries do not create a child-scoped duplicate");
  seedDraft(database, "legacy-later-sibling", "legacy-later@example.test");
  seedCanonicalEnrollment(database, "legacy-later-sibling", "legacy-later-sibling-child", 0, "Эхний");
  const laterMessages = [];
  globalThis.fetch = async (_url, request) => {
    laterMessages.push(JSON.parse(request.body));
    return new Response(JSON.stringify({ id: `later-${laterMessages.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(await sendEnrollmentConfirmationEmail({ ...env(database), APP_ENV: "production" }, "legacy-later-sibling"), true,
      "the released registration-scoped event is retained for the first child");
    seedCanonicalEnrollment(database, "legacy-later-sibling", "legacy-later-sibling-child-b", 1, "Дараах");
    database.query(`UPDATE enrollment SET confirmed_at = '2099-01-01T00:00:00.000Z'
      WHERE id = 'legacy-later-sibling-child-b-enrollment'`);
    assert.equal(await sendEnrollmentConfirmationEmail({ ...env(database), APP_ENV: "production" }, "legacy-later-sibling", {
      registrationDraftChildId: "legacy-later-sibling-child-b",
    }), true, "a sibling confirmed after the legacy event still receives its own child-scoped confirmation");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email
    WHERE registration_draft_id = 'legacy-later-sibling' AND event_type = 'enrollment_confirmed'`)[0].count, 2,
  "legacy compatibility does not suppress a later sibling's independent confirmation");
  seedDraft(database, "conditional-seat");
  database.query(`INSERT INTO conditional_family_discount_quote (
    id, registration_draft_child_id, academic_year_id, relationship_basis, relationship_key,
    basis_points, base_amount_mnt, award_amount_mnt, installment_strategy, state,
    created_at, updated_at, is_test, test_run_id
  ) VALUES ('conditional-seat-quote', 'conditional-seat-child', 'year', 'same_submission', 'conditional-seat-draft',
    1000, 1200000, 120000, 'one_payment', 'quoted_pending', ?, ?, 1, 'email-test')`, [now(), now()]);
  database.query(`UPDATE email_archive_bcc_setting SET recipients_json = '["admin@example.test","overlap@example.test"]',
    teacher_recipients_json = '["teacher@example.test","overlap@example.test"]' WHERE singleton = 1`);
  const conditionalMessages = [];
  const conditionalProvider = { async send(message, options) { conditionalMessages.push({ message, options }); return { providerMessageId: `conditional-${conditionalMessages.length}` }; } };
  assert.equal(await sendConditionalSeatConfirmationEmail({ ...env(database), APP_ENV: "production" }, "conditional-seat-child", "conditional-seat-quote", conditionalProvider), true,
    "conditional seat approval queues truthful parent and capability-free internal notices");
  assert.equal(conditionalMessages.length, 2, "conditional approval delivers one parent and one internal notice");
  assert.match(conditionalMessages[0].message.text, /гэр бүлийн хөнгөлөлтийн нөхцөл шийдэгдээгүй/,
    "the parent notice does not claim full financial settlement");
  assert.doesNotMatch(conditionalMessages[1].message.text, /verify-email|token=|Бүртгэлээ харах/i,
    "the internal conditional notice has no parent capability");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM email_verification_challenge WHERE registration_draft_id = 'conditional-seat'")[0].count, 0,
    "conditional notices issue no parent-access challenge");
  assert.deepEqual(database.query(`SELECT event_type AS eventType, status FROM outbound_email
    WHERE id IN ('conditional-seat-quote:conditional-seat-parent', 'conditional-seat-quote:conditional-seat-internal') ORDER BY id`), [
    { eventType: 'internal_conditional_seat_confirmed', status: 'sent' },
    { eventType: 'conditional_seat_confirmed', status: 'sent' },
  ], "each conditional notice has one durable, replay-safe Outbox identity");
  await sendConditionalSeatConfirmationEmail({ ...env(database), APP_ENV: "production" }, "conditional-seat-child", "conditional-seat-quote", conditionalProvider);
  assert.equal(conditionalMessages.length, 2, "conditional approval replay does not deliver duplicate notices");
  seedDraft(database, "conditional-retry");
  database.query(`INSERT INTO conditional_family_discount_quote (
    id, registration_draft_child_id, academic_year_id, relationship_basis, relationship_key,
    basis_points, base_amount_mnt, award_amount_mnt, installment_strategy, state,
    created_at, updated_at, is_test, test_run_id
  ) VALUES ('conditional-retry-quote', 'conditional-retry-child', 'year', 'same_submission', 'conditional-retry-draft',
    1000, 1200000, 120000, 'one_payment', 'quoted_pending', ?, ?, 1, 'email-test')`, [now(), now()]);
  let conditionalAttempt = 0;
  const internalFailureProvider = { async send() {
    conditionalAttempt += 1;
    if (conditionalAttempt === 2) throw new Error("internal provider unavailable");
    return { providerMessageId: `conditional-retry-${conditionalAttempt}` };
  } };
  await assert.rejects(sendConditionalSeatConfirmationEmail({ ...env(database), APP_ENV: "production" }, "conditional-retry-child", "conditional-retry-quote", internalFailureProvider),
    /Transactional email delivery failed/, "an internal conditional-notice failure remains visible after the parent notice succeeds");
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'conditional-retry-quote:conditional-seat-parent'")[0].status, "sent");
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'conditional-retry-quote:conditional-seat-internal'")[0].status, "failed");
  const recoveredConditionalInternal = [];
  const recoveredConditionalProvider = { async send(message) { recoveredConditionalInternal.push(message); return { providerMessageId: "conditional-retry-recovered" }; } };
  assert.equal(await sendConditionalSeatConfirmationEmail({ ...env(database), APP_ENV: "production" }, "conditional-retry-child", "conditional-retry-quote", recoveredConditionalProvider), true,
    "a replay recovers the durable internal conditional notice without re-sending the parent notice");
  assert.equal(recoveredConditionalInternal.length, 1);
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'conditional-retry-quote:conditional-seat-internal'")[0].status, "sent");
  seedDraft(database, "internal-notice");
  database.query(`UPDATE email_archive_bcc_setting SET recipients_json = '["admin@example.test","overlap@example.test"]',
    teacher_recipients_json = '["teacher@example.test","overlap@example.test"]' WHERE singleton = 1`);
  const internalMessages = [];
  const internalProvider = { async send(message, options) { internalMessages.push({ message, options }); return { providerMessageId: "internal-provider" }; } };
  const internalChildren = [{
    childName: "Тест Хүүхэд", academicYearLabel: "2026-2027", offeringLabel: "1-р шат", stageLabel: "1-р шат", classLabel: "Мягмар 09:00-10:20",
    paidAmountMnt: 1200000, remainingAmountMnt: 0, remainingPaymentDueAt: null, referralCode: null,
  }];
  assert.equal(await sendInternalEnrollmentConfirmationNotice({ ...env(database), APP_ENV: "production" }, "internal-notice", internalChildren, { referrerBasisPoints: 0, referredChildBasisPoints: 0 }, internalProvider), true,
    "a confirmed enrollment can queue one capability-free internal notice");
  assert.equal(internalMessages.length, 1);
  assert.equal(internalMessages[0].message.to, "admin@example.test");
  assert.deepEqual(internalMessages[0].message.bcc, ["overlap@example.test", "teacher@example.test"], "admin and teacher lists receive one deduplicated internal notice");
  assert.doesNotMatch(internalMessages[0].message.text, /verify-email|token=|Бүртгэлээ харах/i, "the internal notice contains no parent capability");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM email_verification_challenge WHERE registration_draft_id = 'internal-notice'")[0].count, 0, "the internal notice issues no challenge");
  await sendInternalEnrollmentConfirmationNotice({ ...env(database), APP_ENV: "production" }, "internal-notice", internalChildren, { referrerBasisPoints: 0, referredChildBasisPoints: 0 }, internalProvider);
  assert.equal(internalMessages.length, 1, "a replay does not create or deliver a duplicate internal notice");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM outbound_email WHERE id = 'internal-notice:internal-enrollment-confirmation'")[0].count, 1, "the final internal confirmation has one durable Outbox identity");
  seedDraft(database, "internal-retry");
  const failedInternalProvider = { async send() { throw new Error("provider unavailable"); } };
  await assert.rejects(
    sendInternalEnrollmentConfirmationNotice({ ...env(database), APP_ENV: "production" }, "internal-retry", internalChildren, { referrerBasisPoints: 0, referredChildBasisPoints: 0 }, failedInternalProvider),
    /Transactional email delivery failed/,
    "a failed internal delivery leaves its durable notice available for reconciliation",
  );
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'internal-retry:internal-enrollment-confirmation'")[0].status, "failed");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM email_verification_challenge WHERE registration_draft_id = 'internal-retry'")[0].count, 0,
    "a failed internal notice still cannot issue a parent-access challenge");
  assert.equal(await sendInternalEnrollmentConfirmationNotice({ ...env(database), APP_ENV: "production" }, "internal-retry", internalChildren, { referrerBasisPoints: 0, referredChildBasisPoints: 0 }, internalProvider), true,
    "the same durable internal notice can be retried without creating another event");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM outbound_email WHERE id = 'internal-retry:internal-enrollment-confirmation'")[0].count, 1);
  assert.equal(database.query("SELECT status FROM outbound_email WHERE id = 'internal-retry:internal-enrollment-confirmation'")[0].status, "sent");
  seedDraft(database, "cancelled");
  database.query("UPDATE registration_draft SET status = 'cancelled' WHERE id = 'cancelled'");
  assert.equal(await sendPaymentConfirmedEmail(env(database), "cancelled", provider), false, "a cancelled registration cannot receive a late confirmation email");
  assert.equal(messages.length, 2, "cancellation does not queue or send a parent confirmation");
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
