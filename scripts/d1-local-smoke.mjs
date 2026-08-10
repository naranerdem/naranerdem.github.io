import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const database = "DB";
const envName = "staging";
const persistDir = mkdtempSync(path.join(tmpdir(), "naranerdem-d1-smoke-"));

function wrangler(args, options = {}) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["wrangler", "d1", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });

  const label = `wrangler d1 ${args.join(" ")}`;
  if (options.expectFailure) {
    if (result.status === 0) {
      throw new Error(`Expected failure but command passed: ${label}\n${result.stdout}`);
    }
    console.log(`ok expected failure: ${options.label}`);
    return result;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${label}\n${result.stdout}\n${result.stderr}`);
  }

  if (options.label) {
    console.log(`ok ${options.label}`);
  }
  return result;
}

function execute(sql, options = {}) {
  return wrangler(
    [
      "execute",
      database,
      "--env",
      envName,
      "--local",
      "--persist-to",
      persistDir,
      "--command",
      sql,
    ],
    options,
  );
}

const now = "2026-08-10T00:00:00Z";
const testRunId = "local-d1-smoke";

try {
  wrangler(
    [
      "migrations",
      "apply",
      database,
      "--env",
      envName,
      "--local",
      "--persist-to",
      persistDir,
    ],
    { label: "migrations applied locally" },
  );

  execute(
    `
    PRAGMA foreign_keys = ON;

    INSERT INTO guardian_account (
      id, full_name, primary_phone, primary_phone_normalized, secondary_phone,
      secondary_phone_normalized, email, email_normalized, facebook_name,
      home_address, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'guardian-local-1', 'Local Test Guardian', '+976 9000 0001', '97690000001',
      '+976 9000 0002', '97690000002', 'fake-parent@example.com',
      'fake-parent@example.com', 'Fake Parent FB', 'Test district only',
      'active', 1, '${testRunId}', '${now}', '${now}'
    );

    INSERT INTO student (
      id, surname, given_name, gender, date_of_birth, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES
      ('student-local-1', 'Test', 'ChildOne', 'female', '2015-05-01', 'active', 1, '${testRunId}', '${now}', '${now}'),
      ('student-local-2', 'Test', 'ChildTwo', 'male', '2016-06-02', 'active', 1, '${testRunId}', '${now}', '${now}');

    INSERT INTO guardian_student_relationship (
      id, guardian_id, student_id, relationship_label, is_authorized_to_register,
      status, is_test, test_run_id, created_at, updated_at
    ) VALUES
      ('rel-local-1', 'guardian-local-1', 'student-local-1', 'parent', 1, 'active', 1, '${testRunId}', '${now}', '${now}'),
      ('rel-local-2', 'guardian-local-1', 'student-local-2', 'parent', 1, 'active', 1, '${testRunId}', '${now}', '${now}');

    INSERT INTO family_group (
      id, status, source, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'family-local-1', 'active', 'test_fixture', 1, '${testRunId}', '${now}', '${now}'
    );

    INSERT INTO family_group_member (
      id, family_group_id, student_id, guardian_id, relationship_basis,
      status, is_test, test_run_id, created_at, updated_at
    ) VALUES
      ('family-member-local-1', 'family-local-1', 'student-local-1', 'guardian-local-1', 'test_fixture', 'active', 1, '${testRunId}', '${now}', '${now}'),
      ('family-member-local-2', 'family-local-1', 'student-local-2', 'guardian-local-1', 'test_fixture', 'active', 1, '${testRunId}', '${now}', '${now}');

    INSERT INTO academic_year (
      id, public_label, registration_status, starts_on, ends_on,
      is_current, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'year-local-1', 'Local Smoke Year', 'open', '2026-09-01', '2027-06-01',
      1, 1, '${testRunId}', '${now}', '${now}'
    );

    INSERT INTO class_session (
      id, academic_year_id, stage_code, display_label, weekday, start_time,
      end_time, capacity, status, is_test_only, is_test, test_run_id,
      created_at, updated_at
    ) VALUES
      ('class-local-1', 'year-local-1', 'stage_1', 'Stage 1 Saturday AM', 'saturday', '10:00', '11:20', 10, 'available', 1, 1, '${testRunId}', '${now}', '${now}'),
      ('class-local-2', 'year-local-1', 'stage_1', 'Stage 1 Saturday PM', 'saturday', '14:00', '15:20', 10, 'available', 1, 1, '${testRunId}', '${now}', '${now}'),
      ('class-local-3', 'year-local-1', 'stage_2', 'Stage 2 Sunday AM', 'sunday', '10:00', '11:20', 10, 'available', 1, 1, '${testRunId}', '${now}', '${now}');

    INSERT INTO pre_registration (
      id, guardian_id, academic_year_id, family_group_id, status,
      submitted_at, hard_delete_allowed, is_test, test_run_id,
      created_at, updated_at
    ) VALUES (
      'prereg-local-1', 'guardian-local-1', 'year-local-1', 'family-local-1',
      'submitted', '${now}', 1, 1, '${testRunId}', '${now}', '${now}'
    );

    INSERT INTO application_child (
      id, pre_registration_id, student_id, current_school, current_grade,
      returning_status, previous_stage_code, referral_code_input,
      selected_payment_plan_code, selected_class_session_id, status, is_test, test_run_id,
      created_at, updated_at
    ) VALUES
      ('app-child-local-1', 'prereg-local-1', 'student-local-1', 'Fake School', 5, 'new', NULL, 'REF-FAKE', 'full_year', 'class-local-1', 'hold_created', 1, '${testRunId}', '${now}', '${now}'),
      ('app-child-local-2', 'prereg-local-1', 'student-local-2', 'Fake School', 4, 'new', NULL, NULL, 'two_part', 'class-local-2', 'submitted', 1, '${testRunId}', '${now}', '${now}');

    INSERT INTO enrollment (
      id, application_child_id, student_id, academic_year_id, class_session_id,
      status, initial_hold_created_at, original_hold_deadline_at,
      effective_hold_deadline_at, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'enrollment-local-1', 'app-child-local-1', 'student-local-1', 'year-local-1',
      'class-local-1', 'awaiting_initial_payment', '${now}', '2026-08-11T00:00:00Z',
      '2026-08-11T00:00:00Z', 1, '${testRunId}', '${now}', '${now}'
    );

    INSERT INTO waitlist_entry (
      id, application_child_id, class_session_id,
      status, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'waitlist-local-1', 'app-child-local-2', 'class-local-2',
      'active', 1, '${testRunId}', '${now}', '${now}'
    );

    INSERT INTO referral (
      id, referral_code, referring_enrollment_id, referring_student_id,
      referred_application_child_id, status, is_test, test_run_id,
      created_at, updated_at
    ) VALUES (
      'referral-local-1', 'REF-FAKE', 'enrollment-local-1', 'student-local-1',
      'app-child-local-2', 'pending', 1, '${testRunId}', '${now}', '${now}'
    );

    INSERT INTO outbound_email (
      id, event_type, template_key, guardian_id, pre_registration_id,
      enrollment_id, intended_to_email, actual_delivery_email, delivery_mode,
      status, attempt_count, queued_at, context_json, is_test, test_run_id,
      created_at, updated_at
    ) VALUES (
      'email-local-1', 'pre_registration_received', 'pre_registration_received_v1',
      'guardian-local-1', 'prereg-local-1', 'enrollment-local-1',
      'fake-parent@example.com', 'gantimur-controlled-test-address@example.com',
      'staging_override', 'queued', 0, '${now}', '{"child_count":2}',
      1, '${testRunId}', '${now}', '${now}'
    );
    `,
    { label: "sample guardian, children, selected classes, hold, waitlist, referral, email inserted" },
  );

  execute(
    `
    PRAGMA foreign_keys = ON;
    INSERT INTO application_child (
      id, pre_registration_id, student_id, current_grade, returning_status,
      status, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'app-child-missing-parent', 'missing-prereg', 'student-local-1', 5,
      'new', 'submitted', 1, '${testRunId}', '${now}', '${now}'
    );
    `,
    { expectFailure: true, label: "foreign key rejects missing pre-registration" },
  );

  execute(
    `
    UPDATE application_child
    SET selected_class_session_id = 'missing-class'
    WHERE id = 'app-child-local-2';
    `,
    { expectFailure: true, label: "selected class foreign key rejects missing class session" },
  );

  execute(
    `
    INSERT INTO waitlist_entry (
      id, application_child_id, class_session_id, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'waitlist-duplicate-child', 'app-child-local-2', 'class-local-3', 'active',
      1, '${testRunId}', '${now}', '${now}'
    );
    `,
    { expectFailure: true, label: "waitlist allows only one queue entry per application child" },
  );

  execute(
    `
    PRAGMA foreign_keys = ON;
    INSERT INTO audit_event (
      id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at
    ) VALUES (
      'audit-local-delete-1', '${now}', 'admin', 'local-smoke-admin',
      'hard_delete_test_pre_registration', 'pre_registration', 'prereg-local-1',
      '{"reason":"local smoke cleanup"}', 'local', 1, '${testRunId}', '${now}'
    );

    DELETE FROM pre_registration WHERE id = 'prereg-local-1';

    DROP TABLE IF EXISTS smoke_assertion;
    CREATE TABLE smoke_assertion (ok INTEGER NOT NULL CHECK (ok));
    INSERT INTO smoke_assertion SELECT CASE WHEN (SELECT COUNT(*) FROM application_child WHERE pre_registration_id = 'prereg-local-1') = 0 THEN 1 ELSE 0 END;
    INSERT INTO smoke_assertion SELECT CASE WHEN (SELECT COUNT(*) FROM enrollment WHERE id = 'enrollment-local-1') = 0 THEN 1 ELSE 0 END;
    INSERT INTO smoke_assertion SELECT CASE WHEN (SELECT COUNT(*) FROM waitlist_entry WHERE id = 'waitlist-local-1') = 0 THEN 1 ELSE 0 END;
    INSERT INTO smoke_assertion SELECT CASE WHEN (SELECT COUNT(*) FROM referral WHERE id = 'referral-local-1') = 0 THEN 1 ELSE 0 END;
    INSERT INTO smoke_assertion SELECT CASE WHEN (SELECT COUNT(*) FROM guardian_account WHERE id = 'guardian-local-1') = 1 THEN 1 ELSE 0 END;
    INSERT INTO smoke_assertion SELECT CASE WHEN (SELECT COUNT(*) FROM student WHERE id IN ('student-local-1', 'student-local-2')) = 2 THEN 1 ELSE 0 END;
    INSERT INTO smoke_assertion SELECT CASE WHEN (SELECT COUNT(*) FROM audit_event WHERE id = 'audit-local-delete-1' AND metadata_json NOT LIKE '%Local Test Guardian%' AND metadata_json NOT LIKE '%ChildOne%') = 1 THEN 1 ELSE 0 END;
    INSERT INTO smoke_assertion SELECT CASE WHEN (SELECT COUNT(*) FROM outbound_email WHERE id = 'email-local-1' AND intended_to_email = 'fake-parent@example.com' AND actual_delivery_email = 'gantimur-controlled-test-address@example.com' AND pre_registration_id IS NULL AND enrollment_id IS NULL) = 1 THEN 1 ELSE 0 END;
    SELECT 'local_d1_smoke_passed' AS result;
    DROP TABLE smoke_assertion;
    `,
    { label: "cascade, shared-row retention, audit tombstone, email override semantics verified" },
  );

  console.log(`ok local D1 smoke test used temporary state: ${persistDir}`);
} finally {
  rmSync(persistDir, { recursive: true, force: true });
}
