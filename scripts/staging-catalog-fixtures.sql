-- Deliberately fake, non-PII records for the staging catalog API only.
-- This file is idempotent and must never be applied to production.

INSERT OR IGNORE INTO academic_year (
  id, public_label, registration_status, starts_on, ends_on,
  is_current, is_test, test_run_id, created_at, updated_at
) VALUES (
  'staging-fixture-2026-27', 'Туршилтын 2026–2027 хичээлийн жил', 'open',
  '2026-09-01', '2027-06-01', 1, 1, 'staging-catalog-fixture',
  '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
);

INSERT OR IGNORE INTO class_session (
  id, academic_year_id, stage_code, display_label, weekday, start_time,
  end_time, capacity, status, is_test_only, is_test, test_run_id,
  created_at, updated_at
) VALUES
  (
    'staging-fixture-stage-1-saturday', 'staging-fixture-2026-27', 'stage_1',
    'Туршилтын 1-р шат, Бямба 10:00', 'Бямба', '10:00', '11:20', 10,
    'available', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
  ),
  (
    'staging-fixture-stage-1-afternoon', 'staging-fixture-2026-27', 'stage_1',
    'Туршилтын 1-р шат, Бямба 14:00', 'Бямба', '14:00', '15:20', 10,
    'full', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
  ),
  (
    'staging-fixture-stage-2-sunday', 'staging-fixture-2026-27', 'stage_2',
    'Туршилтын 2-р шат, Ням 10:00', 'Ням', '10:00', '11:20', 10,
    'available', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
  ),
  (
    'staging-fixture-stage-2-tuesday', 'staging-fixture-2026-27', 'stage_2',
    'Туршилтын 2-р шат, Мягмар 16:00', 'Мягмар', '16:00', '17:20', 8,
    'available', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
  ),
  (
    'staging-fixture-stage-3-sunday', 'staging-fixture-2026-27', 'stage_3',
    'Туршилтын 3-р шат, Ням 13:00', 'Ням', '13:00', '15:00', 10,
    'full', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
  ),
  (
    'staging-fixture-stage-3-tuesday', 'staging-fixture-2026-27', 'stage_3',
    'Туршилтын 3-р шат, Мягмар 18:00', 'Мягмар', '18:00', '19:20', 6,
    'available', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
  );

UPDATE class_session
SET
  capacity = CASE
    WHEN id = 'staging-fixture-stage-2-tuesday' THEN 8
    WHEN id = 'staging-fixture-stage-3-tuesday' THEN 6
    ELSE 10
  END,
  status = CASE
    WHEN id IN ('staging-fixture-stage-1-afternoon', 'staging-fixture-stage-3-sunday') THEN 'full'
    ELSE 'available'
  END,
  is_test_only = 1,
  is_test = 1,
  test_run_id = 'staging-catalog-fixture',
  updated_at = '2026-08-10T00:00:00Z'
WHERE id IN (
  'staging-fixture-stage-1-saturday',
  'staging-fixture-stage-1-afternoon',
  'staging-fixture-stage-2-sunday',
  'staging-fixture-stage-2-tuesday',
  'staging-fixture-stage-3-sunday',
  'staging-fixture-stage-3-tuesday'
)
AND (
  capacity != CASE
    WHEN id = 'staging-fixture-stage-2-tuesday' THEN 8
    WHEN id = 'staging-fixture-stage-3-tuesday' THEN 6
    ELSE 10
  END
  OR status != CASE
    WHEN id IN ('staging-fixture-stage-1-afternoon', 'staging-fixture-stage-3-sunday') THEN 'full'
    ELSE 'available'
  END
  OR is_test_only != 1
  OR is_test != 1
  OR test_run_id != 'staging-catalog-fixture'
  OR updated_at != '2026-08-10T00:00:00Z'
);

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
  'staging-fixture-2026-27', 'submitted', 1, 'staging-catalog-fixture',
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
  'staging-fixture-2026-27',
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
