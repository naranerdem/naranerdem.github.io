import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PRIVATE_PROGRAM_ROWS_QUERY,
  buildPrivateProgramImportPlan,
  buildPrivateProgramImportSql,
  buildPrivateProgramDraftReconciliationSql,
  createPrivateConfigBundle,
  requireProductionConfirmation,
  validatePrivateProgramDraftReconciliationPlan,
  validatePrivateConfigBundle,
} from "./private-program-config.mjs";

const temp = mkdtempSync(path.join(tmpdir(), "naranerdem-private-program-test-"));
const sourceDb = path.join(temp, "source.sqlite3");
const targetDb = path.join(temp, "target.sqlite3");

function sqlite(database, sql, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", database] : [database], { input: `PRAGMA foreign_keys=ON;\n${sql}`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sqlite3 failed: ${result.stderr}`);
  return result.stdout.trim();
}

function rows(database) {
  const output = sqlite(database, PRIVATE_PROGRAM_ROWS_QUERY, true);
  return output ? JSON.parse(output) : [];
}

function applyMigrations(database) {
  const sql = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(path.join("migrations", name), "utf8")).join("\n");
  sqlite(database, sql);
}

function deterministicIds() {
  let value = 0;
  return () => `test-${++value}`;
}

try {
  applyMigrations(sourceDb);
  applyMigrations(targetDb);
  const idFactory = deterministicIds();
  const time = "2026-08-14T00:00:00.000Z";
  sqlite(sourceDb, `
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('fake-library', 'Fake private library', 'draft', NULL, NULL, 0, 0, NULL, '${time}', '${time}');
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, current_published_program_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('fake-stage-one-family', 'annual_course', 'Fake Stage 1', 'stage_1', NULL, 'active', 0, NULL, '${time}', '${time}');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('fake-source-revision', 'fake-stage-one-family', 'fake-library', 'stage_1', 1, 'Fake current revision', 'annual_course', 'draft', NULL, 0, NULL, '${time}', '${time}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, internal_note, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('fake-lesson-1', 'fake-source-revision', 1, 'Туршилтын хичээл 01', NULL, 'active', 0, NULL, '${time}', '${time}'),
      ('fake-lesson-2', 'fake-source-revision', 2, 'Туршилтын хичээл 02', 'Туршилтын тэмдэглэл', 'active', 0, NULL, '${time}', '${time}');
    UPDATE curriculum_program SET status = 'published', published_at = '${time}' WHERE id = 'fake-source-revision';
    UPDATE curriculum_program_family SET current_published_program_id = 'fake-source-revision' WHERE id = 'fake-stage-one-family';
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('fake-unsaved-draft', 'fake-stage-one-family', 'fake-library', 'stage_1', 2, 'Fake unsaved draft', 'annual_course', 'draft', 'fake-source-revision', 0, NULL, '${time}', '${time}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, internal_note, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('fake-unsaved-lesson', 'fake-unsaved-draft', 1, 'Туршилтын хадгалаагүй хичээл', NULL, 'active', 0, NULL, '${time}', '${time}');
  `);

  const bundle = createPrivateConfigBundle(rows(sourceDb), "staging", time);
  assert.equal(bundle.programs.length, 1);
  assert.equal(bundle.programs[0].lessons.length, 2);
  assert.equal(bundle.programs[0].source_revision_id, "fake-source-revision", "only the current saved revision is exported");
  assert.doesNotMatch(JSON.stringify(bundle), /хадгалаагүй/, "working-draft content is excluded from the bundle");
  assert.throws(() => validatePrivateConfigBundle({ ...bundle, unexpected: true }), /unsupported or missing fields/);
  assert.throws(() => validatePrivateConfigBundle({ ...bundle, schema_version: 2 }), /unsupported schema_version/);
  const unknownProgramField = structuredClone(bundle);
  unknownProgramField.programs[0].unexpected = true;
  assert.throws(() => validatePrivateConfigBundle(unknownProgramField), /unsupported or missing fields/);

  sqlite(sourceDb, `
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('fake-isolated-test-draft', 'fake-stage-one-family', 'fake-library', 'stage_1', 3, 'Fake isolated test draft', 'annual_course', 'draft', NULL, 1, 'private-program-test', '${time}', '${time}');
  `);
  const reconciliationPlan = {
    schema_version: 1,
    source_environment: "staging",
    drafts: [
      { action: "discard_isolated_test_draft", family_id: "fake-stage-one-family", program_id: "fake-isolated-test-draft", expected_current_program_id: "fake-source-revision", expected_updated_at: time, expected_lesson_count: 0, content_checksum: "0".repeat(64), expected_current_content_checksum: "2".repeat(64) },
      { action: "discard_redundant_draft", family_id: "fake-stage-one-family", program_id: "fake-unsaved-draft", expected_current_program_id: "fake-source-revision", expected_updated_at: time, expected_lesson_count: 1, content_checksum: "1".repeat(64), expected_current_content_checksum: "2".repeat(64) },
    ],
  };
  assert.doesNotThrow(() => validatePrivateProgramDraftReconciliationPlan(reconciliationPlan));
  const reconciliationSql = buildPrivateProgramDraftReconciliationSql(reconciliationPlan, time, idFactory);
  assert.doesNotMatch(reconciliationSql, /CREATE TEMP|PRAGMA/, "reconciliation uses portable D1 guards rather than unsupported temporary state");
  assert.match(reconciliationSql, /private_program_import_guard_failure/, "stale reconciliation state fails closed");
  sqlite(sourceDb, reconciliationSql);
  assert.equal(Number(JSON.parse(sqlite(sourceDb, "SELECT COUNT(*) AS count FROM curriculum_program WHERE status = 'draft';", true))[0].count), 0, "reviewed unreferenced drafts are removed through the guarded reconciliation path");
  assert.equal(Number(JSON.parse(sqlite(sourceDb, "SELECT COUNT(*) AS count FROM audit_event WHERE action = 'private_program_draft_discarded';", true))[0].count), 2, "each private reconciliation discard is audited");

  const firstPlan = buildPrivateProgramImportPlan(bundle, rows(targetDb));
  assert.deepEqual(firstPlan.map((entry) => entry.action), ["created"]);
  const firstSql = buildPrivateProgramImportSql(firstPlan, time, idFactory);
  assert.doesNotMatch(firstSql, /CREATE TEMP|PRAGMA/, "private Program promotion uses portable audited preconditions");
  sqlite(targetDb, firstSql);
  const roundTrip = createPrivateConfigBundle(rows(targetDb), "production", time);
  assert.deepEqual(roundTrip.programs.map(({ source_revision_id, source_revision_number, ...program }) => program), bundle.programs.map(({ source_revision_id, source_revision_number, ...program }) => program), "fake private Program content round-trips semantically");

  const noOpPlan = buildPrivateProgramImportPlan(bundle, rows(targetDb));
  assert.deepEqual(noOpPlan.map((entry) => entry.action), ["unchanged"]);
  assert.equal(buildPrivateProgramImportSql(noOpPlan), "", "same content produces no duplicate revision SQL");
  assert.equal(Number(JSON.parse(sqlite(targetDb, "SELECT COUNT(*) AS count FROM curriculum_program;", true))[0].count), 1);

  const pinnedRevisionId = JSON.parse(sqlite(targetDb, "SELECT current_published_program_id AS id FROM curriculum_program_family WHERE id = 'fake-stage-one-family';", true))[0].id;
  sqlite(targetDb, `
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, ends_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('fake-existing-offering', 'annual_course', 'Fake existing Offering', 'private-program-library', 'stage_1', '2026-10-01', '2027-06-01', '${pinnedRevisionId}', 1, 'paid', 'active', 0, NULL, '${time}', '${time}');
  `);

  const changedBundle = structuredClone(bundle);
  changedBundle.programs[0].lessons[1].title = "Туршилтын шинэчилсэн хичээл 02";
  const changedPlan = buildPrivateProgramImportPlan(changedBundle, rows(targetDb));
  assert.deepEqual(changedPlan.map((entry) => entry.action), ["revised"]);
  sqlite(targetDb, buildPrivateProgramImportSql(changedPlan, "2026-08-14T00:01:00.000Z", idFactory));
  assert.equal(Number(JSON.parse(sqlite(targetDb, "SELECT COUNT(*) AS count FROM curriculum_program;", true))[0].count), 2, "changed content creates one new immutable revision");
  assert.equal(Number(JSON.parse(sqlite(targetDb, "SELECT COUNT(*) AS count FROM curriculum_program WHERE status = 'superseded';", true))[0].count), 1, "old current revision remains historical");
  assert.deepEqual(buildPrivateProgramImportPlan(changedBundle, rows(targetDb)).map((entry) => entry.action), ["unchanged"]);
  assert.equal(JSON.parse(sqlite(targetDb, "SELECT curriculum_program_id AS id FROM activity_offering WHERE id = 'fake-existing-offering';", true))[0].id, pinnedRevisionId, "promotion does not move an existing Offering pin");

  const latest = JSON.parse(sqlite(targetDb, "SELECT current_published_program_id AS id FROM curriculum_program_family WHERE id = 'fake-stage-one-family';", true))[0].id;
  sqlite(targetDb, `
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('fake-target-working-draft', 'fake-stage-one-family', 'private-program-library', 'stage_1', 3, 'Fake target draft', 'annual_course', 'draft', '${latest}', 0, NULL, '${time}', '${time}');
  `);
  const conflictingBundle = structuredClone(changedBundle);
  conflictingBundle.programs[0].lessons[0].title = "Туршилтын зөрчилтэй хичээл";
  assert.throws(() => buildPrivateProgramImportPlan(conflictingBundle, rows(targetDb)), /working draft/, "changed promotion refuses a target working draft");

  assert.throws(() => requireProductionConfirmation("production", false, false), /--confirm-production/);
  assert.doesNotThrow(() => requireProductionConfirmation("production", true, false));
  assert.doesNotThrow(() => requireProductionConfirmation("production", false, true));
  console.log("ok private Program bundle validation, saved-only export, round trip, no-op, immutable revision, Offering pin, conflict, and production guard");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
