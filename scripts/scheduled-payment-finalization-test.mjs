import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync("src/worker.ts", "utf8");
const environment = readFileSync("src/server/env.ts", "utf8");

assert.match(worker, /scheduled\(controller: WorkerScheduledController, env: WorkerEnv, context: WorkerExecutionContext\)/);
assert.match(worker, /context\.waitUntil\(finalizeDuePaymentConfirmations\(env, new Date\(controller\.scheduledTime\)\)\)/);
assert.doesNotMatch(worker, /controller\.waitUntil/);
assert.doesNotMatch(environment, /WorkerScheduledController \{[\s\S]*waitUntil/);

console.log("ok scheduled payment finalization contract");
