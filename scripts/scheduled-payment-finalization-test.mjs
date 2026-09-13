import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync("src/worker.ts", "utf8");
const environment = readFileSync("src/server/env.ts", "utf8");

assert.match(worker, /scheduled\(controller: WorkerScheduledController, env: WorkerEnv, context: WorkerExecutionContext\)/);
assert.match(worker, /context\.waitUntil\(Promise\.allSettled\(\[/);
assert.match(worker, /finalizeDuePaymentConfirmations\(env, now\)/);
assert.match(worker, /processDuePaymentReminders\(env, now\)/);
assert.match(worker, /reconcileInternalEnrollmentConfirmationNotices\(env, now\)/,
  "only already-durable capability-free internal enrollment notices receive scheduled recovery");
assert.doesNotMatch(worker, /controller\.waitUntil/);
assert.doesNotMatch(environment, /WorkerScheduledController \{[\s\S]*waitUntil/);

console.log("ok scheduled payment finalization contract");
