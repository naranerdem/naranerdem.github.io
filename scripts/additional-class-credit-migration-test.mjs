import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "naranerdem-additional-credit-migration-"));
const database = path.join(directory, "migration.sqlite3");

function sql(source, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", database] : [database], {
    input: `PRAGMA foreign_keys=ON;\n${source}`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stderr}`);
  return result.stdout.trim();
}

try {
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  for (const file of migrations.filter((file) => file < "0046_")) sql(readFileSync(path.join("migrations", file), "utf8"));

  sql(`
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('student', 'Test', 'Credit', 'not_specified', '2015-01-01', 'active', 1, 'migration-test', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO child_credit_operation (
      id, operation_type, source_student_id, target_student_id, amount_mnt, reason, request_fingerprint,
      is_test, test_run_id, created_at
    ) VALUES ('operation', 'manual_add', 'student', NULL, 110000, 'existing credit', 'existing-operation', 1, 'migration-test', '2026-09-01T00:00:00.000Z');
    INSERT INTO child_credit_entry (
      id, canonical_student_id, operation_id, entry_kind, amount_mnt, origin_entry_id, source_payment_credit_id,
      source_class_transfer_credit_id, payment_installment_id, correction_of_entry_id, reason,
      is_test, test_run_id, created_at
    ) VALUES ('entry', 'student', 'operation', 'manual_addition', 110000, NULL, NULL, NULL, NULL, NULL, 'existing credit', 1, 'migration-test', '2026-09-01T00:00:00.000Z');
  `);

  sql(readFileSync("migrations/0046_additional_class_award_credit_lineage.sql", "utf8"));
  sql(readFileSync("migrations/0047_additional_class_credit_reservations.sql", "utf8"));
  sql(readFileSync("migrations/0048_family_discount_membership.sql", "utf8"));

  assert.deepEqual(JSON.parse(sql(`SELECT operation_type AS operationType, source_student_id AS studentId, amount_mnt AS amountMnt FROM child_credit_operation WHERE id = 'operation';`, true)), [
    { operationType: "manual_add", studentId: "student", amountMnt: 110000 },
  ], "the existing operation survives both additive-credit migrations");
  assert.deepEqual(JSON.parse(sql(`SELECT canonical_student_id AS studentId, source_discount_award_id AS sourceAwardId, reserved_amount_mnt AS reservedAmountMnt, amount_mnt AS amountMnt FROM child_credit_entry WHERE id = 'entry';`, true)), [
    { studentId: "student", sourceAwardId: null, reservedAmountMnt: 0, amountMnt: 110000 },
  ], "the existing credit root keeps its identity and receives a zero reservation default");
  const indexes = JSON.parse(sql(`SELECT name FROM pragma_index_list('additional_class_credit_reservation') ORDER BY name;`, true)).map((row) => row.name);
  assert.ok(indexes.includes("idx_additional_class_credit_reservation_admission"), "0047 creates the admission lookup index");
  assert.ok(indexes.includes("idx_additional_class_credit_reservation_target"), "0047 creates the target lookup index");
  const awardColumns = JSON.parse(sql(`SELECT name FROM pragma_table_info('discount_award') ORDER BY cid;`, true)).map((row) => row.name);
  assert.ok(awardColumns.includes("family_group_id"), "0048 adds family membership lineage without rebuilding existing awards");
  const familyIndexes = JSON.parse(sql(`SELECT name FROM pragma_index_list('family_group_member') ORDER BY name;`, true)).map((row) => row.name);
  assert.ok(familyIndexes.includes("idx_family_group_member_one_active_student"), "0048 prevents a student from holding two active family memberships");
  const confirmationIndexes = JSON.parse(sql(`SELECT name FROM pragma_index_list('family_group_confirmation') ORDER BY name;`, true)).map((row) => row.name);
  assert.ok(confirmationIndexes.includes("idx_family_group_confirmation_group"), "0048 creates the family-confirmation lookup index");
  assert.equal(sql("PRAGMA foreign_key_check;"), "", "the 0045 data remains foreign-key consistent after 0046 and 0047");
  assert.equal(sql("PRAGMA integrity_check;"), "ok", "the upgraded database remains structurally sound");
  console.log("ok additional-class, credit, and family migrations preserve 0045 ledger rows and add reservation/membership lineage");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
