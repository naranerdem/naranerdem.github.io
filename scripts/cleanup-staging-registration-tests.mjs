import { spawnSync } from "node:child_process";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const runArgument = process.argv.slice(2).find((value) => value.startsWith("--test-run-id="));
const testRunId = runArgument?.slice("--test-run-id=".length) ?? "";
const confirmed = args.has("--confirm");

if (!/^registration:[0-9a-f-]{36}$/.test(testRunId)) {
  throw new Error("Use --test-run-id=registration:<draft-uuid> to scope cleanup to one staging test registration.");
}
if (args.has("--env=production") || args.has("--production")) {
  throw new Error("This cleanup command refuses production.");
}

const wrangler = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
const countSql = `
SELECT
  (SELECT COUNT(*) FROM registration_draft WHERE is_test = 1 AND test_run_id = '${testRunId}') AS drafts,
  (SELECT COUNT(*) FROM outbound_email WHERE is_test = 1 AND test_run_id = '${testRunId}') AS emails;
`;
const count = spawnSync(process.execPath, [
  wrangler, "d1", "execute", "DB", "--env", "staging", "--remote", "--command", countSql,
], { encoding: "utf8", stdio: confirmed ? "pipe" : "inherit" });
if (count.status !== 0) process.exit(count.status ?? 1);

if (!confirmed) {
  console.log("Dry run only. Add --confirm to delete this exact staging test run.");
  process.exit(0);
}

process.stdout.write(count.stdout);
const deleteSql = `
DELETE FROM registration_draft WHERE is_test = 1 AND test_run_id = '${testRunId}';
DELETE FROM outbound_email WHERE is_test = 1 AND test_run_id = '${testRunId}' AND registration_draft_id IS NULL;
`;
const cleanup = spawnSync(process.execPath, [
  wrangler, "d1", "execute", "DB", "--env", "staging", "--remote", "--command", deleteSql,
], { encoding: "utf8", stdio: "inherit" });
if (cleanup.status !== 0) process.exit(cleanup.status ?? 1);
console.log(`Deleted staging test registration ${testRunId}.`);
