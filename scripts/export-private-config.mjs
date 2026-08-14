import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PRIVATE_CONFIG_DIRECTORY,
  PRIVATE_PROGRAM_ROWS_QUERY,
  createPrivateConfigBundle,
  privateBundleText,
  programPlanSummary,
  sha256,
} from "./private-program-config.mjs";
import { parseOptions, queryRemoteD1 } from "./private-config-cli.mjs";

function compactTimestamp(value) {
  return value.replaceAll(/[-:.]/g, "");
}

function ignoredOutputPath(output) {
  const relative = path.relative(process.cwd(), output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Private exports must remain inside this repository's ignored private directory.");
  const check = spawnSync("git", ["check-ignore", "--quiet", "--no-index", relative]);
  if (check.status !== 0) throw new Error(`Refusing to write private data because ${relative} is not ignored by Git.`);
}

export function runExport(args = process.argv.slice(2), now = new Date()) {
  const options = parseOptions(args);
  if (options.file) throw new Error("Export does not accept --file.");
  const exportedAt = now.toISOString();
  const output = path.resolve(options.output || path.join(PRIVATE_CONFIG_DIRECTORY, `naran-erdem-${options.environment}-${compactTimestamp(exportedAt)}.json`));
  ignoredOutputPath(output);
  ignoredOutputPath(`${output}.sha256`);
  const rows = queryRemoteD1(options.environment, PRIVATE_PROGRAM_ROWS_QUERY);
  const bundle = createPrivateConfigBundle(rows, options.environment, exportedAt);
  const text = privateBundleText(bundle);
  const checksum = sha256(text);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, text, { encoding: "utf8", mode: 0o600 });
  writeFileSync(`${output}.sha256`, `${checksum}  ${path.basename(output)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Private Program bundle: ${output}`);
  console.log(`Schema version: ${bundle.schema_version}`);
  console.log(`Programs: ${bundle.programs.length}; working drafts exported: 0`);
  for (const entry of programPlanSummary(bundle.programs.map((program) => ({ action: "exported", program })))) {
    console.log(`${entry.identity}: ${entry.lessons} lessons`);
  }
  console.log(`SHA-256: ${checksum}`);
  return { output, checksum, bundle };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runExport(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
