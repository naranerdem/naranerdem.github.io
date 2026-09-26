import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const worker = readFileSync("src/worker.ts", "utf8");
const environment = readFileSync("src/server/env.ts", "utf8");
const wrangler = readFileSync("wrangler.jsonc", "utf8");
const directory = mkdtempSync(path.join(tmpdir(), "naranerdem-scheduled-dispatch-"));
const bundle = path.join(directory, "scheduled-work.mjs");

try {
  assert.match(worker, /scheduled\(controller: WorkerScheduledController, env: WorkerEnv, context: WorkerExecutionContext\)/);
  assert.match(worker, /runScheduledWork\(controller\.cron, env, now\)/);
  assert.doesNotMatch(worker, /Promise\.allSettled/);
  assert.match(environment, /WorkerScheduledController \{[\s\S]*cron: string/);
  const build = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/scheduled-work.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
  const { SCHEDULED_CRONS, scheduledRecoverySlice, scheduledWorkKind } = await import(pathToFileURL(bundle).href);
  for (const [kind, cron] of Object.entries(SCHEDULED_CRONS)) {
    assert.equal(scheduledWorkKind(cron), kind, `${kind} cron routes to exactly one isolated scheduled task`);
    assert.match(wrangler, new RegExp(cron.replaceAll("*", "\\*").replaceAll(",", ",")), `${kind} cron is deployed`);
  }
  assert.equal(scheduledWorkKind("*/1 * * * *"), null, "the legacy combined scheduler expression no longer dispatches work");
  assert.deepEqual([
    scheduledRecoverySlice(new Date("2026-09-20T00:04:00.000Z")),
    scheduledRecoverySlice(new Date("2026-09-20T01:04:00.000Z")),
    scheduledRecoverySlice(new Date("2026-09-20T02:04:00.000Z")),
    scheduledRecoverySlice(new Date("2026-09-20T03:04:00.000Z")),
  ], ["conditional", "outstanding", "stranded", "additional_admission"], "hourly historical recovery rotates one durable slice at a time");
  console.log("ok isolated scheduled dispatch and bounded recovery rotation");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
