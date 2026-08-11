import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-staff-auth-"));
const databasePath = path.join(tempDir, "staff.sqlite3");
const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");

function bundle(source, output) {
  const result = spawnSync(esbuild, [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`esbuild failed\n${result.stdout}\n${result.stderr}`);
}

const authBundle = path.join(tempDir, "staff-auth.mjs");
const authorizationBundle = path.join(tempDir, "staff-authorization.mjs");
const administrationBundle = path.join(tempDir, "staff-administration.mjs");
const routerBundle = path.join(tempDir, "router.mjs");
bundle("src/server/staff/auth.ts", authBundle);
bundle("src/server/staff/authorization.ts", authorizationBundle);
bundle("src/server/staff/administration.ts", administrationBundle);
bundle("src/server/api/router.ts", routerBundle);
const {
  STAFF_SESSION_COOKIE,
  readStaffCookie,
  revokeStaffSession,
  startStaffLogin,
  verifyStaffLogin,
} = await import(pathToFileURL(authBundle).href);
const { hasStaffCapability, resolveStaffPrincipal } = await import(pathToFileURL(authorizationBundle).href);
const { replaceStaffRoles, setStaffAccountStatus } = await import(pathToFileURL(administrationBundle).href);
const { handleApiRequest } = await import(pathToFileURL(routerBundle).href);

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSql(sql, values) {
  let index = 0;
  const bound = sql.replaceAll("?", () => {
    if (index >= values.length) throw new Error("Missing SQLite test binding");
    return sqlValue(values[index++]);
  });
  assert.equal(index, values.length, "all SQLite test bindings are consumed");
  return bound;
}

function sqlite(input, json = false) {
  const args = json ? ["-json", databasePath] : [databasePath];
  const result = spawnSync("sqlite3", args, {
    input: `.timeout 5000\nPRAGMA foreign_keys=ON;\n${input}`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stdout}\n${result.stderr}\n${input}`);
  return result.stdout.trim();
}

class Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  async all() {
    return { success: true, results: this.database.query(this.sql, this.values) };
  }
  async first() {
    return this.database.query(this.sql, this.values)[0] ?? null;
  }
  async run() {
    const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values);
    return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } };
  }
}

class SqliteD1 {
  prepare(sql) {
    return new Statement(this, sql);
  }
  query(sql, values = []) {
    const output = sqlite(`${bindSql(sql, values)};`, true);
    return output ? JSON.parse(output) : [];
  }
  async batch(statements) {
    const changes = statements.map((statement, index) => `${bindSql(statement.sql, statement.values)};
INSERT INTO _batch_changes (idx, change_count) VALUES (${index}, changes());`).join("\n");
    const output = sqlite(`
CREATE TEMP TABLE _batch_changes (idx INTEGER, change_count INTEGER);
BEGIN IMMEDIATE;
${changes}
COMMIT;
SELECT idx, change_count AS changes FROM _batch_changes ORDER BY idx;
`, true);
    const rows = output ? JSON.parse(output) : [];
    return rows.map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } }));
  }
}

function testEnv(database, overrides = {}) {
  return {
    APP_ENV: "staging",
    REGISTRATION_WRITE_ENABLED: "true",
    APP_ORIGIN: "https://staff-staging.example.test",
    EMAIL_ENABLED: "true",
    AUTH_EMAIL_ENABLED: "true",
    STAFF_AUTH_EMAIL_ENABLED: "true",
    EMAIL_FROM: "Наран Эрдэм <burtgel@mail.naranerdem.com>",
    RESEND_API_KEY: "resend-secret-not-for-template",
    STAGING_EMAIL_OVERRIDE_TO: "safe-inbox@example.test",
    STAGING_AUTH_TEST_KEY: "parent-test-gate-not-for-template",
    DB: database,
    ...overrides,
  };
}

function provider(options = {}) {
  const sent = [];
  return {
    sent,
    async send(message, sendOptions) {
      sent.push({ message, options: sendOptions });
      if (options.fail) throw new Error("provider failed");
      return { providerMessageId: `provider-${sent.length}` };
    },
  };
}

function count(database, table, where = "1 = 1") {
  return Number(database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)[0].count);
}

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
}

function rawCookieToken(setCookie) {
  return decodeURIComponent(cookiePair(setCookie).split("=")[1]);
}

function staff(database, id, email, name, role, status = "active") {
  const now = "2026-08-11T08:00:00.000Z";
  database.query(`
    INSERT INTO staff_account (
      id, email_normalized, display_name, status, disabled_at,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'staff-auth-test', ?, ?)
  `, [id, email, name, status, status === "disabled" ? now : null, now, now]);
  database.query(`
    INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at)
    VALUES (?, ?, ?)
  `, [id, role, now]);
}

async function api(env, pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const pending = [];
  const response = await handleApiRequest(new Request(`${env.APP_ORIGIN}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  return response;
}

async function createLogin(env, email, rawToken, now, fakeProvider) {
  await startStaffLogin(env, email, { rawToken, now, clientIp: `192.0.2.${rawToken.length}`, provider: fakeProvider });
  return verifyStaffLogin(env, rawToken, "", new Date(now.getTime() + 1000));
}

try {
  const staffPage = readFileSync(path.resolve("dist/staff/index.html"), "utf8");
  assert.match(staffPage, /<html lang="mn">/);
  assert.match(staffPage, /data-staff-surface="booting"/);
  assert.match(staffPage, /\/api\/staff\/session/);
  assert.match(staffPage, /\/api\/staff\/auth\/verify/);
  assert.match(staffPage, /method:\s*"POST"/);
  assert.match(staffPage, /history\.replaceState/);
  assert.match(staffPage, /addEventListener\("hashchange",\s*bootstrap\)/);
  assert.match(staffPage, /welcome\.textContent\s*=\s*""/);
  assert.ok(!staffPage.includes("@example.invalid"), "staff fixture identities are not shipped to the browser");

  const migrations = readdirSync(path.resolve("migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(path.resolve("migrations", name), "utf8"))
    .join("\n");
  sqlite(migrations);
  const database = new SqliteD1();
  const env = testEnv(database);
  const baseTime = new Date();

  for (const invalidArgs of [
    [],
    ["--env=production", "--email=staff@example.invalid", "--name=Test", "--role=admin"],
    ["--env=staging", "--email=staff@example.invalid", "--name=Test", "--role=assistant_teacher"],
    ["--env=staging", "--email=real@example.com", "--name=Test", "--role=teacher"],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/staff-provision.mjs", ...invalidArgs], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "unsafe provisioning arguments are rejected before remote access");
  }

  staff(database, "staff-teacher", "teacher@example.invalid", "Тест Багш", "teacher");
  staff(database, "staff-admin", "admin@example.invalid", "Тест Админ", "admin");
  staff(database, "staff-accountant", "accountant@example.invalid", "Тест Нягтлан", "accountant");
  staff(database, "staff-disabled", "disabled@example.invalid", "Идэвхгүй Тест", "teacher", "disabled");
  staff(database, "staff-expired", "expired@example.invalid", "Хугацаа Тест", "teacher");
  staff(database, "staff-failure", "failure@example.invalid", "Алдаа Тест", "teacher");
  staff(database, "staff-scanner", "scanner@example.invalid", "Скан Тест", "teacher");
  database.query(`
    INSERT INTO guardian_account (
      id, full_name, primary_phone, primary_phone_normalized, email, email_normalized,
      home_address, status, is_test, test_run_id, created_at, updated_at
    ) VALUES ('guardian-only', 'Guardian Only', '99000000', '99000000',
      'guardian-only@example.invalid', 'guardian-only@example.invalid', 'Test', 'active',
      1, 'staff-auth-test', ?, ?)
  `, [baseTime.toISOString(), baseTime.toISOString()]);

  const teacherProvider = provider();
  const rawTeacherToken = "raw-teacher-magic-token";
  await startStaffLogin(env, " Teacher@Example.Invalid ", {
    rawToken: rawTeacherToken,
    now: baseTime,
    clientIp: "192.0.2.10",
    provider: teacherProvider,
  });
  assert.equal(teacherProvider.sent.length, 1);
  assert.equal(teacherProvider.sent[0].message.to, "safe-inbox@example.test");
  assert.match(teacherProvider.sent[0].message.subject, /Ажилтны нэвтрэх холбоос/);
  assert.ok(teacherProvider.sent[0].message.html.includes(rawTeacherToken));
  assert.ok(teacherProvider.sent[0].message.text.includes(rawTeacherToken));
  assert.ok(!teacherProvider.sent[0].message.html.includes(env.RESEND_API_KEY));
  assert.ok(!teacherProvider.sent[0].message.text.includes(env.STAGING_AUTH_TEST_KEY));
  const teacherChallenge = database.query("SELECT * FROM staff_login_challenge WHERE staff_account_id = 'staff-teacher'")[0];
  assert.equal(teacherChallenge.token_hash, createHash("sha256").update(rawTeacherToken).digest("hex"));
  assert.ok(!sqlite(".dump").includes(rawTeacherToken), "raw magic token is never stored");
  const teacherOutbound = database.query("SELECT * FROM outbound_email WHERE staff_account_id = 'staff-teacher'")[0];
  assert.equal(teacherOutbound.intended_to_email, "teacher@example.invalid");
  assert.equal(teacherOutbound.actual_delivery_email, "safe-inbox@example.test");
  assert.equal(teacherOutbound.delivery_mode, "staging_override");
  assert.equal(teacherOutbound.status, "sent");
  assert.match(teacherProvider.sent[0].options.idempotencyKey, /^staff-login\//);

  await assert.rejects(verifyStaffLogin(env, "wrong-token", "", new Date(baseTime.getTime() + 1000)));
  const teacherLogin = await verifyStaffLogin(env, rawTeacherToken, "", new Date(baseTime.getTime() + 1000));
  assert.match(teacherLogin.cookie, new RegExp(`^${STAFF_SESSION_COOKIE}=`));
  assert.match(teacherLogin.cookie, /HttpOnly/);
  assert.match(teacherLogin.cookie, /Secure/);
  assert.match(teacherLogin.cookie, /SameSite=Lax/);
  assert.match(teacherLogin.cookie, /Path=\//);
  assert.match(teacherLogin.cookie, /Max-Age=36000/);
  const teacherRawSession = rawCookieToken(teacherLogin.cookie);
  assert.ok(!sqlite(".dump").includes(teacherRawSession), "raw staff session token is never stored");
  assert.equal(teacherLogin.principal.displayName, "Тест Багш");
  assert.ok(hasStaffCapability(teacherLogin.principal, "calendar.manage"));
  assert.ok(!hasStaffCapability(teacherLogin.principal, "admin.staff.manage"));
  const sameBrowserReplay = await verifyStaffLogin(env, rawTeacherToken, teacherRawSession, new Date(baseTime.getTime() + 2000));
  assert.equal(sameBrowserReplay.alreadySignedIn, true);
  assert.equal(sameBrowserReplay.cookie, null);
  await assert.rejects(verifyStaffLogin(env, rawTeacherToken, "", new Date(baseTime.getTime() + 2000)));
  assert.equal(count(database, "staff_session", "staff_account_id = 'staff-teacher'"), 1);
  assert.equal(count(database, "audit_event", "action = 'staff_login_succeeded' AND actor_ref = 'staff-teacher'"), 1);

  const expiredProvider = provider();
  await startStaffLogin(env, "expired@example.invalid", {
    rawToken: "expired-raw-token",
    now: baseTime,
    clientIp: "192.0.2.11",
    provider: expiredProvider,
  });
  await assert.rejects(verifyStaffLogin(env, "expired-raw-token", "", new Date(baseTime.getTime() + 16 * 60 * 1000)));
  assert.equal(database.query("SELECT status FROM staff_login_challenge WHERE staff_account_id = 'staff-expired'")[0].status, "expired");

  const beforeUnknown = count(database, "outbound_email");
  const unknownProvider = provider();
  await startStaffLogin(env, "guardian-only@example.invalid", { now: baseTime, clientIp: "192.0.2.12", provider: unknownProvider });
  await startStaffLogin(env, "nobody@example.invalid", { now: baseTime, clientIp: "192.0.2.13", provider: unknownProvider });
  await startStaffLogin(env, "disabled@example.invalid", { now: baseTime, clientIp: "192.0.2.14", provider: unknownProvider });
  assert.equal(unknownProvider.sent.length, 0);
  assert.equal(count(database, "outbound_email"), beforeUnknown, "guardian, unknown, and disabled identities receive no staff email");

  await assert.rejects(startStaffLogin(testEnv(database, { STAGING_EMAIL_OVERRIDE_TO: undefined }), "admin@example.invalid", {
    now: baseTime,
    clientIp: "192.0.2.15",
    provider: provider(),
  }));
  const disabledEnvProvider = provider();
  await startStaffLogin(testEnv(database, { STAFF_AUTH_EMAIL_ENABLED: "false" }), "admin@example.invalid", {
    now: baseTime,
    clientIp: "192.0.2.16",
    provider: disabledEnvProvider,
  });
  assert.equal(disabledEnvProvider.sent.length, 0, "production-style gate prevents sending");

  staff(database, "staff-production", "future-production@example.invalid", "Future Production", "admin");
  const productionProvider = provider();
  await startStaffLogin(testEnv(database, {
    APP_ENV: "production",
    APP_ORIGIN: "https://naranerdem.com",
    STAGING_EMAIL_OVERRIDE_TO: undefined,
  }), "future-production@example.invalid", {
    now: baseTime,
    clientIp: "192.0.2.17",
    rawToken: "production-delivery-token",
    provider: productionProvider,
  });
  assert.equal(productionProvider.sent[0].message.to, "future-production@example.invalid");
  const productionOutbound = database.query("SELECT intended_to_email, actual_delivery_email FROM outbound_email WHERE staff_account_id = 'staff-production'")[0];
  assert.equal(productionOutbound.actual_delivery_email, productionOutbound.intended_to_email);

  const failedProvider = provider({ fail: true });
  await assert.rejects(startStaffLogin(env, "failure@example.invalid", {
    now: baseTime,
    clientIp: "192.0.2.18",
    rawToken: "provider-failure-token",
    provider: failedProvider,
  }));
  assert.equal(database.query("SELECT status FROM outbound_email WHERE staff_account_id = 'staff-failure'")[0].status, "failed");
  assert.equal(database.query("SELECT status FROM staff_login_challenge WHERE staff_account_id = 'staff-failure'")[0].status, "delivery_failed");

  const cooldownProvider = provider();
  await startStaffLogin(env, "accountant@example.invalid", { now: baseTime, clientIp: "192.0.2.19", rawToken: "accountant-token", provider: cooldownProvider });
  await startStaffLogin(env, "accountant@example.invalid", { now: new Date(baseTime.getTime() + 5000), clientIp: "192.0.2.19", rawToken: "duplicate-token", provider: cooldownProvider });
  assert.equal(cooldownProvider.sent.length, 1);
  assert.equal(count(database, "outbound_email", "staff_account_id = 'staff-accountant'"), 1, "cooldown prevents duplicate logical send");

  const scannerProvider = provider();
  await startStaffLogin(env, "scanner@example.invalid", { now: baseTime, clientIp: "192.0.2.20", rawToken: "scanner-token", provider: scannerProvider });
  const scannerGet = await api(env, "/api/staff/auth/verify", { method: "GET" });
  assert.equal(scannerGet.status, 405);
  assert.equal(database.query("SELECT status FROM staff_login_challenge WHERE staff_account_id = 'staff-scanner'")[0].status, "pending");
  const scannerPost = await api(env, "/api/staff/auth/verify", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN },
    body: { token: "scanner-token" },
  });
  assert.equal(scannerPost.status, 200);
  assert.match(scannerPost.headers.get("set-cookie") ?? "", /HttpOnly/);

  const adminProvider = provider();
  const adminLogin = await createLogin(env, "admin@example.invalid", "admin-token", baseTime, adminProvider);
  const adminCookie = cookiePair(adminLogin.cookie);
  const accountantLogin = await verifyStaffLogin(env, "accountant-token", "", new Date(baseTime.getTime() + 1000));
  const accountantCookie = cookiePair(accountantLogin.cookie);
  const teacherCookie = cookiePair(teacherLogin.cookie);

  assert.equal((await api(env, "/api/staff/proof/calendar")).status, 401);
  assert.equal((await api(env, "/api/staff/proof/calendar", { headers: { Cookie: teacherCookie } })).status, 200);
  assert.equal((await api(env, "/api/staff/proof/calendar-mutation", {
    method: "POST",
    headers: { Cookie: teacherCookie, Origin: env.APP_ORIGIN },
  })).status, 200);
  assert.equal((await api(env, "/api/staff/proof/calendar", { headers: { Cookie: accountantCookie } })).status, 403);
  assert.equal((await api(env, "/api/staff/proof/admin", { headers: { Cookie: accountantCookie } })).status, 403);
  assert.equal((await api(env, "/api/staff/proof/admin", { headers: { Cookie: adminCookie } })).status, 200);

  await assert.rejects(
    replaceStaffRoles(env, teacherLogin.principal, "staff-accountant", ["teacher"], baseTime),
    (error) => error.code === "forbidden",
  );
  await assert.rejects(
    replaceStaffRoles(env, adminLogin.principal, "staff-teacher", ["assistant_teacher"], baseTime),
    (error) => error.code === "invalid_role",
  );
  await replaceStaffRoles(env, adminLogin.principal, "staff-teacher", ["accountant"], baseTime);
  const changedPrincipal = await resolveStaffPrincipal(env, teacherRawSession, new Date(baseTime.getTime() + 3000));
  assert.ok(hasStaffCapability(changedPrincipal, "accountant.call_queue.view"));
  assert.ok(!hasStaffCapability(changedPrincipal, "calendar.view"), "role changes take effect without a new session");
  assert.equal((await api(env, "/api/staff/proof/calendar", { headers: { Cookie: teacherCookie } })).status, 403);
  assert.equal(count(database, "audit_event", "action = 'staff_roles_changed' AND actor_ref = 'staff-admin'"), 1);

  await setStaffAccountStatus(env, adminLogin.principal, "staff-teacher", "disabled", baseTime);
  assert.equal(await resolveStaffPrincipal(env, teacherRawSession, new Date(baseTime.getTime() + 4000)), null, "disabled staff immediately loses session access");
  const disabledSession = await api(env, "/api/staff/session", { headers: { Cookie: teacherCookie } });
  assert.deepEqual(await disabledSession.json(), { authenticated: false });
  assert.equal(count(database, "audit_event", "action = 'staff_account_disabled' AND actor_ref = 'staff-admin'"), 1);

  const parentCookieRequest = new Request(`${env.APP_ORIGIN}/api/staff/session`, { headers: { Cookie: "naran_verified_email=parent-session-token" } });
  assert.equal(readStaffCookie(parentCookieRequest), "");
  assert.deepEqual(await (await handleApiRequest(parentCookieRequest, env)).json(), { authenticated: false });
  const parentStatusWithStaffCookie = await api(env, "/api/registration/status", { headers: { Cookie: accountantCookie } });
  assert.equal(parentStatusWithStaffCookie.status, 404, "staff session cannot authorize a parent registration route");

  await revokeStaffSession(env, rawCookieToken(accountantLogin.cookie), new Date(baseTime.getTime() + 5000));
  assert.equal(await resolveStaffPrincipal(env, rawCookieToken(accountantLogin.cookie), new Date(baseTime.getTime() + 6000)), null);
  assert.equal(count(database, "audit_event", "action = 'staff_logout' AND actor_ref = 'staff-accountant'"), 1);
  database.query("UPDATE staff_session SET expires_at = ? WHERE id = ?", [new Date(baseTime.getTime() + 2000).toISOString(), adminLogin.principal.sessionId]);
  assert.equal(await resolveStaffPrincipal(env, rawCookieToken(adminLogin.cookie), new Date(baseTime.getTime() + 7000)), null);

  const activeResponse = await api(env, "/api/staff/auth/start", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "CF-Connecting-IP": "192.0.2.30" },
    body: { email: "admin@example.invalid" },
  });
  const unknownResponse = await api(env, "/api/staff/auth/start", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "CF-Connecting-IP": "192.0.2.31" },
    body: { email: "unknown-person@example.invalid" },
  });
  assert.equal(activeResponse.status, 202);
  assert.equal(unknownResponse.status, 202);
  assert.equal(await activeResponse.text(), await unknownResponse.text(), "public login start does not enumerate staff identity");
  assert.equal((await api(env, "/api/staff/auth/start", { method: "GET" })).status, 405);
  assert.equal((await api(env, "/api/staff/auth/start", { method: "POST", body: { email: "admin@example.invalid" } })).status, 403);

  console.log("ok staff authentication, authorization, isolation, and email safety tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
