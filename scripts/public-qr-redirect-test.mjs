import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-public-qr-"));
const databasePath = path.join(tempDir, "public-qr.sqlite3");
const workerPath = path.join(tempDir, "worker.mjs");
const settingsPath = path.join(tempDir, "settings.mjs");

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
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}

const database = new SqliteD1();
const env = {
  APP_ENV: "staging",
  REGISTRATION_WRITE_ENABLED: "false",
  APP_ORIGIN: "https://naranerdem.com",
  EMAIL_ENABLED: "false",
  AUTH_EMAIL_ENABLED: "false",
  STAFF_AUTH_EMAIL_ENABLED: "false",
  EMAIL_FROM: "Наран Эрдэм <burtgel@mail.naranerdem.com>",
  DB: database,
};
const actor = (role) => ({
  staffAccountId: `${role}-staff`, displayName: role, roles: [role],
  capabilities: role === "admin" ? ["admin.settings.manage"] : role === "teacher" ? ["calendar.manage"] : ["payment.manage"],
  sessionId: "test", sessionExpiresAt: "2030-01-01T00:00:00.000Z", sessionAbsoluteExpiresAt: "2030-01-01T00:00:00.000Z",
});

try {
  const migrations = readdirSync("migrations").filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().map((name) => readFileSync(path.join("migrations", name), "utf8")).join("\n");
  sqlite(migrations);
  const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");
  for (const [source, target] of [["src/worker.ts", workerPath], ["src/server/public-qr-redirects.ts", settingsPath]]) {
    const bundled = spawnSync(esbuild, [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${target}`], { encoding: "utf8" });
    if (bundled.status !== 0) throw new Error(bundled.stderr);
  }
  const worker = (await import(`${pathToFileURL(workerPath).href}?worker`)).default;
  const settings = await import(`${pathToFileURL(settingsPath).href}?settings`);
  const request = (path) => worker.fetch(new Request(`https://naranerdem.com${path}`), env);

  const defaultN = await request("/qr/n");
  assert.equal(defaultN.status, 302);
  assert.equal(defaultN.headers.get("location"), "https://www.facebook.com/naran.erdem.lab");
  assert.equal(defaultN.headers.get("cache-control"), "no-store");
  const defaultT = await request("/qr/t");
  assert.equal(defaultT.status, 302);
  assert.equal(defaultT.headers.get("location"), "https://www.facebook.com/tsenegle");
  assert.equal(defaultT.headers.get("cache-control"), "no-store");
  assert.equal((await request("/qr/other")).status, 404);

  const beforeSave = await settings.getPublicQrRedirectSettings(env);
  assert.equal(beforeSave.updatedAt, null, "default destinations work before an override row exists");
  await settings.updatePublicQrRedirectSettings(env, actor("admin"), {
    nDestinationUrl: "https://www.facebook.com/naran.erdem.updated",
    tDestinationUrl: "https://www.facebook.com/tsenegle",
    expectedUpdatedAt: beforeSave.updatedAt,
  });
  const overridden = await request("/qr/n");
  assert.equal(overridden.status, 302);
  assert.equal(overridden.headers.get("location"), "https://www.facebook.com/naran.erdem.updated");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM audit_event WHERE action = 'public_qr_redirect_settings_changed'")[0].count, 1, "admin updates are audited");

  const saved = await settings.getPublicQrRedirectSettings(env);
  await assert.rejects(settings.updatePublicQrRedirectSettings(env, actor("admin"), {
    nDestinationUrl: "http://example.test/not-secure", tDestinationUrl: saved.tDestinationUrl, expectedUpdatedAt: saved.updatedAt,
  }), /Public QR redirect settings/);
  await assert.rejects(settings.updatePublicQrRedirectSettings(env, actor("admin"), {
    nDestinationUrl: "https://naranerdem.com/qr/n", tDestinationUrl: saved.tDestinationUrl, expectedUpdatedAt: saved.updatedAt,
  }), /Public QR redirect settings/);
  await assert.rejects(settings.updatePublicQrRedirectSettings(env, actor("admin"), {
    nDestinationUrl: saved.nDestinationUrl, tDestinationUrl: "https://naranerdem.com/qr/t", expectedUpdatedAt: saved.updatedAt,
  }), /Public QR redirect settings/);
  await assert.rejects(settings.updatePublicQrRedirectSettings(env, actor("teacher"), {
    nDestinationUrl: saved.nDestinationUrl, tDestinationUrl: saved.tDestinationUrl, expectedUpdatedAt: saved.updatedAt,
  }), /Public QR redirect settings/);
  await assert.rejects(settings.updatePublicQrRedirectSettings(env, actor("accountant"), {
    nDestinationUrl: saved.nDestinationUrl, tDestinationUrl: saved.tDestinationUrl, expectedUpdatedAt: saved.updatedAt,
  }), /Public QR redirect settings/);
  const fallback = await settings.getPublicQrRedirectSettings({ ...env, DB: { prepare() { throw new Error("temporary D1 failure"); } } });
  assert.deepEqual(fallback, { nDestinationUrl: "https://www.facebook.com/naran.erdem.lab", tDestinationUrl: "https://www.facebook.com/tsenegle", updatedAt: null });
  console.log("ok public QR redirects, typed admin settings, validation, fallback, and audit");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
