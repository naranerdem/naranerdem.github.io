import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.slice(2).join(" ") !== "--confirm") {
  throw new Error("This staging-only fixture setup requires exactly --confirm.");
}

const registrationId = randomUUID();
const scope = `registration:${registrationId}`;
const fixture = `makeup-capacity-${registrationId}`;
const now = new Date().toISOString();
const dateInUlaanbaatar = (offset) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const base = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + offset));
  return base.toISOString().slice(0, 10);
};
const sourceDate = dateInUlaanbaatar(-1);
const targetDate = dateInUlaanbaatar(1);
const confirmedAt = `${dateInUlaanbaatar(-8)}T02:00:00.000Z`;
const dueAt = `${dateInUlaanbaatar(14)}T00:00:00.000Z`;
const ids = Object.fromEntries([
  "year", "family", "program", "lesson", "offering", "sourceClass", "targetClass",
  "sourceCalendar", "targetCalendar", "sourceRevision", "targetRevision", "sourceSlot", "targetSlot",
  "guardian", "student", "preRegistration", "application", "sourceEnrollment",
  "reservationDraft", "reservationChild", "reservationHold", "paymentRequest", "installment",
].map((key) => [key, `${fixture}-${key}`]));
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sqlPath = path.join(mkdtempSync(path.join(tmpdir(), "naranerdem-makeup-capacity-staging-")), "fixture.sql");
const tokenHash = createHash("sha256").update(`${fixture}:reservation`).digest("hex");

const sql = `
PRAGMA foreign_keys = ON;
INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.year)}, ${quote(`MAKEUP CAPACITY ${registrationId}`)}, 'closed', ${quote(dateInUlaanbaatar(-30))}, ${quote(dateInUlaanbaatar(30))}, 0, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.family)}, 'summer_course', ${quote(`MAKEUP CAPACITY ${registrationId}`)}, NULL, 'active', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.program)}, ${quote(ids.family)}, ${quote(ids.year)}, 'stage_1', 1, ${quote(`MAKEUP CAPACITY ${registrationId}`)}, 'summer_course', 'draft', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.lesson)}, ${quote(ids.program)}, 1, 'Нөхөх багтаамжийн туршилт', 'active', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
UPDATE curriculum_program SET status = 'published', published_at = ${quote(now)} WHERE id = ${quote(ids.program)};
UPDATE curriculum_program_family SET current_published_program_id = ${quote(ids.program)} WHERE id = ${quote(ids.family)};
INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.offering)}, 'summer_course', ${quote(`MAKEUP CAPACITY ${registrationId}`)}, ${quote(ids.year)}, 'stage_1', ${quote(sourceDate)}, ${quote(ids.program)}, 0, 'paid', 'active', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test_only, is_test, test_run_id, created_at, updated_at) VALUES
  (${quote(ids.sourceClass)}, ${quote(ids.year)}, 'stage_1', 'Нөхөх эх анги', 'Лхагва', '10:00', '11:20', 10, 'available', ${quote(ids.offering)}, 1, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)}),
  (${quote(ids.targetClass)}, ${quote(ids.year)}, 'stage_1', 'Нөхөх зорилтот анги', 'Баасан', '10:00', '11:20', 1, 'available', ${quote(ids.offering)}, 1, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at) VALUES
  (${quote(ids.sourceClass)}, 'weekly', ${quote(sourceDate)}, 'Лхагва', '10:00', '11:20', ${quote(now)}, ${quote(now)}),
  (${quote(ids.targetClass)}, 'weekly', ${quote(targetDate)}, 'Баасан', '10:00', '11:20', ${quote(now)}, ${quote(now)});
INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES
  (${quote(ids.sourceCalendar)}, ${quote(ids.sourceClass)}, 'Asia/Ulaanbaatar', 'active', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)}),
  (${quote(ids.targetCalendar)}, ${quote(ids.targetClass)}, 'Asia/Ulaanbaatar', 'active', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at) VALUES
  (${quote(ids.sourceRevision)}, ${quote(ids.sourceCalendar)}, ${quote(ids.program)}, 1, 'draft', ${quote(sourceDate)}, 0, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)}),
  (${quote(ids.targetRevision)}, ${quote(ids.targetCalendar)}, ${quote(ids.program)}, 1, 'draft', ${quote(targetDate)}, 0, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
  (${quote(ids.sourceSlot)}, ${quote(ids.sourceRevision)}, ${quote(sourceDate)}, '10:00', '11:20', 'generated', 'scheduled', ${quote(ids.lesson)}, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)}),
  (${quote(ids.targetSlot)}, ${quote(ids.targetRevision)}, ${quote(targetDate)}, '10:00', '11:20', 'generated', 'scheduled', ${quote(ids.lesson)}, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
UPDATE class_calendar_revision SET status = 'published', published_at = ${quote(now)} WHERE id IN (${quote(ids.sourceRevision)}, ${quote(ids.targetRevision)});
INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.guardian)}, ${quote(`MAKEUP ${registrationId.slice(0, 8)} Guardian`)}, '90000000', '90000000', ${quote(`${registrationId}@example.test`)}, ${quote(`${registrationId}@example.test`)}, 'Туршилтын хаяг', 'active', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.student)}, 'MAKEUP', ${quote(registrationId.slice(0, 8))}, 'not_specified', '2015-01-01', 'active', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.preRegistration)}, ${quote(ids.guardian)}, ${quote(ids.year)}, 'completed', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.application)}, ${quote(ids.preRegistration)}, ${quote(ids.student)}, '5', 'new', 'enrolled', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.sourceEnrollment)}, ${quote(ids.application)}, ${quote(ids.student)}, ${quote(ids.year)}, ${quote(ids.sourceClass)}, 'confirmed', ${quote(confirmedAt)}, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.reservationDraft)}, ${quote(tokenHash)}, ${quote(ids.year)}, 'MAKEUP Reservation Guardian', 'parent', '90000001', ${quote(`hold-${registrationId}@example.test`)}, ${quote(`hold-${registrationId}@example.test`)}, 'Туршилтын хаяг', 'single', 'v1', 'v1', 'awaiting_initial_payment', ${quote(dueAt)}, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status, selected_stage_code, selected_class_session_id, status, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.reservationChild)}, ${quote(ids.reservationDraft)}, 0, 'MAKEUP', 'Reservation', 'not_specified', '2015-01-02', '5', 'new', 'stage_1', ${quote(ids.targetClass)}, 'awaiting_initial_payment', 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
  VALUES (${quote(ids.reservationHold)}, ${quote(ids.reservationChild)}, ${quote(ids.targetClass)}, 'initial_payment', 'active', ${quote(dueAt)}, 1, ${quote(scope)}, ${quote(now)}, ${quote(now)});
INSERT INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
  VALUES (${quote(ids.paymentRequest)}, ${quote(ids.reservationDraft)}, ${quote(`MK${registrationId.replaceAll('-', '').slice(0, 12).toUpperCase()}`)}, ${quote(now)}, ${quote(now)}, 1, ${quote(scope)});
INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, status, created_at, updated_at, is_test, test_run_id)
  VALUES (${quote(ids.installment)}, ${quote(ids.paymentRequest)}, ${quote(ids.reservationChild)}, 1, 'initial', 1000, ${quote(dueAt)}, ${quote(dueAt)}, 'pending', ${quote(now)}, ${quote(now)}, 1, ${quote(scope)});
`;

try {
  writeFileSync(sqlPath, sql, "utf8");
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["wrangler", "d1", "execute", "DB", "--env", "staging", "--remote", "--file", sqlPath], { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(JSON.stringify({ scope, fixture, ...ids, sourceDate, targetDate }, null, 2));
} finally {
  rmSync(path.dirname(sqlPath), { recursive: true, force: true });
}
