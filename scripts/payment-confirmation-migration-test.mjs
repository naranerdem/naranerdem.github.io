import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "naranerdem-payment-confirmation-migration-"));
const database = path.join(dir, "migration.sqlite3");

function sql(source, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", database] : [database], { input: `PRAGMA foreign_keys=ON;\n${source}`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stderr}`);
  return result.stdout.trim();
}

try {
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  for (const file of migrations.filter((file) => file < "0040_")) sql(readFileSync(path.join("migrations", file), "utf8"));

  sql(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, created_at, updated_at)
    VALUES ('year', 'Тест', 'open', 1, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO registration_draft (
      id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone,
      email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version,
      status, expires_at, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'draft', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'year', 'Тест Асран', 'Ээж', '99000000',
      'test@example.test', 'test@example.test', 'Тест хаяг', 'two_installment', 'parent', 'student',
      'awaiting_initial_payment', '2026-09-02T00:00:00.000Z', 1, 'migration-test', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO payment_request (id, registration_draft_id, payment_reference, is_test, test_run_id, created_at, updated_at)
      VALUES ('request', 'draft', 'NE-MIGRATE', 1, 'migration-test', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO received_payment (
      id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status,
      confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id
    ) VALUES ('received-existing', 'request', 100000, '2026-09-01T00:00:00.000Z', 'staff_manual_bank', 'confirmed',
      '2026-09-01T00:00:00.000Z', 'existing', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, 'migration-test');
    INSERT INTO payment_confirmation (
      id, received_payment_id, payment_request_id, status, finalize_after, seat_confirmation_approved,
      remaining_payment_due_at, created_at, updated_at, is_test, test_run_id
    ) VALUES ('existing-confirmation', 'received-existing', 'request', 'finalized', '2026-09-01T00:05:00.000Z', 1,
      '2026-09-30T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, 'migration-test');`);

  sql(readFileSync("migrations/0040_allow_approved_seat_without_custom_deadline.sql", "utf8"));
  const existing = JSON.parse(sql("SELECT id, remaining_payment_due_at AS dueAt FROM payment_confirmation WHERE id = 'existing-confirmation';", true));
  assert.deepEqual(existing, [{ id: "existing-confirmation", dueAt: "2026-09-30T00:00:00.000Z" }], "existing custom deadlines survive the rebuild unchanged");
  sql(`INSERT INTO received_payment (
      id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status,
      confirmed_at, idempotency_key, created_at, updated_at, is_test, test_run_id
    ) VALUES ('received-two-plan', 'request', 100000, '2026-09-01T00:00:00.000Z', 'staff_manual_bank', 'confirmed',
      '2026-09-01T00:00:00.000Z', 'two-plan', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, 'migration-test');
    INSERT INTO payment_confirmation (
      id, received_payment_id, payment_request_id, status, finalize_after, seat_confirmation_approved,
      remaining_payment_due_at, created_at, updated_at, is_test, test_run_id
    ) VALUES ('two-plan-confirmation', 'received-two-plan', 'request', 'tentative', '2026-09-01T00:05:00.000Z', 1,
      NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, 'migration-test');`);
  assert.equal(sql("PRAGMA foreign_key_check;"), "", "the rebuilt table retains valid foreign keys");
  assert.equal(sql("PRAGMA integrity_check;"), "ok", "the rebuilt database remains structurally sound");
  console.log("ok payment confirmation migration preserves custom deadlines and permits ordinary later-installment approval");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
