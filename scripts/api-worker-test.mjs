import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const wranglerCli = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
const bundleDir = mkdtempSync(path.join(tmpdir(), "naranerdem-worker-test-"));

function bundleWorker(name, environment) {
  const outputDir = path.join(bundleDir, name);
  const args = [wranglerCli, "deploy", "--dry-run", "--outdir", outputDir];
  if (environment === "production") {
    args.push("--env=");
  } else {
    args.push("--env", "staging");
  }

  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Worker bundle failed for ${environment}\n${result.stdout}\n${result.stderr}`);
  }

  const modulePath = path.join(outputDir, "worker.mjs");
  cpSync(path.join(outputDir, "worker.js"), modulePath);
  return import(`${pathToFileURL(modulePath).href}?cache=${Date.now()}`);
}

function catalogRow(id, options = {}) {
  const capacity = options.capacity ?? 10;
  const confirmedCount = options.confirmedCount ?? 0;
  const activeHoldCount = options.activeHoldCount ?? 0;
  const remainingSeats = Math.max(capacity - confirmedCount - activeHoldCount, 0);
  return {
    academicYearId: options.academicYearId ?? "year-test",
    academicYearLabel: options.academicYearLabel ?? "Туршилтын хичээлийн жил",
    classSessionId: id,
    stageCode: "stage_1",
    displayLabel: options.displayLabel ?? id,
    weekday: "Бямба",
    startTime: "10:00",
    endTime: "11:20",
    capacity,
    confirmedCount,
    activeHoldCount,
    remainingSeats,
    publicAvailability: options.status === "closed"
      ? "unavailable"
      : remainingSeats > 0 ? "available" : "full",
    status: options.status ?? "available",
    isTest: options.isTest ?? 0,
    isTestOnly: options.isTestOnly ?? 0,
  };
}

function createDatabase(rows, options = {}) {
  return {
    prepare(sql) {
      let bindings = [];
      const statement = {
        bind(...values) {
          bindings = values;
          return statement;
        },
        async first() {
          if (options.healthError) throw new Error("SQLITE_ERROR: health failure");
          assert.equal(sql.trim(), "SELECT 1 AS ok");
          assert.deepEqual(bindings, []);
          return { ok: 1 };
        },
        async all() {
          if (options.catalogError) throw new Error("SQLITE_ERROR: no such table: class_session");
          assert.match(sql, /academic_year\.registration_status = \?/);
          assert.match(sql, /enrollment\.status = 'confirmed'/);
          assert.match(sql, /enrollment\.status = 'awaiting_initial_payment'/);
          assert.match(sql, /enrollment\.effective_hold_deadline_at > \?/);
          assert.match(sql, /registration_capacity_hold/);
          assert.match(sql, /COALESCE\(draft_holds\.count, 0\)/);

          const productionQuery = sql.includes("class_session.is_test_only = ?");
          const filtered = productionQuery
            ? rows.filter((row) => row.isTest === 0 && row.isTestOnly === 0)
            : rows;

          assert.match(bindings[0], /^\d{4}-\d{2}-\d{2}T/);
          assert.match(bindings[1], /^\d{4}-\d{2}-\d{2}T/);
          assert.deepEqual(bindings.slice(2), productionQuery ? ["open", 0, 0, 0] : ["open"]);
          if (productionQuery) assert.match(sql, /enrollment\.is_test = 0/);
          return { success: true, results: filtered };
        },
      };
      return statement;
    },
  };
}

async function jsonResponse(handler, path, env, init) {
  const response = await handler.fetch(new Request(`https://example.test${path}`, init), env);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  return { response, body: await response.json() };
}

try {
  assert.ok(existsSync("dist/index.html"), "homepage static asset was built");
  assert.ok(existsSync("dist/register/index.html"), "registration static asset was built");
  assert.ok(existsSync("dist/images/naran-erdem-logo.jpg"), "logo static asset was built");

  const stagingWorker = (await bundleWorker("staging", "staging")).default;
  const stagingEnv = {
    APP_ENV: "staging",
    REGISTRATION_WRITE_ENABLED: "false",
    DB: createDatabase([
      catalogRow("staging-many-seats", { isTest: 1, isTestOnly: 1, confirmedCount: 2, activeHoldCount: 1 }),
      catalogRow("staging-nearly-full", { isTest: 1, isTestOnly: 1, confirmedCount: 8, activeHoldCount: 1 }),
      catalogRow("staging-full-firm", { isTest: 1, isTestOnly: 1, confirmedCount: 10 }),
      catalogRow("staging-full-limbo", { isTest: 1, isTestOnly: 1, confirmedCount: 8, activeHoldCount: 2 }),
    ]),
  };
  const stagingHealth = await jsonResponse(stagingWorker, "/api/health", stagingEnv);
  assert.equal(stagingHealth.response.status, 200);
  assert.deepEqual(stagingHealth.body, { ok: true, environment: "staging" });

  const stagingCatalog = await jsonResponse(stagingWorker, "/api/registration/catalog", stagingEnv);
  assert.equal(stagingCatalog.response.status, 200);
  assert.deepEqual(
    stagingCatalog.body.academicYears[0].classSessions.map((session) => [
      session.id,
      session.remainingSeats,
      session.activeHoldCount,
      session.availability,
    ]),
    [
      ["staging-many-seats", 7, 1, "available"],
      ["staging-nearly-full", 1, 1, "available"],
      ["staging-full-firm", 0, 0, "full"],
      ["staging-full-limbo", 0, 2, "full"],
    ],
  );

  const productionWorker = (await bundleWorker("production", "production")).default;
  const productionEnv = {
    APP_ENV: "production",
    REGISTRATION_WRITE_ENABLED: "false",
    DB: createDatabase([
      catalogRow("production-public-session", { confirmedCount: 3, activeHoldCount: 2 }),
      catalogRow("production-test-session", { isTest: 1, isTestOnly: 1, confirmedCount: 10 }),
    ]),
  };
  const productionHealth = await jsonResponse(productionWorker, "/api/health", productionEnv);
  assert.equal(productionHealth.response.status, 200);
  assert.deepEqual(productionHealth.body, { ok: true, environment: "production" });

  const productionCatalog = await jsonResponse(productionWorker, "/api/registration/catalog", productionEnv);
  assert.equal(productionCatalog.response.status, 200);
  assert.deepEqual(
    productionCatalog.body.academicYears[0].classSessions.map((session) => [session.id, session.remainingSeats, session.activeHoldCount]),
    [["production-public-session", 5, 2]],
  );

  const method = await jsonResponse(productionWorker, "/api/health", productionEnv, { method: "POST" });
  assert.equal(method.response.status, 405);
  assert.equal(method.body.error.code, "method_not_allowed");
  assert.equal(method.response.headers.get("allow"), "GET");

  const unknown = await jsonResponse(productionWorker, "/api/unknown", productionEnv);
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error.code, "not_found");

  const write = await jsonResponse(productionWorker, "/api/pre-registrations", productionEnv, { method: "POST" });
  assert.equal(write.response.status, 404);
  assert.equal(write.body.error.code, "not_found");

  const productionRegistrationWrite = await jsonResponse(
    productionWorker,
    "/api/registration/submit",
    productionEnv,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  assert.equal(productionRegistrationWrite.response.status, 404);
  const productionConfig = await jsonResponse(productionWorker, "/api/registration/config", productionEnv);
  assert.deepEqual(productionConfig.body, {
    environment: "production",
    writeEnabled: false,
    turnstileSiteKey: null,
  });

  const failedCatalog = await jsonResponse(
    productionWorker,
    "/api/registration/catalog",
    { ...productionEnv, DB: createDatabase([], { catalogError: true }) },
  );
  assert.equal(failedCatalog.response.status, 500);
  assert.equal(failedCatalog.body.error.code, "internal_error");
  assert.doesNotMatch(JSON.stringify(failedCatalog.body), /SQLITE|class_session|no such table/i);

  console.log("ok Worker API bundle tests");
} finally {
  rmSync(bundleDir, { recursive: true, force: true });
}
