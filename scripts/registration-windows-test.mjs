import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-registration-windows-"));
const databasePath = path.join(tempDir, "windows.sqlite3");
const bundlePath = path.join(tempDir, "registration-windows.mjs");

function sqlValue(value) { return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
function bindSql(sql, values) { let index = 0; const bound = sql.replaceAll("?", () => sqlValue(values[index++])); assert.equal(index, values.length); return bound; }
function sqlite(input, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], { input: `.timeout 5000\nPRAGMA foreign_keys=ON;\n${input}`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stderr}\n${input}`);
  return result.stdout.trim();
}
class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.sql, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.sql, this.values) }; }
  async run() { const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values); return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } }; }
}
class SqliteD1 {
  prepare(sql) { return new Statement(this, sql); }
  query(sql, values = []) { const output = sqlite(`${bindSql(sql, values)};`, true); return output ? JSON.parse(output) : []; }
  async batch(statements) {
    const output = sqlite(`CREATE TEMP TABLE _changes (idx INTEGER, changes INTEGER); BEGIN IMMEDIATE;\n${statements.map((statement, index) => `${bindSql(statement.sql, statement.values)}; INSERT INTO _changes VALUES (${index}, changes());`).join("\n")}\nCOMMIT; SELECT * FROM _changes ORDER BY idx;`, true);
    return (output ? JSON.parse(output) : []).map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } }));
  }
}

const now = "2026-08-15T04:00:00.000Z";
const actor = { staffAccountId: "teacher", displayName: "Тест Багш", roles: ["teacher"], capabilities: ["registration.manage"], sessionId: "test", sessionExpiresAt: now, sessionAbsoluteExpiresAt: now };
const env = (DB) => ({ APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "true", EMAIL_ENABLED: "true", AUTH_EMAIL_ENABLED: "true", STAFF_AUTH_EMAIL_ENABLED: "true", APP_ORIGIN: "https://staging.example.test", EMAIL_FROM: "test@example.test", DB });

try {
  const migrations = readdirSync("migrations").filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().map((name) => readFileSync(path.join("migrations", name), "utf8")).join("\n");
  sqlite(migrations);
  const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");
  const bundled = spawnSync(esbuild, ["src/server/services/registration-windows.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" });
  if (bundled.status !== 0) throw new Error(bundled.stderr);
  const { activeWindowForOfferingSql, getRegistrationWindowOverview, mongoliaCivilDate, registrationWindowState, saveRegistrationWindow, deleteRegistrationWindow } = await import(pathToFileURL(bundlePath).href);
  const database = new SqliteD1();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year', 'Тест жил', 'open', '2026-01-01', '2026-12-31', 1, 1, 'windows-test', ?, ?);`, [now, now]);
  for (const [id, stage] of [["offering-1", "stage_1"], ["offering-2", "stage_2"], ["offering-3", "stage_3"]]) {
    database.query(`INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, 'annual_course', ?, 'year', ?, 1, 'paid', 'active', 1, 'windows-test', ?, ?)`, [id, id, stage, now, now]);
  }
  database.query(`INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('offering-new', 'summer_course', 'offering-new', 'year', NULL, 0, 'paid', 'active', 1, 'windows-test', ?, ?)`, [now, now]);

  await saveRegistrationWindow(env(database), actor, { name: "Жилийн бүртгэл", startsOn: "2026-08-15", endsOn: "2026-08-20", offeringIds: ["offering-1", "offering-2", "offering-3"] }, "2026-08-14");
  let overview = await getRegistrationWindowOverview(env(database), "2026-08-15");
  const annual = overview.windows[0];
  assert.equal(annual.state, "active", "start and end dates are inclusive");
  assert.deepEqual(new Set(annual.offeringIds), new Set(["offering-1", "offering-2", "offering-3"]), "one window explicitly covers all three stages");
  assert.ok(!annual.offeringIds.includes("offering-new"), "a later Offering is never attached implicitly");
  assert.equal(registrationWindowState({ startsOn: "2026-08-15", endsOn: "2026-08-15" }, "2026-08-15"), "active");
  assert.equal(mongoliaCivilDate(new Date("2026-08-14T16:30:00.000Z")), "2026-08-15", "Mongolia civil dates use Asia/Ulaanbaatar");

  await saveRegistrationWindow(env(database), actor, { name: "Дахин нээх", startsOn: "2026-09-01", endsOn: "2026-09-05", offeringIds: ["offering-1", "offering-3"] }, "2026-08-14");
  overview = await getRegistrationWindowOverview(env(database), "2026-09-02");
  assert.equal(overview.windows.find((entry) => entry.name === "Жилийн бүртгэл").state, "past");
  assert.equal(overview.windows.find((entry) => entry.name === "Дахин нээх").state, "active", "historical and reopening windows coexist");
  const predicate = activeWindowForOfferingSql("'offering-1'");
  assert.equal(database.query(`SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS open`, ["2026-09-02", "2026-09-02"])[0].open, 1, "reopened Offering is active");
  assert.equal(database.query(`SELECT CASE WHEN ${activeWindowForOfferingSql("'offering-2'")} THEN 1 ELSE 0 END AS open`, ["2026-09-02", "2026-09-02"])[0].open, 0, "omitted Offering is closed after the first window ends");

  const beforeDelete = await getRegistrationWindowOverview(env(database), "2026-08-14");
  const future = beforeDelete.windows.find((entry) => entry.name === "Дахин нээх");
  await deleteRegistrationWindow(env(database), actor, { id: future.id, expectedUpdatedAt: future.updatedAt }, "2026-08-14");
  assert.equal((await getRegistrationWindowOverview(env(database), "2026-08-14")).windows.some((entry) => entry.id === future.id), false, "future windows are deletable");
  await assert.rejects(deleteRegistrationWindow(env(database), actor, { id: annual.id, expectedUpdatedAt: annual.updatedAt }, "2026-08-15"), /Registration window/, "active windows are retained");
  await assert.rejects(saveRegistrationWindow(env(database), { ...actor, capabilities: [] }, { name: "x", startsOn: "2026-08-16", endsOn: "2026-08-17", offeringIds: ["offering-1"] }), /Registration window/, "accountants cannot manage windows");
  console.log("ok registration window membership, local-date state, reopening, and staff permissions");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
