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
    stageCode: options.stageCode ?? "stage_1",
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
    oneTimeAmountMnt: options.oneTimeAmountMnt ?? 850000,
    twoInstallmentEnabled: options.twoInstallmentEnabled ?? 1,
    firstInstallmentAmountMnt: options.firstInstallmentAmountMnt ?? 450000,
    secondInstallmentAmountMnt: options.secondInstallmentAmountMnt ?? 450000,
    secondInstallmentDueOn: options.secondInstallmentDueOn ?? "2026-11-01",
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
          if (sql.includes("FROM class_calendar")) {
            if (options.calendarError) throw new Error("SQLITE_ERROR: no such table: class_calendar");
            assert.match(sql, /class_calendar_revision\.status = 'published'/);
            assert.match(sql, /class_calendar_slot\.class_calendar_revision_id/);
            const productionQuery = sql.includes("class_calendar\.is_test = 0");
            const calendarRows = options.calendarRows ?? [];
            const filtered = productionQuery
              ? calendarRows.filter((row) => row.isTest === 0)
              : calendarRows;
            if (productionQuery) {
              assert.match(sql, /class_session\.is_test_only = 0/);
            }
            assert.doesNotMatch(sql, /curriculum_(program|lesson)/, "public calendar query does not join private curriculum tables");
            assert.deepEqual(bindings, []);
            return { success: true, results: filtered };
          }
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

function calendarRow(id, options = {}) {
  return {
    academicYearId: "calendar-year",
    academicYearLabel: "Туршилтын хичээлийн жил",
    calendarId: options.calendarId ?? "calendar-stage-2-sunday",
    classSessionId: options.classSessionId ?? "calendar-class-sunday",
    classLabel: "Ням гараг 10:00",
    stageCode: "stage_2",
    weekday: "Ням",
    startTime: "10:00",
    endTime: "11:20",
    timezone: "Asia/Ulaanbaatar",
    revisionNumber: 1,
    slotId: id,
    localDate: options.localDate ?? "2026-10-04",
    slotStartTime: options.slotStartTime ?? "10:00",
    slotEndTime: options.slotEndTime ?? "11:20",
    slotStatus: options.slotStatus ?? "scheduled",
    lessonSequence: Object.hasOwn(options, "lessonSequence") ? options.lessonSequence : 1,
    lessonTitle: Object.hasOwn(options, "lessonTitle") ? options.lessonTitle : "Туршилтын хичээл 01",
    cancelledLessonSequence: options.cancelledLessonSequence ?? null,
    cancelledLessonTitle: options.cancelledLessonTitle ?? null,
    reasonLabel: options.reasonLabel ?? null,
    isTest: options.isTest ?? 1,
    internalNote: "must never be selected by the API",
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
      catalogRow("staging-closed", { isTest: 1, isTestOnly: 1, status: "closed", displayLabel: "old manual name" }),
    ], {
      calendarRows: [
        calendarRow("calendar-staging-lesson-1"),
        calendarRow("calendar-staging-no-class", {
          localDate: "2026-10-11",
          slotStatus: "no_class",
          lessonSequence: null,
          lessonTitle: null,
          reasonLabel: "Туршилтын завсарлага",
        }),
      ],
    }),
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
      ["staging-closed", 10, 0, "unavailable"],
    ],
  );
  assert.equal(stagingCatalog.body.academicYears[0].classSessions.find((session) => session.id === "staging-closed").label, "1-р шат · Бямба 10:00", "public catalog uses the generated class label, not legacy stored wording");
  assert.deepEqual(stagingCatalog.body.academicYears[0].classSessions.find((session) => session.id === "staging-many-seats").paymentOptions,
    [{ code: "single", totalAmountMnt: 850000, initialAmountMnt: 850000 }, { code: "two_installment", totalAmountMnt: 900000, initialAmountMnt: 450000, secondAmountMnt: 450000, secondDueOn: "2026-11-01" }],
    "public catalog exposes only the configured course payment terms");
  assert.doesNotMatch(JSON.stringify(stagingCatalog.body), /account_number|accountNumber|bankName/i, "public catalog never exposes bank-transfer instructions");

  const stagingCalendar = await jsonResponse(stagingWorker, "/api/calendar/published", stagingEnv);
  assert.equal(stagingCalendar.response.status, 200);
  assert.equal(stagingCalendar.body.calendars.length, 1);
  assert.deepEqual(stagingCalendar.body.calendars[0].entries.map((entry) => [entry.status, entry.reasonLabel]), [
    ["scheduled", null],
    ["no_class", "Туршилтын завсарлага"],
  ]);
  assert.doesNotMatch(JSON.stringify(stagingCalendar.body), /lesson(Number|Title|Sequence)|cancelledLesson|internalNote|must never/i, "calendar API does not expose curriculum or private fields");
  assert.equal(stagingCalendar.body.calendars[0].classSession.label, "2-р шат · Ням 10:00", "published schedules use the generated class label");

  const productionWorker = (await bundleWorker("production", "production")).default;
  const productionEnv = {
    APP_ENV: "production",
    REGISTRATION_WRITE_ENABLED: "false",
    DB: createDatabase([
      catalogRow("production-public-session", { confirmedCount: 3, activeHoldCount: 2 }),
      catalogRow("production-test-session", { isTest: 1, isTestOnly: 1, confirmedCount: 10 }),
    ], {
      calendarRows: [calendarRow("production-test-calendar", { isTest: 1 })],
    }),
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

  const productionCalendar = await jsonResponse(productionWorker, "/api/calendar/published", productionEnv);
  assert.deepEqual(productionCalendar.body, { calendars: [] }, "production safely returns an empty unconfigured schedule");

  const calendarMethod = await jsonResponse(productionWorker, "/api/calendar/published", productionEnv, { method: "POST" });
  assert.equal(calendarMethod.response.status, 405);
  assert.equal(calendarMethod.response.headers.get("allow"), "GET");

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

  const failedCalendar = await jsonResponse(
    productionWorker,
    "/api/calendar/published",
    { ...productionEnv, DB: createDatabase([], { calendarError: true }) },
  );
  assert.equal(failedCalendar.response.status, 500);
  assert.equal(failedCalendar.body.error.code, "internal_error");
  assert.doesNotMatch(JSON.stringify(failedCalendar.body), /SQLITE|class_calendar|no such table/i);

  console.log("ok Worker API bundle tests");
} finally {
  rmSync(bundleDir, { recursive: true, force: true });
}
