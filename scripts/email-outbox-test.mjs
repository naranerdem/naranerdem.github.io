import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "naranerdem-email-outbox-"));
const dbPath = path.join(dir, "outbox.sqlite3");
const bundle = path.join(dir, "outbox.mjs");
const policyBundle = path.join(dir, "archive-policy.mjs");
const resendBundle = path.join(dir, "resend.mjs");
const settingBundle = path.join(dir, "archive-setting.mjs");
function sql(source, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", dbPath] : [dbPath], { input: `PRAGMA foreign_keys=ON;\n${source}`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function quote(value) { return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
function bind(statement, values) { let index = 0; const result = statement.replaceAll("?", () => quote(values[index++])); assert.equal(index, values.length); return result; }
class Statement { constructor(database, statement) { this.database = database; this.statement = statement; this.values = []; } bind(...values) { this.values = values; return this; } async first() { return this.database.query(this.statement, this.values)[0] ?? null; } async all() { return { success: true, results: this.database.query(this.statement, this.values) }; } async run() { const rows = this.database.query(`${this.statement}; SELECT changes() AS changes`, this.values); return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } }; } }
class Database { prepare(statement) { return new Statement(this, statement); } query(statement, values = []) { const result = sql(`${bind(statement, values)};`, true); return result ? JSON.parse(result) : []; } async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } }
const actor = { staffAccountId: "admin", displayName: "Admin", roles: ["admin"], capabilities: ["admin.settings.manage"], sessionId: "test", sessionExpiresAt: "2030-01-01", sessionAbsoluteExpiresAt: "2030-01-01" };
const nonAdmin = { ...actor, staffAccountId: "teacher", roles: ["teacher"], capabilities: [] };

try {
  sql(readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort().map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const built = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/email-outbox.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(built.stderr);
  const policyBuilt = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/email/archive-policy.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${policyBundle}`], { encoding: "utf8" });
  if (policyBuilt.status !== 0) throw new Error(policyBuilt.stderr);
  const resendBuilt = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/email/resend.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${resendBundle}`], { encoding: "utf8" });
  if (resendBuilt.status !== 0) throw new Error(resendBuilt.stderr);
  const settingBuilt = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/email-archive-bcc.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${settingBundle}`], { encoding: "utf8" });
  if (settingBuilt.status !== 0) throw new Error(settingBuilt.stderr);
  const { listEmailOutbox, getEmailOutboxEntry, EmailOutboxError } = await import(pathToFileURL(bundle).href);
  const { emailSensitivityForTemplate, parseArchiveRecipients, sanitizedOutboxSnapshot } = await import(pathToFileURL(policyBundle).href);
  const { createResendProvider } = await import(pathToFileURL(resendBundle).href);
  const { getEmailArchiveBccSetting, updateEmailArchiveBccSetting, EmailArchiveBccError } = await import(pathToFileURL(settingBundle).href);
  const database = new Database(); const env = { APP_ENV: "staging", DB: database };
  const archiveDefault = await getEmailArchiveBccSetting(env); assert.deepEqual(archiveDefault.recipients, []);
  const archiveUpdated = await updateEmailArchiveBccSetting(env, actor, { recipients: [" Archive@Example.test "], expectedUpdatedAt: archiveDefault.updatedAt });
  assert.deepEqual(archiveUpdated.recipients, ["archive@example.test"]);
  assert.equal(sql("SELECT COUNT(*) AS count FROM audit_event WHERE action = 'email_archive_bcc_changed'", true), '[{"count":1}]');
  await assert.rejects(() => updateEmailArchiveBccSetting(env, nonAdmin, { recipients: [], expectedUpdatedAt: archiveUpdated.updatedAt }), (error) => error instanceof EmailArchiveBccError && error.code === "forbidden");
  sql(`INSERT INTO outbound_email (id,event_type,template_key,intended_to_email,actual_delivery_email,delivery_mode,status,attempt_count,queued_at,created_at,updated_at,email_sensitivity,outbox_subject,outbox_text,bcc_recipients_json) VALUES
    ('safe-old','payment_reminder','payment_reminder_v1','parent@example.test','safe@example.test','staging_override','sent',1,'2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z','archive_bcc_safe','Төлбөрийн сануулга','Аюулгүй мэдэгдэл','["archive@example.test"]'),
    ('sensitive-new','login','staff_login_v2','admin@example.test',NULL,'staging_override','queued',0,'2026-09-03T00:00:00.000Z','2026-09-03T00:00:00.000Z','2026-09-03T00:00:00.000Z','sensitive_capability','Нэвтрэх','Нэвтрэх холбоос: [аюулгүй холбоос нуусан]','[]'),
    ('failed','payment_reminder','payment_reminder_v1','failed@example.test',NULL,'staging_override','failed',2,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','archive_bcc_safe','Амжилтгүй','Аюулгүй мэдэгдэл','[]');`);
  const listing = await listEmailOutbox(env, actor, {});
  assert.equal(listing.emails.length, 3); assert.equal(listing.emails[0].id, "sensitive-new", "newest first");
  assert.equal(listing.emails[0].text.includes("token"), false, "sensitive display does not reveal tokens");
  assert.equal((await listEmailOutbox(env, actor, { status: "failed" })).emails[0].id, "failed", "status filter is bounded and correct");
  const detail = await getEmailOutboxEntry(env, actor, "safe-old"); assert.deepEqual(detail.bccRecipients, ["archive@example.test"]);
  await assert.rejects(() => listEmailOutbox(env, nonAdmin, {}), (error) => error instanceof EmailOutboxError && error.code === "forbidden");
  assert.deepEqual(parseArchiveRecipients([" Archive@Example.test ", "other@example.test"]), ["archive@example.test", "other@example.test"]);
  assert.throws(() => parseArchiveRecipients(["a@b.test", "A@b.test"]), /invalid_archive_recipients/);
  assert.throws(() => parseArchiveRecipients(["a@b.test", "b@b.test", "c@b.test", "d@b.test", "e@b.test", "f@b.test"]), /invalid_archive_recipients/);
  assert.equal(emailSensitivityForTemplate("payment_reminder_v1"), "archive_bcc_safe");
  assert.equal(emailSensitivityForTemplate("waitlist_offer_v1"), "sensitive_capability");
  assert.equal(emailSensitivityForTemplate("future_unknown_template"), "sensitive_capability");
  const snapshot = sanitizedOutboxSnapshot({ from: "x", to: "x", subject: "x", html: "x", text: "Холбоос https://example.test/?token=secret-token" }, "sensitive_capability");
  assert.doesNotMatch(snapshot.text, /secret-token/);
  let requestBody = null;
  const provider = createResendProvider("test", async (_url, request) => { requestBody = JSON.parse(request.body); return new Response(JSON.stringify({ id: "provider-id" }), { status: 200 }); });
  await provider.send({ from: "x", to: "parent@example.test", subject: "safe", html: "x", text: "x", bcc: ["archive@example.test"] }, { idempotencyKey: "stable" });
  assert.deepEqual(requestBody.bcc, ["archive@example.test"], "safe archive is one provider submission");
  console.log("ok sanitized email Outbox authorization, ordering, filtering, and safe snapshots");
} finally { rmSync(dir, { recursive: true, force: true }); }
