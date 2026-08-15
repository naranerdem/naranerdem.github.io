import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-canonical-promotion-"));
const databasePath = path.join(tempDir, "promotion.sqlite3");
const bundlePath = path.join(tempDir, "canonical-promotion.mjs");

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
  const database = new SqliteD1();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year', 'Тест жил', 'open', 1, 1, 'promotion-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('class-1', 'year', 'stage_1', '1-р шат', 'Бямба', '10:00', '11:20', 20, 'available', 1, 1, 'promotion-test', '${now}', '${now}');`);

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
