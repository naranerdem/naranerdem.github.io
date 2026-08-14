import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PRIVATE_PROGRAM_ROWS_QUERY,
  buildPrivateProgramImportPlan,
  buildPrivateProgramImportSql,
  programPlanSummary,
  requireProductionConfirmation,
  sha256,
  validatePrivateConfigBundle,
} from "./private-program-config.mjs";
import { d1Target, executeRemoteD1File, parseOptions, queryRemoteD1 } from "./private-config-cli.mjs";

function bundleFromFile(file) {
  if (!file) throw new Error("Use --file=<private-bundle.json>.");
  const absolute = path.resolve(file);
  let text;
  try { text = readFileSync(absolute, "utf8"); } catch { throw new Error("Could not read the private bundle file."); }
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error("Private bundle is not valid JSON."); }
  validatePrivateConfigBundle(bundle);
  return { absolute, text, bundle };
}

function printPlan(target, bundle, checksum, plan) {
  console.log(`Target: ${target.environment} (${target.name}, ${target.id})`);
  console.log(`Bundle source: ${bundle.source_environment}`);
  console.log(`Bundle SHA-256: ${checksum}`);
  console.log(`Programs: ${bundle.programs.length}`);
  for (const entry of programPlanSummary(plan)) console.log(`${entry.identity}: ${entry.lessons} lessons — ${entry.action}`);
}

export function runImport(args = process.argv.slice(2)) {
  const options = parseOptions(args, ["--dry-run", "--confirm-production"]);
  if (options.output) throw new Error("Import does not accept --output.");
  const { absolute, text, bundle } = bundleFromFile(options.file);
  const checksum = sha256(text);
  const target = d1Target(options.environment);
  const beforeRows = queryRemoteD1(options.environment, PRIVATE_PROGRAM_ROWS_QUERY);
  const plan = buildPrivateProgramImportPlan(bundle, beforeRows);
  printPlan(target, bundle, checksum, plan);
  requireProductionConfirmation(options.environment, Boolean(options.dry_run), Boolean(options.confirm_production));
  if (options.dry_run) { console.log("Dry run only; D1 was not changed."); return { plan, checksum, changed: false }; }
  const sql = buildPrivateProgramImportSql(plan);
  if (!sql) { console.log("All Programs are unchanged; D1 was not changed."); return { plan, checksum, changed: false }; }
  const temp = mkdtempSync(path.join(tmpdir(), "naranerdem-private-program-import-"));
  const sqlPath = path.join(temp, "private-program-import.sql");
  try {
    writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    executeRemoteD1File(options.environment, sqlPath);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const afterRows = queryRemoteD1(options.environment, PRIVATE_PROGRAM_ROWS_QUERY);
  const afterPlan = buildPrivateProgramImportPlan(bundle, afterRows);
  if (afterPlan.some((entry) => entry.action !== "unchanged")) throw new Error("Private Program import completed but verification did not match the reviewed bundle.");
  console.log(`Private Program import verified from ${absolute}.`);
  return { plan, checksum, changed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runImport(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
