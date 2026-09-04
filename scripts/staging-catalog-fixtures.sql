-- Deliberately fake, non-PII records for the staging catalog API only.
-- This file is idempotent and must never be applied to production.

-- Run the explicit operational-default import first. The fake classes below
-- deliberately use its real 2026–27 calendar guidance.

-- Keep the fixture aggregate internally test-provenance consistent. It may
-- coexist with the non-test operational-default planning shell, but must not
-- borrow that shell for public-registration source validation.
INSERT OR IGNORE INTO academic_year (
  id, public_label, registration_status, starts_on, ends_on, is_current,
  is_test, test_run_id, created_at, updated_at
) VALUES (
  'staging-catalog-fixture-year-2026-27',
  'Staging catalog fixture · 2026–2027',
  'draft', '2026-09-01', '2027-06-01', 0,
  1, 'staging-catalog-fixture',
  '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
);

INSERT OR IGNORE INTO academic_year_stage_setting (
  id, academic_year_id, stage_code, facebook_group_url, is_test, test_run_id,
  created_at, updated_at
) VALUES
  ('staging-fixture-stage-setting-1', 'operational-default-year-2026-27', 'stage_1',
    'https://example.invalid/naran-erdem/stage-1', 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('staging-fixture-stage-setting-2', 'operational-default-year-2026-27', 'stage_2',
    'https://example.invalid/naran-erdem/stage-2', 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('staging-fixture-stage-setting-3', 'operational-default-year-2026-27', 'stage_3',
    'https://example.invalid/naran-erdem/stage-3', 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z');

INSERT OR IGNORE INTO activity_offering (
  id, kind, title, academic_year_id, stage_code, starts_on, ends_on,
  curriculum_program_id, use_academic_year_breaks, charge_mode,
  facebook_group_url, status, is_test, test_run_id, created_at, updated_at
) VALUES
  ('annual-offering-operational-default-year-2026-27-stage_1', 'annual_course',
    'Туршилтын 2026–2027 хичээлийн жил · 1-р шат', 'operational-default-year-2026-27', 'stage_1',
    '2026-09-01', '2027-06-01', NULL, 1, 'paid',
    'https://example.invalid/naran-erdem/stage-1', 'active', 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('annual-offering-operational-default-year-2026-27-stage_2', 'annual_course',
    'Туршилтын 2026–2027 хичээлийн жил · 2-р шат', 'operational-default-year-2026-27', 'stage_2',
    '2026-09-01', '2027-06-01', NULL, 1, 'paid',
    'https://example.invalid/naran-erdem/stage-2', 'active', 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('annual-offering-operational-default-year-2026-27-stage_3', 'annual_course',
    'Туршилтын 2026–2027 хичээлийн жил · 3-р шат', 'operational-default-year-2026-27', 'stage_3',
    '2026-09-01', '2027-06-01', NULL, 1, 'paid',
    'https://example.invalid/naran-erdem/stage-3', 'active', 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z');

-- The catalog only exposes Offerings included in an active registration
-- window. Keep this deliberately test-only window current for the staging
-- parent-access rehearsal; it is never applied to production.
INSERT OR IGNORE INTO registration_window (
  id, name, starts_on, ends_on, is_test, test_run_id, created_at, updated_at
) VALUES (
  'staging-catalog-fixture-window-2026-09',
  'Staging catalog fixture · 2026-09',
  '2026-09-03',
  '2026-09-28',
  1,
  'staging-catalog-fixture',
  '2026-08-10T00:00:00Z',
  '2026-08-10T00:00:00Z'
);

INSERT OR IGNORE INTO registration_window_offering (
  registration_window_id, activity_offering_id, created_at
) VALUES
  ('staging-catalog-fixture-window-2026-09', 'annual-offering-operational-default-year-2026-27-stage_1', '2026-08-10T00:00:00Z'),
  ('staging-catalog-fixture-window-2026-09', 'annual-offering-operational-default-year-2026-27-stage_2', '2026-08-10T00:00:00Z'),
  ('staging-catalog-fixture-window-2026-09', 'annual-offering-operational-default-year-2026-27-stage_3', '2026-08-10T00:00:00Z');

INSERT OR IGNORE INTO class_session (
  id, academic_year_id, stage_code, display_label, weekday, start_time,
  end_time, capacity, status, is_test_only, is_test, test_run_id,
  created_at, updated_at, activity_offering_id
) VALUES
  (
    'staging-fixture-stage-1-saturday', 'operational-default-year-2026-27', 'stage_1',
    'Туршилтын 1-р шат, Бямба 10:00', 'Бямба', '10:00', '11:20', 10,
    'available', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z',
    'annual-offering-operational-default-year-2026-27-stage_1'
  ),
  (
    'staging-fixture-stage-1-afternoon', 'operational-default-year-2026-27', 'stage_1',
    'Туршилтын 1-р шат, Бямба 14:00', 'Бямба', '14:00', '15:20', 10,
    'full', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z',
    'annual-offering-operational-default-year-2026-27-stage_1'
  ),
  (
    'staging-fixture-stage-2-sunday', 'operational-default-year-2026-27', 'stage_2',
    'Туршилтын 2-р шат, Ням 10:00', 'Ням', '10:00', '11:20', 10,
    'available', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z',
    'annual-offering-operational-default-year-2026-27-stage_2'
  ),
  (
    'staging-fixture-stage-2-tuesday', 'operational-default-year-2026-27', 'stage_2',
    'Туршилтын 2-р шат, Мягмар 16:00', 'Мягмар', '16:00', '17:20', 8,
    'available', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z',
    'annual-offering-operational-default-year-2026-27-stage_2'
  ),
  (
    'staging-fixture-stage-3-sunday', 'operational-default-year-2026-27', 'stage_3',
    'Туршилтын 3-р шат, Ням 13:00', 'Ням', '13:00', '15:00', 10,
    'full', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z',
    'annual-offering-operational-default-year-2026-27-stage_3'
  ),
  (
    'staging-fixture-stage-3-tuesday', 'operational-default-year-2026-27', 'stage_3',
    'Туршилтын 3-р шат, Мягмар 18:00', 'Мягмар', '18:00', '19:20', 6,
    'available', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z',
    'annual-offering-operational-default-year-2026-27-stage_3'
  );

INSERT OR IGNORE INTO class_meeting_rule (
  class_session_id, recurrence_kind, first_date, last_date, weekly_weekday,
  start_time, end_time, created_at, updated_at
) VALUES
  ('staging-fixture-stage-1-saturday', 'weekly', '2026-09-05', NULL, 'Бямба', '10:00', '11:20', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('staging-fixture-stage-1-afternoon', 'weekly', '2026-09-05', NULL, 'Бямба', '14:00', '15:20', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('staging-fixture-stage-2-sunday', 'weekly', '2026-09-06', NULL, 'Ням', '10:00', '11:20', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('staging-fixture-stage-2-tuesday', 'weekly', '2026-09-08', NULL, 'Мягмар', '16:00', '17:20', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('staging-fixture-stage-3-sunday', 'weekly', '2026-09-06', NULL, 'Ням', '13:00', '15:00', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
  ('staging-fixture-stage-3-tuesday', 'weekly', '2026-09-08', NULL, 'Мягмар', '18:00', '19:20', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z');

INSERT OR IGNORE INTO guardian_account (
  id, full_name, primary_phone, primary_phone_normalized, email, email_normalized,
  home_address, status, is_test, test_run_id, created_at, updated_at
) VALUES (
  'staging-fixture-guardian', 'Staging Catalog Fixture', '+976 9000 0099',
  '97690000099', 'staging-catalog-fixture@example.invalid',
  'staging-catalog-fixture@example.invalid', 'Staging fixture only', 'active', 1,
  'staging-catalog-fixture', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
);

WITH RECURSIVE fixture_number(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM fixture_number WHERE n < 33
)
INSERT OR IGNORE INTO student (
  id, surname, given_name, gender, date_of_birth, status,
  is_test, test_run_id, created_at, updated_at
)
SELECT
  'staging-fixture-student-' || n, 'Fixture', 'Child ' || n, 'not_specified',
  '2015-01-01', 'active', 1, 'staging-catalog-fixture',
  '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
FROM fixture_number;

WITH RECURSIVE fixture_number(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM fixture_number WHERE n < 33
)
INSERT OR IGNORE INTO pre_registration (
  id, guardian_id, academic_year_id, status, is_test, test_run_id,
  created_at, updated_at
)
SELECT
  'staging-fixture-prereg-' || n, 'staging-fixture-guardian',
  'staging-catalog-fixture-year-2026-27', 'submitted', 1, 'staging-catalog-fixture',
  '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
FROM fixture_number;

WITH RECURSIVE fixture_number(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM fixture_number WHERE n < 33
)
INSERT OR IGNORE INTO application_child (
  id, pre_registration_id, student_id, current_grade, returning_status,
  selected_payment_plan_code, selected_class_session_id, status,
  is_test, test_run_id, created_at, updated_at
)
SELECT
  'staging-fixture-application-child-' || n,
  'staging-fixture-prereg-' || n,
  'staging-fixture-student-' || n,
  5,
  'new',
  'full-year',
  CASE
    WHEN n <= 4 THEN 'staging-fixture-stage-1-saturday'
    WHEN n <= 13 THEN 'staging-fixture-stage-2-sunday'
    WHEN n <= 23 THEN 'staging-fixture-stage-3-sunday'
    ELSE 'staging-fixture-stage-1-afternoon'
  END,
  CASE WHEN n IN (4, 13, 32, 33) THEN 'hold_created' ELSE 'enrolled' END,
  1,
  'staging-catalog-fixture',
  '2026-08-10T00:00:00Z',
  '2026-08-10T00:00:00Z'
FROM fixture_number;

WITH RECURSIVE fixture_number(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM fixture_number WHERE n < 33
)
INSERT OR IGNORE INTO enrollment (
  id, application_child_id, student_id, academic_year_id, class_session_id,
  status, initial_hold_created_at, original_hold_deadline_at,
  effective_hold_deadline_at, confirmed_at, is_test, test_run_id,
  created_at, updated_at
)
SELECT
  'staging-fixture-enrollment-' || n,
  'staging-fixture-application-child-' || n,
  'staging-fixture-student-' || n,
  'staging-catalog-fixture-year-2026-27',
  CASE
    WHEN n <= 4 THEN 'staging-fixture-stage-1-saturday'
    WHEN n <= 13 THEN 'staging-fixture-stage-2-sunday'
    WHEN n <= 23 THEN 'staging-fixture-stage-3-sunday'
    ELSE 'staging-fixture-stage-1-afternoon'
  END,
  CASE WHEN n IN (4, 13, 32, 33) THEN 'awaiting_initial_payment' ELSE 'confirmed' END,
  CASE WHEN n IN (4, 13, 32, 33) THEN '2026-08-10T00:00:00Z' ELSE NULL END,
  CASE WHEN n IN (4, 13, 32, 33) THEN '2099-01-02T00:00:00Z' ELSE NULL END,
  CASE WHEN n IN (4, 13, 32, 33) THEN '2099-01-02T00:00:00Z' ELSE NULL END,
  CASE WHEN n IN (4, 13, 32, 33) THEN NULL ELSE '2026-08-10T00:00:00Z' END,
  1,
  'staging-catalog-fixture',
  '2026-08-10T00:00:00Z',
  '2026-08-10T00:00:00Z'
FROM fixture_number;

-- The original fixture aggregate has durable synthetic history and cannot be
-- retargeted to a different academic-year identity. Keep it historical, and
-- provide a fresh, internally consistent aggregate for live staging rehearsal.
UPDATE registration_window
SET ends_on = '2026-09-03', updated_at = '2026-09-04T00:00:00Z'
WHERE id = 'staging-catalog-fixture-window-2026-09'
  AND is_test = 1 AND test_run_id = 'staging-catalog-fixture';

INSERT OR IGNORE INTO academic_year (
  id, public_label, registration_status, starts_on, ends_on, is_current,
  is_test, test_run_id, created_at, updated_at
) VALUES (
  'staging-registration-v2-year-2026-27',
  'Staging rehearsal · 2026–2027',
  'draft', '2026-09-01', '2027-06-01', 0,
  1, 'staging-registration-v2',
  '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'
);

INSERT OR IGNORE INTO activity_offering (
  id, kind, title, academic_year_id, stage_code, starts_on, ends_on,
  curriculum_program_id, use_academic_year_breaks, charge_mode,
  facebook_group_url, status, is_test, test_run_id, created_at, updated_at
) VALUES
  ('staging-registration-v2-offering-stage-1', 'annual_course',
    'Staging rehearsal · 1-р шат', 'staging-registration-v2-year-2026-27', 'stage_1',
    '2026-09-01', '2027-06-01', NULL, 1, 'paid', NULL, 'active', 1, 'staging-registration-v2',
    '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
  ('staging-registration-v2-offering-stage-2', 'annual_course',
    'Staging rehearsal · 2-р шат', 'staging-registration-v2-year-2026-27', 'stage_2',
    '2026-09-01', '2027-06-01', NULL, 1, 'paid', NULL, 'active', 1, 'staging-registration-v2',
    '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
  ('staging-registration-v2-offering-stage-3', 'annual_course',
    'Staging rehearsal · 3-р шат', 'staging-registration-v2-year-2026-27', 'stage_3',
    '2026-09-01', '2027-06-01', NULL, 1, 'paid', NULL, 'active', 1, 'staging-registration-v2',
    '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');

INSERT OR IGNORE INTO offering_course_pricing (
  activity_offering_id, one_time_amount_mnt, two_installment_enabled,
  first_installment_amount_mnt, second_installment_amount_mnt,
  second_installment_due_on, created_at, updated_at
) VALUES
  ('staging-registration-v2-offering-stage-1', 1000000, 1, 550000, 550000, '2027-01-15', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
  ('staging-registration-v2-offering-stage-2', 1000000, 1, 550000, 550000, '2027-01-15', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
  ('staging-registration-v2-offering-stage-3', 1200000, 1, 650000, 650000, '2027-01-15', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');

INSERT OR IGNORE INTO class_session (
  id, academic_year_id, stage_code, display_label, weekday, start_time,
  end_time, capacity, status, is_test_only, is_test, test_run_id,
  created_at, updated_at, activity_offering_id
) VALUES
  ('staging-registration-v2-stage-1-tuesday', 'staging-registration-v2-year-2026-27', 'stage_1',
    'Staging rehearsal · 1-р шат · Мягмар 09:00', 'Мягмар', '09:00', '10:20', 10, 'available', 1, 1, 'staging-registration-v2',
    '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', 'staging-registration-v2-offering-stage-1'),
  ('staging-registration-v2-stage-2-tuesday', 'staging-registration-v2-year-2026-27', 'stage_2',
    'Staging rehearsal · 2-р шат · Мягмар 16:00', 'Мягмар', '16:00', '17:20', 10, 'available', 1, 1, 'staging-registration-v2',
    '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', 'staging-registration-v2-offering-stage-2'),
  ('staging-registration-v2-stage-3-sunday', 'staging-registration-v2-year-2026-27', 'stage_3',
    'Staging rehearsal · 3-р шат · Ням 14:00', 'Ням', '14:00', '15:20', 10, 'available', 1, 1, 'staging-registration-v2',
    '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', 'staging-registration-v2-offering-stage-3');

INSERT OR IGNORE INTO class_meeting_rule (
  class_session_id, recurrence_kind, first_date, last_date, weekly_weekday,
  start_time, end_time, created_at, updated_at
) VALUES
  ('staging-registration-v2-stage-1-tuesday', 'weekly', '2026-09-08', NULL, 'Мягмар', '09:00', '10:20', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
  ('staging-registration-v2-stage-2-tuesday', 'weekly', '2026-09-08', NULL, 'Мягмар', '16:00', '17:20', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
  ('staging-registration-v2-stage-3-sunday', 'weekly', '2026-09-06', NULL, 'Ням', '14:00', '15:20', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');

INSERT OR IGNORE INTO registration_window (
  id, name, starts_on, ends_on, is_test, test_run_id, created_at, updated_at
) VALUES (
  'staging-registration-v2-window-2026-09',
  'Staging rehearsal · 2026-09',
  '2026-09-03', '2026-09-28', 1, 'staging-registration-v2',
  '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'
);

INSERT OR IGNORE INTO registration_window_offering (
  registration_window_id, activity_offering_id, created_at
) VALUES
  ('staging-registration-v2-window-2026-09', 'staging-registration-v2-offering-stage-1', '2026-09-04T00:00:00Z'),
  ('staging-registration-v2-window-2026-09', 'staging-registration-v2-offering-stage-2', '2026-09-04T00:00:00Z'),
  ('staging-registration-v2-window-2026-09', 'staging-registration-v2-offering-stage-3', '2026-09-04T00:00:00Z');
