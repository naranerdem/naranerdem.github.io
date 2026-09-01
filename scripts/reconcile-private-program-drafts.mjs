import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPrivateProgramDraftReconciliationSql, validatePrivateProgramDraftReconciliationPlan } from "./private-program-config.mjs";
import { executeRemoteD1File, parseOptions, queryRemoteD1 } from "./private-config-cli.mjs";

function planFromFile(file) {
  if (!file) throw new Error("Use --file=<private-draft-reconciliation.json>.");
  const absolute = path.resolve(file);
  let text;
  try { text = readFileSync(absolute, "utf8"); } catch { throw new Error("Could not read the private draft reconciliation plan."); }
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error("Private draft reconciliation plan is not valid JSON."); }
  validatePrivateProgramDraftReconciliationPlan(plan);
  return { absolute, plan };
}

function quoteList(values) {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

function programsForPlan(plan) {
  const ids = quoteList([...new Set(plan.drafts.flatMap((entry) => [entry.program_id, entry.expected_current_program_id]))]);
  const rows = queryRemoteD1("staging", `SELECT program.id, program.status, program.updated_at, lesson.sequence_number, lesson.title, lesson.internal_note
    FROM curriculum_program AS program LEFT JOIN curriculum_lesson AS lesson
      ON lesson.curriculum_program_id = program.id AND lesson.status = 'active'
    WHERE program.id IN (${ids}) ORDER BY program.id, lesson.sequence_number`);
  const programs = new Map();
  for (const row of rows) {
    if (!programs.has(row.id)) programs.set(row.id, { id: row.id, status: row.status, updatedAt: row.updated_at, lessons: [] });
    if (row.sequence_number !== null) programs.get(row.id).lessons.push({ sequence_number: Number(row.sequence_number), title: row.title.trim(), internal_note: row.internal_note ? row.internal_note.trim() : null });
  }
  return programs;
}

function checksum(lessons) {
  return createHash("sha256").update(JSON.stringify(lessons)).digest("hex");
}

export function runReconciliation(args = process.argv.slice(2)) {
  const options = parseOptions(args, ["--dry-run", "--apply"]);
  if (options.environment !== "staging") throw new Error("Private Program draft reconciliation is staging-only.");
  if (options.output) throw new Error("Draft reconciliation does not accept --output.");
  const { absolute, plan } = planFromFile(options.file);
  const before = programsForPlan(plan);
  for (const entry of plan.drafts) {
    const row = before.get(entry.program_id);
    const current = before.get(entry.expected_current_program_id);
    if (!row || !current || row.status !== "draft" || current.status !== "published" || row.updatedAt !== entry.expected_updated_at || row.lessons.length !== entry.expected_lesson_count
      || checksum(row.lessons) !== entry.content_checksum || checksum(current.lessons) !== entry.expected_current_content_checksum) {
      throw new Error("Staging Program draft changed since the private reconciliation plan was reviewed.");
    }
  }
  console.log(`Target: staging; drafts: ${plan.drafts.length}`);
  for (const entry of plan.drafts) console.log(`${entry.family_id}: ${entry.action}; ${entry.expected_lesson_count} lessons`);
  if (options.dry_run || !options.apply) { console.log("Dry run only; D1 was not changed."); return { changed: false, plan }; }
  const directory = mkdtempSync(path.join(tmpdir(), "naranerdem-private-program-reconcile-"));
  const sqlPath = path.join(directory, "reconcile.sql");
  try {
    writeFileSync(sqlPath, buildPrivateProgramDraftReconciliationSql(plan), { encoding: "utf8", mode: 0o600 });
    executeRemoteD1File("staging", sqlPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const after = programsForPlan(plan);
  if (plan.drafts.some((entry) => after.has(entry.program_id))) throw new Error("Private Program draft reconciliation did not remove every reviewed draft.");
  console.log(`Private Program draft reconciliation verified from ${absolute}.`);
  return { changed: true, plan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runReconciliation(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
