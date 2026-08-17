import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-public-content-"));
const databasePath = path.join(tempDir, "content.sqlite3"); const bundlePath = path.join(tempDir, "content.mjs");
function quote(value) { return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
function bindSql(sql, values) { let index = 0; const bound = sql.replaceAll("?", () => quote(values[index++])); assert.equal(index, values.length); return bound; }
function sqlite(input, json = false) { const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], { input: `PRAGMA foreign_keys=ON;\n${input}`, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
class Statement { constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; } bind(...values) { this.values = values; return this; } async first() { return this.database.query(this.sql, this.values)[0] ?? null; } async all() { return { success: true, results: this.database.query(this.sql, this.values) }; } async run() { const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values); return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } }; } }
class Database { prepare(sql) { return new Statement(this, sql); } query(sql, values = []) { const output = sqlite(`${bindSql(sql, values)};`, true); return output ? JSON.parse(output) : []; } async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } }
const database = new Database();
const env = { APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "false", APP_ORIGIN: "https://staging.example.test", EMAIL_ENABLED: "false", AUTH_EMAIL_ENABLED: "false", STAFF_AUTH_EMAIL_ENABLED: "false", EMAIL_FROM: "test@example.invalid", DB: database };
const actor = (role) => ({ staffAccountId: `${role}-id`, displayName: role, roles: [role], capabilities: role === "teacher" || role === "admin" ? ["content.manage"] : ["payment.view"], sessionId: "test", sessionExpiresAt: "2030-01-01", sessionAbsoluteExpiresAt: "2030-01-01" });

try {
  sqlite(readdirSync("migrations").filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().map((name) => readFileSync(path.join("migrations", name), "utf8")).join("\n"));
  const bundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/public-content.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" }); if (bundled.status !== 0) throw new Error(bundled.stderr);
  const content = await import(`${pathToFileURL(bundlePath).href}?content`);
  const before = await content.getPublicCenterInformation(env);
  await content.updatePublicCenterInformation(env, actor("teacher"), { expectedUpdatedAt: before.updatedAt, phone: "90066280", publicEmail: "info@example.mn", facebookPageUrl: "https://facebook.com/example", physicalAddress: "Тест", homepageIntro: "Товч", aboutCenterText: "Дэлгэрэнгүй", teacherBio: "Багш" });
  assert.equal((await content.getPublicCenterInformation(env)).phone, "90066280");
  await assert.rejects(content.updatePublicCenterInformation(env, actor("accountant"), { expectedUpdatedAt: before.updatedAt }), /Public content operation failed/);
  const initialRules = await content.getCourseRules(env); const guardian = initialRules.find((rule) => rule.code === "guardian"); const student = initialRules.find((rule) => rule.code === "student");
  assert.equal(guardian.versionId, "parent-rules-v1"); assert.equal(student.versionId, "student-rules-v1");
  const same = await content.saveCourseRule(env, actor("teacher"), { code: "guardian", bodyText: guardian.bodyText, expectedUpdatedAt: guardian.updatedAt });
  assert.equal(same.versionId, guardian.versionId, "identical rule save is a no-op");
  const changed = await content.saveCourseRule(env, actor("admin"), { code: "guardian", bodyText: `${guardian.bodyText}\n\nШинэ мөр.`, expectedUpdatedAt: guardian.updatedAt });
  assert.notEqual(changed.versionId, guardian.versionId); assert.equal(database.query("SELECT COUNT(*) AS count FROM course_rule_version WHERE course_rule_document_id = 'course-rule-guardian'")[0].count, 2);
  await content.assertCourseRuleVersions(env, guardian.versionId, student.versionId);
  await assert.rejects(content.assertCourseRuleVersions(env, student.versionId, guardian.versionId), /Public content operation failed/);
  console.log("ok typed public content, immutable course rules, stale provenance, permissions, and audit");
} finally { rmSync(tempDir, { recursive: true, force: true }); }
