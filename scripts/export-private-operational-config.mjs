import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PRIVATE_CONFIG_DIRECTORY } from "./private-program-config.mjs";
import { parseOptions, queryRemoteD1 } from "./private-config-cli.mjs";
import { createPrivateOperationalConfigBundle, privateOperationalConfigText, sha256 } from "./private-operational-config.mjs";

function ignoredOutputPath(output) {
  const relative = path.relative(process.cwd(), output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Private exports must remain inside this repository's ignored private directory.");
  if (spawnSync("git", ["check-ignore", "--quiet", "--no-index", relative]).status !== 0) throw new Error("Refusing to write private data because the output is not ignored by Git.");
}
function compactTimestamp(value) { return value.replaceAll(/[-:.]/g, ""); }

export function runExport(args = process.argv.slice(2)) {
  const options = parseOptions(args); if (options.file) throw new Error("Export does not accept --file.");
  const centerInformation = queryRemoteD1(options.environment, "SELECT phone, public_email, facebook_page_url, physical_address, homepage_intro, about_center_text, teacher_bio FROM public_center_information WHERE singleton = 1")[0];
  const paymentCollection = queryRemoteD1(options.environment, "SELECT bank_name, account_holder_name, account_number, iban, transfer_instruction FROM payment_collection_settings WHERE singleton = 1")[0];
  const courseRules = queryRemoteD1(options.environment, "SELECT document.code, document.title, version.body_text, version.body_hash FROM course_rule_document document JOIN course_rule_version version ON version.id = document.current_version_id WHERE document.code IN ('guardian', 'student') ORDER BY document.code");
  const exportedAt = new Date().toISOString(); const bundle = createPrivateOperationalConfigBundle({ centerInformation, courseRules, paymentCollection }, options.environment, exportedAt);
  const output = path.resolve(options.output || path.join(PRIVATE_CONFIG_DIRECTORY, `naran-erdem-${options.environment}-operational-${compactTimestamp(exportedAt)}.json`));
  ignoredOutputPath(output); ignoredOutputPath(`${output}.sha256`);
  const text = privateOperationalConfigText(bundle); const checksum = sha256(text);
  mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, text, { encoding: "utf8", mode: 0o600 }); writeFileSync(`${output}.sha256`, `${checksum}  ${path.basename(output)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Private operational configuration: ${output}`); console.log("Center information: 1; course rules: 2; payment collection: 1"); console.log(`SHA-256: ${checksum}`);
  return { output, checksum, bundle };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { try { runExport(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
