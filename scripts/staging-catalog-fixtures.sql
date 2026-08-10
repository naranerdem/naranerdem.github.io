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
    'staging-fixture-stage-2-sunday', 'staging-fixture-2026-27', 'stage_2',
    'Туршилтын 2-р шат, Ням 10:00', 'Ням', '10:00', '11:20', 10,
    'full', 1, 1, 'staging-catalog-fixture',
    '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
  );
