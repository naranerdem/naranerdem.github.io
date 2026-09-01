import { createHash, randomUUID } from "node:crypto";

export const PRIVATE_CONFIG_SCHEMA_VERSION = 1;
export const PRIVATE_CONFIG_DIRECTORY = "_private/operational-config";

export const PRIVATE_PROGRAM_ROWS_QUERY = `
  SELECT
    family.id AS family_id,
    family.kind,
    family.display_name AS family_display_name,
    family.annual_stage_code,
    family.current_published_program_id AS current_revision_id,
    family.status AS family_status,
    family.is_test AS family_is_test,
    program.academic_year_id AS current_academic_year_id,
    program.stage_code AS current_stage_code,
    program.revision_number AS current_revision_number,
    program.display_name AS revision_display_name,
    program.status AS current_revision_status,
    program.is_test AS current_revision_is_test,
    lesson.sequence_number,
    lesson.title,
    lesson.internal_note,
    lesson.is_test AS lesson_is_test,
    (SELECT COUNT(*) FROM curriculum_program AS draft
      WHERE draft.program_family_id = family.id AND draft.status = 'draft') AS working_draft_count,
    (SELECT COALESCE(MAX(revision.revision_number), 0) FROM curriculum_program AS revision
      WHERE revision.program_family_id = family.id) AS max_revision_number
  FROM curriculum_program_family AS family
  LEFT JOIN curriculum_program AS program
    ON program.id = family.current_published_program_id
  LEFT JOIN curriculum_lesson AS lesson
    ON lesson.curriculum_program_id = program.id AND lesson.status = 'active'
  ORDER BY family.id, lesson.sequence_number
`;

const programKinds = new Set(["annual_course", "summer_course"]);
const annualStages = new Set(["stage_1", "stage_2", "stage_3"]);

function expect(value, message) {
  if (!value) throw new Error(`Invalid private Program bundle: ${message}`);
}

function exactKeys(value, expected, label) {
  expect(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  expect(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} has unsupported or missing fields`);
}

function requiredText(value, label, max = 200) {
  expect(typeof value === "string" && value.trim().length > 0 && value.length <= max, `${label} is invalid`);
  return value;
}

function optionalText(value, label, max = 1000) {
  expect(value === null || (typeof value === "string" && value.length <= max), `${label} is invalid`);
  return value === "" ? null : value;
}

function integer(value, label) {
  expect(Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function isoTimestamp(value, label) {
  requiredText(value, label, 40);
  expect(new Date(value).toISOString() === value, `${label} must be an ISO timestamp`);
  return value;
}

export function validatePrivateConfigBundle(bundle) {
  exactKeys(bundle, ["schema_version", "exported_at", "source_environment", "programs"], "bundle");
  expect(bundle.schema_version === PRIVATE_CONFIG_SCHEMA_VERSION, `unsupported schema_version ${String(bundle.schema_version)}`);
  isoTimestamp(bundle.exported_at, "exported_at");
  expect(["staging", "production"].includes(bundle.source_environment), "source_environment must be staging or production");
  expect(Array.isArray(bundle.programs), "programs must be an array");

  const familyIds = new Set();
  const annualIdentities = new Set();
  for (const [programIndex, program] of bundle.programs.entries()) {
    const label = `program ${programIndex + 1}`;
    exactKeys(program, [
      "family_id", "kind", "annual_stage_code", "family_display_name",
      "source_revision_id", "source_revision_number", "revision_display_name", "lessons",
    ], label);
    const familyId = requiredText(program.family_id, `${label} family_id`, 100);
    expect(!familyIds.has(familyId), `duplicate family_id ${familyId}`);
    familyIds.add(familyId);
    expect(programKinds.has(program.kind), `${label} has unsupported kind`);
    requiredText(program.family_display_name, `${label} family_display_name`, 160);
    requiredText(program.source_revision_id, `${label} source_revision_id`, 100);
    integer(program.source_revision_number, `${label} source_revision_number`);
    requiredText(program.revision_display_name, `${label} revision_display_name`, 160);
    if (program.kind === "annual_course") {
      expect(annualStages.has(program.annual_stage_code), `${label} needs a valid annual_stage_code`);
      expect(!annualIdentities.has(program.annual_stage_code), `duplicate annual stage ${program.annual_stage_code}`);
      annualIdentities.add(program.annual_stage_code);
    } else {
      expect(program.annual_stage_code === null, `${label} summer annual_stage_code must be null`);
    }
    expect(Array.isArray(program.lessons) && program.lessons.length > 0, `${label} needs at least one lesson`);
    program.lessons.forEach((lesson, lessonIndex) => {
      const lessonLabel = `${label} lesson ${lessonIndex + 1}`;
      exactKeys(lesson, ["sequence_number", "title", "internal_note"], lessonLabel);
      expect(integer(lesson.sequence_number, `${lessonLabel} sequence_number`) === lessonIndex + 1, `${lessonLabel} sequence_number must be contiguous`);
      requiredText(lesson.title, `${lessonLabel} title`, 200);
      optionalText(lesson.internal_note, `${lessonLabel} internal_note`);
    });
  }
  return bundle;
}

function groupedFamilies(rows) {
  const families = new Map();
  for (const row of rows) {
    let family = families.get(row.family_id);
    if (!family) {
      family = {
        id: row.family_id,
        kind: row.kind,
        annualStageCode: row.annual_stage_code ?? null,
        familyDisplayName: row.family_display_name,
        familyStatus: row.family_status,
        familyIsTest: Number(row.family_is_test ?? 0),
        currentRevisionId: row.current_revision_id ?? null,
        currentAcademicYearId: row.current_academic_year_id ?? null,
        currentStageCode: row.current_stage_code ?? null,
        currentRevisionNumber: row.current_revision_number === null ? null : Number(row.current_revision_number),
        revisionDisplayName: row.revision_display_name ?? null,
        currentRevisionStatus: row.current_revision_status ?? null,
        currentRevisionIsTest: row.current_revision_is_test === null ? null : Number(row.current_revision_is_test),
        workingDraftCount: Number(row.working_draft_count ?? 0),
        maxRevisionNumber: Number(row.max_revision_number ?? 0),
        lessons: [],
      };
      families.set(row.family_id, family);
    }
    if (row.sequence_number !== null && row.sequence_number !== undefined) {
      family.lessons.push({
        sequence_number: Number(row.sequence_number),
        title: row.title,
        internal_note: row.internal_note || null,
        isTest: Number(row.lesson_is_test ?? 0),
      });
    }
  }
  return [...families.values()];
}

export function createPrivateConfigBundle(rows, sourceEnvironment, exportedAt = new Date().toISOString()) {
  expect(["staging", "production"].includes(sourceEnvironment), "source environment is required");
  const programs = [];
  for (const family of groupedFamilies(rows)) {
    if (family.familyStatus !== "active" || family.familyIsTest !== 0 || !family.currentRevisionId) continue;
    expect(family.currentRevisionStatus === "published", `family ${family.id} current pointer is not published`);
    expect(family.currentRevisionIsTest === 0, `family ${family.id} current revision is test data`);
    expect(family.lessons.length > 0, `family ${family.id} current revision has no lessons`);
    expect(family.lessons.every((lesson) => lesson.isTest === 0), `family ${family.id} includes test lessons`);
    programs.push({
      family_id: family.id,
      kind: family.kind,
      annual_stage_code: family.annualStageCode,
      family_display_name: family.familyDisplayName,
      source_revision_id: family.currentRevisionId,
      source_revision_number: family.currentRevisionNumber,
      revision_display_name: family.revisionDisplayName,
      lessons: family.lessons.map(({ sequence_number, title, internal_note }) => ({ sequence_number, title, internal_note })),
    });
  }
  const bundle = {
    schema_version: PRIVATE_CONFIG_SCHEMA_VERSION,
    exported_at: exportedAt,
    source_environment: sourceEnvironment,
    programs: programs.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
      return (left.annual_stage_code ?? left.family_id).localeCompare(right.annual_stage_code ?? right.family_id);
    }),
  };
  return validatePrivateConfigBundle(bundle);
}

function comparableProgram(program) {
  return JSON.stringify({
    kind: program.kind,
    annual_stage_code: program.annual_stage_code,
    family_display_name: program.family_display_name,
    revision_display_name: program.revision_display_name,
    lessons: program.lessons.map((lesson) => ({
      sequence_number: lesson.sequence_number,
      title: lesson.title,
      internal_note: lesson.internal_note || null,
    })),
  });
}

function familyAsProgram(family) {
  if (!family.currentRevisionId) return null;
  return {
    kind: family.kind,
    annual_stage_code: family.annualStageCode,
    family_display_name: family.familyDisplayName,
    revision_display_name: family.revisionDisplayName,
    lessons: family.lessons.map(({ sequence_number, title, internal_note }) => ({ sequence_number, title, internal_note })),
  };
}

export function buildPrivateProgramImportPlan(bundle, targetRows) {
  validatePrivateConfigBundle(bundle);
  const targetFamilies = groupedFamilies(targetRows);
  const plan = [];

  for (const program of bundle.programs) {
    const identityMatches = program.kind === "annual_course"
      ? targetFamilies.filter((family) => family.kind === "annual_course" && family.annualStageCode === program.annual_stage_code)
      : targetFamilies.filter((family) => family.id === program.family_id);
    expect(identityMatches.length <= 1, `target has duplicate logical family for ${program.family_id}`);
    const idCollision = targetFamilies.find((family) => family.id === program.family_id && !identityMatches.includes(family));
    expect(!idCollision, `target family id ${program.family_id} has an incompatible identity`);
    const target = identityMatches[0] ?? null;

    if (target) {
      expect(target.familyIsTest === 0, `target family ${target.id} is test data`);
      expect(target.familyStatus === "active", `target family ${target.id} is not active`);
      expect(target.kind === program.kind, `target family ${target.id} has an incompatible kind`);
      if (target.currentRevisionId) {
        expect(target.currentRevisionStatus === "published", `target family ${target.id} current pointer is invalid`);
        expect(target.currentRevisionIsTest === 0, `target family ${target.id} current revision is test data`);
        expect(target.lessons.length > 0 && target.lessons.every((lesson) => lesson.isTest === 0), `target family ${target.id} current lessons are invalid`);
        if (comparableProgram(program) === comparableProgram(familyAsProgram(target))) {
          plan.push({ action: "unchanged", program, targetFamilyId: target.id, targetRevisionId: target.currentRevisionId });
          continue;
        }
        expect(target.workingDraftCount === 0, `target family ${target.id} has a working draft`);
        plan.push({
          action: "revised",
          program,
          targetFamilyId: target.id,
          targetRevisionId: target.currentRevisionId,
          targetAcademicYearId: target.currentAcademicYearId,
          targetStageCode: target.currentStageCode,
          expectedMaxRevision: target.maxRevisionNumber,
          nextRevisionNumber: target.maxRevisionNumber + 1,
          createFamily: false,
        });
        continue;
      }
      expect(target.workingDraftCount === 0, `target family ${target.id} has an unsaved draft but no current revision`);
      plan.push({
        action: "created",
        program,
        targetFamilyId: target.id,
        targetRevisionId: null,
        targetAcademicYearId: null,
        targetStageCode: null,
        expectedMaxRevision: target.maxRevisionNumber,
        nextRevisionNumber: target.maxRevisionNumber + 1,
        createFamily: false,
      });
      continue;
    }

    plan.push({
      action: "created",
      program,
      targetFamilyId: program.family_id,
      targetRevisionId: null,
      targetAcademicYearId: null,
      targetStageCode: null,
      expectedMaxRevision: 0,
      nextRevisionNumber: 1,
      createFamily: true,
    });
  }
  return plan;
}

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function privateContextId(program) {
  if (program.kind === "annual_course") return "private-program-library";
  return `private-summer-program-${createHash("sha256").update(program.family_id).digest("hex").slice(0, 20)}`;
}

function guardedAuditSql(condition, id, action, subjectId, metadata, environment, isTest, testRunId, timestamp) {
  const columns = "id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at";
  const accepted = `${quote(id)}, ${quote(timestamp)}, 'system', NULL, ${quote(action)}, 'curriculum_program', ${quote(subjectId)}, ${quote(JSON.stringify(metadata))}, ${quote(environment)}, ${isTest}, ${quote(testRunId)}, ${quote(timestamp)}`;
  // The rejected actor type deliberately violates the audited enum. D1 rolls the
  // import back rather than letting a stale precondition write partial data.
  const rejected = `${quote(id)}, ${quote(timestamp)}, 'private_program_import_guard_failure', NULL, ${quote(action)}, 'curriculum_program', ${quote(subjectId)}, NULL, ${quote(environment)}, ${isTest}, ${quote(testRunId)}, ${quote(timestamp)}`;
  return `INSERT INTO audit_event (${columns}) SELECT ${accepted} WHERE ${condition} UNION ALL SELECT ${rejected} WHERE NOT (${condition});`;
}

export function buildPrivateProgramImportSql(plan, timestamp = new Date().toISOString(), idFactory = randomUUID, environment = "production") {
  expect(["staging", "production"].includes(environment), "private Program import environment is invalid");
  const changes = plan.filter((entry) => entry.action !== "unchanged");
  if (!changes.length) return "";
  const lines = ["-- Private Program promotion. Guarded audit inserts fail closed on stale state."];

  for (const entry of changes) {
    const { program } = entry;
    const contextId = entry.targetAcademicYearId || privateContextId(program);
    const stageCode = entry.targetStageCode || program.annual_stage_code || "stage_1";
    const revisionId = `private-program-${idFactory()}`;
    const contextLabel = program.kind === "annual_course" ? "Private Program library" : "Private summer Program context";
    const contextCondition = `NOT EXISTS (SELECT 1 FROM academic_year WHERE id = ${quote(contextId)}) OR EXISTS (SELECT 1 FROM academic_year WHERE id = ${quote(contextId)} AND starts_on IS NULL AND ends_on IS NULL AND is_current = 0 AND is_test = 0)`;
    let programCondition;
    if (entry.createFamily) {
      const identityCondition = program.kind === "annual_course"
        ? `NOT EXISTS (SELECT 1 FROM curriculum_program_family WHERE annual_stage_code = ${quote(program.annual_stage_code)})`
        : `NOT EXISTS (SELECT 1 FROM curriculum_program_family WHERE id = ${quote(entry.targetFamilyId)})`;
      programCondition = `${identityCondition} AND NOT EXISTS (SELECT 1 FROM curriculum_program_family WHERE id = ${quote(entry.targetFamilyId)})`;
    } else if (entry.action === "revised") {
      programCondition = `EXISTS (SELECT 1 FROM curriculum_program_family AS family INNER JOIN curriculum_program AS program ON program.id = family.current_published_program_id WHERE family.id = ${quote(entry.targetFamilyId)} AND family.current_published_program_id = ${quote(entry.targetRevisionId)} AND program.status = 'published') AND NOT EXISTS (SELECT 1 FROM curriculum_program WHERE program_family_id = ${quote(entry.targetFamilyId)} AND status = 'draft') AND (SELECT COALESCE(MAX(revision_number), 0) FROM curriculum_program WHERE program_family_id = ${quote(entry.targetFamilyId)}) = ${entry.expectedMaxRevision}`;
    } else {
      programCondition = `EXISTS (SELECT 1 FROM curriculum_program_family WHERE id = ${quote(entry.targetFamilyId)} AND current_published_program_id IS NULL) AND NOT EXISTS (SELECT 1 FROM curriculum_program WHERE program_family_id = ${quote(entry.targetFamilyId)} AND status = 'draft') AND (SELECT COALESCE(MAX(revision_number), 0) FROM curriculum_program WHERE program_family_id = ${quote(entry.targetFamilyId)}) = ${entry.expectedMaxRevision}`;
    }
    lines.push(guardedAuditSql(`(${contextCondition}) AND (${programCondition})`, `private-program-import-${idFactory()}`, "private_program_imported", entry.targetFamilyId, {
      action: entry.action,
      sourceRevisionId: program.source_revision_id,
      sourceRevisionNumber: program.source_revision_number,
      lessonCount: program.lessons.length,
    }, environment, 0, null, timestamp));
    lines.push(`INSERT OR IGNORE INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at) VALUES (${quote(contextId)}, ${quote(contextLabel)}, 'draft', NULL, NULL, 0, 0, NULL, ${quote(timestamp)}, ${quote(timestamp)});`);
    if (entry.createFamily) {
      lines.push(`INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, current_published_program_id, status, is_test, test_run_id, created_at, updated_at) VALUES (${quote(entry.targetFamilyId)}, ${quote(program.kind)}, ${quote(program.family_display_name)}, ${quote(program.annual_stage_code)}, NULL, 'active', 0, NULL, ${quote(timestamp)}, ${quote(timestamp)});`);
    }
    lines.push(`INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at) VALUES (${quote(revisionId)}, ${quote(entry.targetFamilyId)}, ${quote(contextId)}, ${quote(stageCode)}, ${entry.nextRevisionNumber}, ${quote(program.revision_display_name)}, ${quote(program.kind)}, 'draft', ${quote(entry.targetRevisionId)}, 0, NULL, ${quote(timestamp)}, ${quote(timestamp)});`);
    for (const lesson of program.lessons) {
      lines.push(`INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, internal_note, status, is_test, test_run_id, created_at, updated_at) VALUES (${quote(`private-lesson-${idFactory()}`)}, ${quote(revisionId)}, ${lesson.sequence_number}, ${quote(lesson.title)}, ${quote(lesson.internal_note)}, 'active', 0, NULL, ${quote(timestamp)}, ${quote(timestamp)});`);
    }
    if (entry.action === "revised") lines.push(`UPDATE curriculum_program SET status = 'superseded', updated_at = ${quote(timestamp)} WHERE id = ${quote(entry.targetRevisionId)} AND status = 'published';`);
    lines.push(`UPDATE curriculum_program SET status = 'published', published_at = ${quote(timestamp)}, updated_at = ${quote(timestamp)} WHERE id = ${quote(revisionId)} AND status = 'draft';`);
    lines.push(`UPDATE curriculum_program_family SET display_name = ${quote(program.family_display_name)}, current_published_program_id = ${quote(revisionId)}, updated_at = ${quote(timestamp)} WHERE id = ${quote(entry.targetFamilyId)};`);
  }
  return `${lines.join("\n\n")}\n`;
}

const reconciliationActions = new Set(["discard_isolated_test_draft", "discard_redundant_draft"]);

export function validatePrivateProgramDraftReconciliationPlan(plan) {
  exactKeys(plan, ["schema_version", "source_environment", "drafts"], "draft reconciliation plan");
  expect(plan.schema_version === 1, "unsupported draft reconciliation schema_version");
  expect(plan.source_environment === "staging", "draft reconciliation source must be staging");
  expect(Array.isArray(plan.drafts) && plan.drafts.length > 0, "draft reconciliation needs entries");
  const programIds = new Set();
  for (const [index, entry] of plan.drafts.entries()) {
    const label = `draft reconciliation entry ${index + 1}`;
    exactKeys(entry, ["action", "family_id", "program_id", "expected_current_program_id", "expected_updated_at", "expected_lesson_count", "content_checksum", "expected_current_content_checksum"], label);
    expect(reconciliationActions.has(entry.action), `${label} action is invalid`);
    const programId = requiredText(entry.program_id, `${label} program_id`, 100);
    expect(!programIds.has(programId), `${label} duplicates a program`);
    programIds.add(programId);
    requiredText(entry.family_id, `${label} family_id`, 100);
    requiredText(entry.expected_current_program_id, `${label} expected_current_program_id`, 100);
    isoTimestamp(entry.expected_updated_at, `${label} expected_updated_at`);
    expect(Number.isInteger(entry.expected_lesson_count) && entry.expected_lesson_count >= 0, `${label} expected_lesson_count is invalid`);
    expect(typeof entry.content_checksum === "string" && /^[a-f0-9]{64}$/.test(entry.content_checksum), `${label} content_checksum is invalid`);
    expect(typeof entry.expected_current_content_checksum === "string" && /^[a-f0-9]{64}$/.test(entry.expected_current_content_checksum), `${label} expected_current_content_checksum is invalid`);
  }
  return plan;
}

export function buildPrivateProgramDraftReconciliationSql(plan, timestamp = new Date().toISOString(), idFactory = randomUUID) {
  validatePrivateProgramDraftReconciliationPlan(plan);
  const lines = ["-- Staging-only private Program draft reconciliation. Guarded audit inserts fail closed on stale state."];
  for (const entry of plan.drafts) {
    const testCondition = entry.action === "discard_isolated_test_draft"
      ? "program.is_test = 1 AND program.test_run_id IS NOT NULL AND program.based_on_program_id IS NULL"
      : "program.is_test = 0 AND program.based_on_program_id = family.current_published_program_id";
    const condition = `EXISTS (SELECT 1 FROM curriculum_program AS program INNER JOIN curriculum_program_family AS family ON family.id = program.program_family_id INNER JOIN curriculum_program AS current ON current.id = family.current_published_program_id WHERE program.id = ${quote(entry.program_id)} AND program.program_family_id = ${quote(entry.family_id)} AND program.status = 'draft' AND program.updated_at = ${quote(entry.expected_updated_at)} AND family.current_published_program_id = ${quote(entry.expected_current_program_id)} AND current.status = 'published' AND ${testCondition} AND (SELECT COUNT(*) FROM curriculum_lesson WHERE curriculum_program_id = program.id AND status = 'active') = ${entry.expected_lesson_count} AND NOT EXISTS (SELECT 1 FROM activity_offering WHERE curriculum_program_id = program.id) AND NOT EXISTS (SELECT 1 FROM class_calendar_revision WHERE curriculum_program_id = program.id))`;
    lines.push(guardedAuditSql(condition, `private-program-draft-discard-${idFactory()}`, "private_program_draft_discarded", entry.program_id, {
      action: entry.action,
      programFamilyId: entry.family_id,
      currentProgramId: entry.expected_current_program_id,
      lessonCount: entry.expected_lesson_count,
      contentChecksum: entry.content_checksum,
      currentContentChecksum: entry.expected_current_content_checksum,
      expectedUpdatedAt: entry.expected_updated_at,
    }, "staging", entry.action === "discard_isolated_test_draft" ? 1 : 0, entry.action === "discard_isolated_test_draft" ? "private-program-reconciliation" : null, timestamp));
    lines.push(`DELETE FROM curriculum_lesson WHERE curriculum_program_id = ${quote(entry.program_id)};`);
    lines.push(`DELETE FROM curriculum_program WHERE id = ${quote(entry.program_id)} AND status = 'draft' AND updated_at = ${quote(entry.expected_updated_at)};`);
  }
  return `${lines.join("\n\n")}\n`;
}

export function privateBundleText(bundle) {
  validatePrivateConfigBundle(bundle);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function requireProductionConfirmation(environment, dryRun, confirmed) {
  if (environment === "production" && !dryRun && !confirmed) {
    throw new Error("Production private Program import requires --confirm-production.");
  }
}

export function programPlanSummary(plan) {
  return plan.map((entry) => ({
    identity: entry.program.kind === "annual_course" ? entry.program.annual_stage_code : entry.program.family_id,
    kind: entry.program.kind,
    lessons: entry.program.lessons.length,
    action: entry.action,
  }));
}
