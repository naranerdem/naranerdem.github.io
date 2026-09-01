import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeRemoteD1File, parseOptions, queryRemoteD1 } from "./private-config-cli.mjs";
import { requireProductionConfirmation } from "./private-program-config.mjs";
import { buildPrivateOperationalConfigImportPlan, buildPrivateOperationalConfigImportSql, operationalConfigPlanSummary, sha256, validatePrivateOperationalConfigBundle } from "./private-operational-config.mjs";

function bundleFromFile(file) { if (!file) throw new Error("Use --file=<private-bundle.json>."); const text = readFileSync(path.resolve(file), "utf8"); const bundle = JSON.parse(text); validatePrivateOperationalConfigBundle(bundle); return { text, bundle }; }
function target(environment) {
  return {
    centerInformation: queryRemoteD1(environment, "SELECT phone, public_email, facebook_page_url, physical_address, homepage_intro, about_center_text, teacher_bio, updated_at FROM public_center_information WHERE singleton = 1")[0],
    paymentCollection: queryRemoteD1(environment, "SELECT bank_name, account_holder_name, account_number, iban, transfer_instruction, updated_at FROM payment_collection_settings WHERE singleton = 1")[0],
    courseRules: queryRemoteD1(environment, "SELECT document.id, document.code, document.title, document.updated_at, version.body_hash FROM course_rule_document document JOIN course_rule_version version ON version.id = document.current_version_id WHERE document.code IN ('guardian', 'student') ORDER BY document.code"),
  };
}

export function runImport(args = process.argv.slice(2)) {
  const options = parseOptions(args, ["--dry-run", "--confirm-production"]); const { text, bundle } = bundleFromFile(options.file); const checksum = sha256(text);
  const before = target(options.environment); const plan = buildPrivateOperationalConfigImportPlan(bundle, before); const summary = operationalConfigPlanSummary(plan);
  console.log(`Target: ${options.environment}`); console.log(`Bundle SHA-256: ${checksum}`); console.log(`Center information: ${summary.centerInformation}; payment collection: ${summary.paymentCollection}; rules: ${summary.courseRules.map((entry) => `${entry.code} ${entry.action}`).join(", ")}`);
  requireProductionConfirmation(options.environment, Boolean(options.dry_run), Boolean(options.confirm_production));
  if (options.dry_run) { console.log("Dry run only; D1 was not changed."); return { plan, checksum, changed: false }; }
  const sql = buildPrivateOperationalConfigImportSql(plan); if (!sql) { console.log("All operational configuration is unchanged; D1 was not changed."); return { plan, checksum, changed: false }; }
  const directory = mkdtempSync(path.join(tmpdir(), "naranerdem-private-operational-import-")); const sqlPath = path.join(directory, "operational.sql");
  try { writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 }); executeRemoteD1File(options.environment, sqlPath); } finally { rmSync(directory, { recursive: true, force: true }); }
  const afterPlan = buildPrivateOperationalConfigImportPlan(bundle, target(options.environment));
  if (buildPrivateOperationalConfigImportSql(afterPlan)) throw new Error("Private operational import completed but verification did not match the reviewed bundle.");
  console.log("Private operational configuration import verified."); return { plan, checksum, changed: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { try { runImport(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
