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
const policyBundle = path.join(tempDir, "staff-policy.mjs");
const routerBundle = path.join(tempDir, "router.mjs");
bundle("src/server/staff/auth.ts", authBundle);
bundle("src/server/staff/authorization.ts", authorizationBundle);
bundle("src/server/staff/administration.ts", administrationBundle);
bundle("src/server/staff/session-policy.ts", policyBundle);
bundle("src/server/api/router.ts", routerBundle);
const {
  STAFF_LOGIN_ATTEMPT_COOKIE,
  STAFF_SESSION_COOKIE,
  claimStaffLoginAttempt,
  readStaffAttemptCookie,
  readStaffCookie,
  revokeAllStaffSessions,
  revokeStaffSession,
  revokeStaffSessionById,
  startStaffLogin,
  verifyStaffLogin,
} = await import(pathToFileURL(authBundle).href);
const { hasStaffCapability, resolveStaffPrincipal } = await import(pathToFileURL(authorizationBundle).href);
const {
  addStaffAccountEmail,
  createStaffAccount,
  listStaffAccounts,
  removeStaffAccountEmail,
  replaceStaffRoles,
  setPrimaryStaffAccountEmail,
  setStaffAccountStatus,
  updateStaffAccount,
} = await import(pathToFileURL(administrationBundle).href);
const { listStaffSessionPolicies, updateStaffSessionPolicies } = await import(pathToFileURL(policyBundle).href);
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
    STAFF_AUTH_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    STAFF_AUTH_TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
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

function staff(database, id, email, name, roles, status = "active", isTest = 1) {
  const now = "2026-08-11T08:00:00.000Z";
  database.query(`
    INSERT INTO staff_account (
      id, email_normalized, display_name, status, disabled_at,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, email, name, status, status === "disabled" ? now : null, isTest, isTest ? "staff-auth-test" : null, now, now]);
  database.query(`INSERT INTO staff_account_email (
    id, staff_account_id, email, email_normalized, is_primary, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 1, ?, ?)`, [`email-${id}`, id, email, email, now, now]);
  for (const role of Array.isArray(roles) ? roles : [roles]) {
    database.query(`
      INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at)
      VALUES (?, ?, ?)
    `, [id, role, now]);
  }
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

async function begin(env, email, options) {
  const result = await startStaffLogin(env, email, options);
  if (result.delivery) await result.delivery;
  return result;
}

async function sameContextLogin(env, email, label, now, fakeProvider = provider()) {
  const magic = `${label}-magic`;
  const claim = `${label}-claim`;
  const session = `${label}-session`;
  const started = await begin(env, email, {
    rawToken: magic,
    rawClaimSecret: claim,
    rawSessionToken: session,
    now,
    clientIp: `192.0.2.${label.length + 30}`,
    provider: fakeProvider,
  });
  const verified = await verifyStaffLogin(
    env,
    magic,
    claim,
    "",
    new Date(now.getTime() + 1000),
    session,
  );
  return { started, verified, rawSession: session, provider: fakeProvider };
}

function policy(role, inactivityDays, absoluteDays) {
  const day = 24 * 60 * 60;
  return { role, inactivitySeconds: inactivityDays * day, absoluteSeconds: absoluteDays * day };
}

try {
  const staffPage = readFileSync(path.resolve("dist/staff/index.html"), "utf8");
  const settingsPage = readFileSync(path.resolve("dist/staff/settings/auth/index.html"), "utf8");
  const teamPage = readFileSync(path.resolve("dist/staff/team/index.html"), "utf8");
  const teamSource = readFileSync(path.resolve("src/pages/staff/team.astro"), "utf8");
  const manifest = JSON.parse(readFileSync(path.resolve("dist/manifest.webmanifest"), "utf8"));
  assert.match(staffPage, /<html lang="mn">/);
  assert.match(staffPage, /data-staff-surface="booting"/);
  assert.match(staffPage, /Нэвтрэх хүсэлт баталгаажлаа/);
  assert.match(staffPage, /Нэвтрэх гэж байсан цонх эсвэл Наран Эрдэм апп руугаа буцна уу/);
  assert.match(staffPage, /\/api\/staff\/auth\/attempt\/claim/);
  assert.match(staffPage, /visibilitychange/);
  assert.match(staffPage, /setTimeout\(pollAttempt, 4000\)/);
  assert.doesNotMatch(staffPage, />Гарах</);
  assert.doesNotMatch(staffPage, /Апп нээх/);
  assert.ok(!staffPage.includes("@example.invalid"), "staff fixtures are not shipped to the browser");
  assert.match(settingsPage, /data-staff-settings-surface="booting"/);
  assert.match(settingsPage, /\/api\/staff\/settings\/auth/);
  assert.match(teamPage, /<html lang="mn">/);
  assert.match(teamPage, /Ажилтнууд/);
  assert.match(teamSource, /\/api\/staff\/team/);
  assert.match(teamSource, /Имэйл нэмэх/);
  assert.match(teamSource, /email-primary/);
  assert.match(teamSource, /email-remove/);
  assert.doesNotMatch(teamSource, /account\?\.email/, "profile editing no longer exposes a second single-email authority");
  assert.doesNotMatch(teamPage, /@example\.invalid/, "staff fixture addresses are not shipped in the admin page");
  assert.equal(manifest.start_url, "/staff/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.name, "Наран Эрдэм");

  const migrationFiles = readdirSync(path.resolve("migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const aliasMigrationIndex = migrationFiles.indexOf("0017_staff_email_aliases.sql");
  assert.ok(aliasMigrationIndex > 0, "migration 0017 is present");
  sqlite(migrationFiles.slice(0, aliasMigrationIndex).map((name) => readFileSync(path.resolve("migrations", name), "utf8")).join("\n"));
  sqlite(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('legacy-staff', 'legacy@example.invalid', 'Хуучин Багш', 'active', 1, 'staff-auth-test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at)
      VALUES ('legacy-staff', 'teacher', '2026-01-01T00:00:00.000Z');
    INSERT INTO staff_session (id, staff_account_id, session_token_hash, created_at, expires_at, is_test, test_run_id, last_seen_at)
      VALUES ('legacy-session', 'legacy-staff', '${"a".repeat(64)}', '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', 1, 'staff-auth-test', '2026-01-01T00:00:00.000Z');
  `);
  sqlite(migrationFiles.slice(aliasMigrationIndex).map((name) => readFileSync(path.resolve("migrations", name), "utf8")).join("\n"));
  assert.deepEqual(JSON.parse(sqlite(`SELECT staff_account_id AS staffAccountId, email_normalized AS email, is_primary AS isPrimary FROM staff_account_email WHERE staff_account_id = 'legacy-staff';`, true)), [
    { staffAccountId: "legacy-staff", email: "legacy@example.invalid", isPrimary: 1 },
  ], "0017 backfills the existing address as primary");
  assert.equal(count(new SqliteD1(), "staff_session", "id = 'legacy-session' AND revoked_at IS NULL"), 1, "0017 preserves existing sessions");
  const database = new SqliteD1();
  const env = testEnv(database);
  const baseTime = new Date();

  const defaults = await listStaffSessionPolicies(env);
  assert.deepEqual(defaults.map(({ role, inactivitySeconds, absoluteSeconds }) => [role, inactivitySeconds, absoluteSeconds]), [
    ["teacher", 30 * 86400, 90 * 86400],
    ["accountant", 14 * 86400, 60 * 86400],
    ["admin", 7 * 86400, 30 * 86400],
  ]);

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
  staff(database, "staff-race", "race@example.invalid", "Уралдаан Тест", "teacher");
  staff(database, "staff-multirole", "multi@example.invalid", "Олон эрх Тест", ["teacher", "admin"]);
  staff(database, "staff-policy", "policy@example.invalid", "Бодлого Тест", "teacher");
  staff(database, "staff-disable-after", "disable-after@example.invalid", "Дараа идэвхгүй", "teacher");
  database.query(`
    INSERT INTO guardian_account (
      id, full_name, primary_phone, primary_phone_normalized, email, email_normalized,
      home_address, status, is_test, test_run_id, created_at, updated_at
    ) VALUES ('guardian-only', 'Guardian Only', '99000000', '99000000',
      'guardian-only@example.invalid', 'guardian-only@example.invalid', 'Test', 'active',
      1, 'staff-auth-test', ?, ?)
  `, [baseTime.toISOString(), baseTime.toISOString()]);

  const teacherProvider = provider();
  const teacherStart = await begin(env, " Teacher@Example.Invalid ", {
    rawToken: "teacher-magic",
    rawClaimSecret: "teacher-claim",
    now: baseTime,
    clientIp: "192.0.2.10",
    provider: teacherProvider,
  });
  assert.match(teacherStart.attemptCookie, new RegExp(`^${STAFF_LOGIN_ATTEMPT_COOKIE}=`));
  assert.match(teacherStart.attemptCookie, /HttpOnly/);
  assert.match(teacherStart.attemptCookie, /Secure/);
  assert.match(teacherStart.attemptCookie, /SameSite=Lax/);
  assert.match(teacherStart.attemptCookie, /Max-Age=900/);
  assert.equal(teacherProvider.sent.length, 1);
  assert.equal(teacherProvider.sent[0].message.to, "safe-inbox@example.test");
  assert.ok(teacherProvider.sent[0].message.html.includes("teacher-magic"));
  assert.ok(!teacherProvider.sent[0].message.html.includes(env.RESEND_API_KEY));
  assert.ok(!teacherProvider.sent[0].message.text.includes(env.STAGING_AUTH_TEST_KEY));
  const teacherChallenge = database.query("SELECT * FROM staff_login_challenge WHERE staff_account_id = 'staff-teacher'")[0];
  assert.equal(teacherChallenge.token_hash, createHash("sha256").update("teacher-magic").digest("hex"));
  const teacherAttempt = database.query("SELECT * FROM staff_login_attempt WHERE staff_account_id = 'staff-teacher'")[0];
  assert.equal(teacherAttempt.claim_secret_hash, createHash("sha256").update("teacher-claim").digest("hex"));
  assert.ok(!sqlite(".dump").includes("teacher-magic"), "raw magic token is never stored");
  assert.ok(!sqlite(".dump").includes("teacher-claim"), "raw claim secret is never stored");
  const teacherOutbound = database.query("SELECT * FROM outbound_email WHERE staff_account_id = 'staff-teacher'")[0];
  assert.equal(teacherOutbound.intended_to_email, "teacher@example.invalid");
  assert.equal(teacherOutbound.actual_delivery_email, "safe-inbox@example.test");
  assert.equal(teacherOutbound.status, "sent");

  await assert.rejects(verifyStaffLogin(env, "wrong-token", "teacher-claim", "", new Date(baseTime.getTime() + 1000)));
  assert.equal((await claimStaffLoginAttempt(env, "teacher-claim", new Date(baseTime.getTime() + 500))).state, "pending", "claim secret alone cannot authenticate");

  // Context B consumes the email; context A alone owns the claim cookie.
  const approvedInB = await verifyStaffLogin(env, "teacher-magic", "", "", new Date(baseTime.getTime() + 1000));
  assert.equal(approvedInB.approved, true);
  assert.equal(approvedInB.claimed, false);
  assert.equal(approvedInB.cookie, null);
  assert.equal(count(database, "staff_session", "staff_account_id = 'staff-teacher'"), 0);
  const claimedInA = await claimStaffLoginAttempt(env, "teacher-claim", new Date(baseTime.getTime() + 2000), "teacher-session");
  assert.equal(claimedInA.state, "authenticated");
  assert.match(claimedInA.cookie, new RegExp(`^${STAFF_SESSION_COOKIE}=`));
  assert.match(claimedInA.cookie, /HttpOnly/);
  assert.match(claimedInA.cookie, /Secure/);
  assert.match(claimedInA.cookie, /SameSite=Lax/);
  assert.match(claimedInA.cookie, /Path=\//);
  assert.match(claimedInA.cookie, /Max-Age=31536000/);
  assert.ok(!sqlite(".dump").includes("teacher-session"), "raw staff session token is never stored");
  assert.ok(hasStaffCapability(claimedInA.principal, "calendar.manage"));
  await assert.rejects(verifyStaffLogin(env, "teacher-magic", "teacher-claim", "teacher-session", new Date(baseTime.getTime() + 3000)), "used challenge cannot mint another session");
  assert.equal((await claimStaffLoginAttempt(env, "teacher-claim", new Date(baseTime.getTime() + 3000))).state, "claimed");
  assert.equal(count(database, "staff_session", "staff_account_id = 'staff-teacher'"), 1);

  // Same-context fast path approves and claims in one request.
  const adminLogin = await sameContextLogin(env, "admin@example.invalid", "admin", new Date(baseTime.getTime() + 60_000));
  assert.equal(adminLogin.verified.claimed, true);
  assert.equal(adminLogin.verified.principal.displayName, "Тест Админ");
  assert.ok(hasStaffCapability(adminLogin.verified.principal, "admin.settings.manage"));
  await assert.rejects(
    addStaffAccountEmail(env, claimedInA.principal, "staff-teacher", "teacher-two@example.invalid"),
    (error) => error.code === "forbidden",
    "teachers cannot manage staff login aliases",
  );

  // Admin CRUD keeps person/profile authority separate from login aliases.
  const created = await createStaffAccount(env, adminLogin.verified.principal, {
    displayName: "Шинэ Тест",
    email: "new-staff@example.invalid",
    role: "teacher",
  }, new Date(baseTime.getTime() + 61_000));
  assert.ok((await listStaffAccounts(env, adminLogin.verified.principal)).some((entry) => entry.id === created.id && entry.isTest && entry.emails.length === 1 && entry.emails[0].isPrimary));
  await assert.rejects(createStaffAccount(env, adminLogin.verified.principal, {
    displayName: "Давхардсан",
    email: "new-staff@example.invalid",
    role: "teacher",
  }), (error) => error.code === "email_conflict");
  const createdLogin = await sameContextLogin(env, "new-staff@example.invalid", "new-staff", new Date(baseTime.getTime() + 62_000));
  const secondAlias = await addStaffAccountEmail(env, adminLogin.verified.principal, created.id, "new-staff-two@example.invalid", new Date(baseTime.getTime() + 62_100));
  const thirdAlias = await addStaffAccountEmail(env, adminLogin.verified.principal, created.id, "new-staff-three@example.invalid", new Date(baseTime.getTime() + 62_200));
  await assert.rejects(
    addStaffAccountEmail(env, adminLogin.verified.principal, created.id, "new-staff-four@example.invalid"),
    (error) => error.code === "email_limit",
  );
  await assert.rejects(createStaffAccount(env, adminLogin.verified.principal, {
    displayName: "Өөр хүн", email: " NEW-STAFF-THREE@example.invalid ", role: "teacher",
  }), (error) => error.code === "email_conflict");
  const aliasLogin = await sameContextLogin(env, "new-staff-two@example.invalid", "new-staff-two", new Date(baseTime.getTime() + 62_300));
  assert.equal(aliasLogin.verified.principal.staffAccountId, created.id, "a secondary alias authenticates the same staff account");
  assert.equal(aliasLogin.provider.sent[0].message.to, "safe-inbox@example.test", "a fake staging alias retains the safe recipient override");
  const pendingAlias = await begin(env, "new-staff-two@example.invalid", {
    rawToken: "alias-pending-magic", rawClaimSecret: "alias-pending-claim",
    now: new Date(baseTime.getTime() + 123_400), clientIp: "192.0.2.121", provider: provider(),
  });
  assert.ok(pendingAlias.attemptCookie);
  await setPrimaryStaffAccountEmail(env, adminLogin.verified.principal, created.id, thirdAlias.id, new Date(baseTime.getTime() + 123_500));
  assert.equal(database.query("SELECT email_normalized AS email FROM staff_account WHERE id = ?", [created.id])[0].email, "new-staff-three@example.invalid", "primary alias updates the compatibility email");
  await removeStaffAccountEmail(env, adminLogin.verified.principal, created.id, secondAlias.id, new Date(baseTime.getTime() + 123_600));
  assert.ok(await resolveStaffPrincipal(env, aliasLogin.rawSession, new Date(baseTime.getTime() + 123_700)), "removing an alias does not revoke its existing account session");
  assert.equal(database.query("SELECT status FROM staff_login_attempt WHERE claim_secret_hash = ?", [createHash("sha256").update("alias-pending-claim").digest("hex")])[0].status, "cancelled", "removing an alias cancels its pending login attempt");
  assert.equal(database.query("SELECT status FROM staff_login_challenge WHERE token_hash = ?", [createHash("sha256").update("alias-pending-magic").digest("hex")])[0].status, "invalidated", "removing an alias invalidates its pending challenge");
  const removedProvider = provider();
  await begin(env, "new-staff-two@example.invalid", { now: new Date(baseTime.getTime() + 184_800), rawClaimSecret: "removed-alias-claim", clientIp: "192.0.2.122", provider: removedProvider });
  assert.equal(removedProvider.sent.length, 0, "a removed alias no longer queues login email");
  await assert.rejects(removeStaffAccountEmail(env, adminLogin.verified.principal, created.id, thirdAlias.id), (error) => error.code === "primary_email");
  await updateStaffAccount(env, adminLogin.verified.principal, created.id, {
    displayName: "Шинэ Нягтлан",
    role: "accountant",
  }, new Date(baseTime.getTime() + 185_000));
  assert.ok(await resolveStaffPrincipal(env, createdLogin.rawSession, new Date(baseTime.getTime() + 186_000)), "profile and role editing does not revoke an otherwise valid session");
  assert.deepEqual(database.query("SELECT role_code AS role FROM staff_account_role WHERE staff_account_id = ?", [created.id]).map((row) => row.role), ["accountant"]);

  await replaceStaffRoles(env, adminLogin.verified.principal, "staff-multirole", ["teacher"], new Date(baseTime.getTime() + 65_000));
  await assert.rejects(
    replaceStaffRoles(env, adminLogin.verified.principal, "staff-admin", ["teacher"], new Date(baseTime.getTime() + 66_000)),
    (error) => error.code === "last_active_admin",
  );
  await assert.rejects(
    setStaffAccountStatus(env, adminLogin.verified.principal, "staff-admin", "disabled", new Date(baseTime.getTime() + 67_000)),
    (error) => error.code === "last_active_admin",
  );
  await replaceStaffRoles(env, adminLogin.verified.principal, "staff-multirole", ["teacher", "admin"], new Date(baseTime.getTime() + 68_000));
  assert.ok(count(database, "audit_event", `subject_id = '${created.id}' AND action = 'staff_account_updated'`) >= 1);

  const expiredStart = await begin(env, "expired@example.invalid", {
    rawToken: "expired-magic", rawClaimSecret: "expired-claim", now: baseTime,
    clientIp: "192.0.2.11", provider: provider(),
  });
  assert.ok(expiredStart.attemptCookie);
  await assert.rejects(verifyStaffLogin(env, "expired-magic", "expired-claim", "", new Date(baseTime.getTime() + 16 * 60 * 1000)));
  assert.equal((await claimStaffLoginAttempt(env, "expired-claim", new Date(baseTime.getTime() + 16 * 60 * 1000))).state, "expired");

  const beforeUnknownEmails = count(database, "outbound_email");
  for (const email of ["guardian-only@example.invalid", "nobody@example.invalid", "disabled@example.invalid"]) {
    const unknownProvider = provider();
    const unknown = await begin(env, email, {
      now: baseTime,
      rawClaimSecret: `${email}-claim`,
      clientIp: `192.0.2.${email.length}`,
      provider: unknownProvider,
    });
    assert.ok(unknown.attemptCookie, "unknown and disabled addresses receive an indistinguishable waiting attempt");
    assert.equal(unknownProvider.sent.length, 0);
    assert.equal((await claimStaffLoginAttempt(env, `${email}-claim`, new Date(baseTime.getTime() + 1000))).state, "pending");
  }
  assert.equal(count(database, "outbound_email"), beforeUnknownEmails, "unknown identities queue no email");

  await assert.rejects(begin(testEnv(database, { STAGING_EMAIL_OVERRIDE_TO: undefined }), "accountant@example.invalid", {
    now: baseTime, rawClaimSecret: "missing-override-claim", clientIp: "192.0.2.15", provider: provider(),
  }));
  staff(database, "staff-real-staging", "real-staff@example.com", "Бодит Тест Ажилтан", "teacher", "active", 0);
  await addStaffAccountEmail(env, adminLogin.verified.principal, "staff-real-staging", "real-staff-two@example.com", new Date(baseTime.getTime() + 68_500));
  const directProvider = provider();
  await begin(testEnv(database, { STAGING_EMAIL_OVERRIDE_TO: undefined }), "real-staff-two@example.com", {
    now: new Date(baseTime.getTime() + 69_000), rawToken: "real-staging-magic",
    rawClaimSecret: "real-staging-claim", clientIp: "192.0.2.17", provider: directProvider,
  });
  assert.equal(directProvider.sent[0].message.to, "real-staff-two@example.com", "an explicit real staging staff alias receives its own login email");
  const directOutbound = database.query("SELECT actual_delivery_email AS actualEmail, delivery_mode AS deliveryMode FROM outbound_email WHERE staff_account_id = 'staff-real-staging'")[0];
  assert.deepEqual(directOutbound, { actualEmail: "real-staff-two@example.com", deliveryMode: "production" });
  const disabledGateProvider = provider();
  const disabledGate = await begin(testEnv(database, { STAFF_AUTH_EMAIL_ENABLED: "false" }), "accountant@example.invalid", {
    now: baseTime, clientIp: "192.0.2.16", provider: disabledGateProvider,
  });
  assert.equal(disabledGate.attemptCookie, null);
  assert.equal(disabledGateProvider.sent.length, 0);

  const failureProvider = provider({ fail: true });
  const failed = await startStaffLogin(env, "failure@example.invalid", {
    now: baseTime, clientIp: "192.0.2.18", rawToken: "failure-magic",
    rawClaimSecret: "failure-claim", provider: failureProvider,
  });
  await assert.rejects(failed.delivery);
  assert.equal(database.query("SELECT status FROM outbound_email WHERE staff_account_id = 'staff-failure'")[0].status, "failed");
  assert.equal(database.query("SELECT status FROM staff_login_challenge WHERE staff_account_id = 'staff-failure'")[0].status, "delivery_failed");

  const cooldownProvider = provider();
  const firstCooldown = await begin(env, "accountant@example.invalid", {
    now: baseTime, clientIp: "192.0.2.19", rawToken: "accountant-magic",
    rawClaimSecret: "accountant-claim", provider: cooldownProvider,
  });
  const secondCooldown = await begin(env, "accountant@example.invalid", {
    now: new Date(baseTime.getTime() + 5000), clientIp: "192.0.2.19",
    rawToken: "duplicate-magic", existingAttemptSecret: "accountant-claim", provider: cooldownProvider,
  });
  assert.equal(cooldownProvider.sent.length, 1);
  assert.equal(rawCookieToken(firstCooldown.attemptCookie), rawCookieToken(secondCooldown.attemptCookie));
  assert.equal(count(database, "staff_login_attempt", "staff_account_id = 'staff-accountant'"), 1);

  const scannerGet = await api(env, "/api/staff/auth/verify", { method: "GET" });
  assert.equal(scannerGet.status, 405);
  assert.equal(database.query("SELECT status FROM staff_login_challenge WHERE staff_account_id = 'staff-accountant'")[0].status, "pending");

  // API context B has no claim cookie; context A later claims with its own jar.
  const verifyB = await api(env, "/api/staff/auth/verify", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN },
    body: { token: "accountant-magic" },
  });
  assert.equal(verifyB.status, 200);
  assert.equal((await verifyB.json()).claimed, false);
  assert.equal(verifyB.headers.get("set-cookie"), null);
  const claimA = await api(env, "/api/staff/auth/attempt/claim", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, Cookie: cookiePair(firstCooldown.attemptCookie) },
  });
  assert.equal(claimA.status, 200);
  assert.deepEqual(await claimA.json(), { state: "authenticated" });
  const claimCookies = typeof claimA.headers.getSetCookie === "function"
    ? claimA.headers.getSetCookie().join("\n")
    : claimA.headers.get("set-cookie") ?? "";
  assert.match(claimCookies, new RegExp(STAFF_SESSION_COOKIE));
  assert.match(claimCookies, new RegExp(STAFF_LOGIN_ATTEMPT_COOKIE));
  assert.equal((await api(env, "/api/staff/auth/attempt/claim", {
    method: "POST", headers: { Origin: env.APP_ORIGIN }, body: { attemptId: teacherAttempt.id },
  }).then((response) => response.json())).state, "none", "attempt ID alone is ignored");
  assert.equal((await api(env, "/api/staff/auth/attempt/claim", { method: "GET" })).status, 405);

  // A claim race creates exactly one logical session.
  const raceProvider = provider();
  await begin(env, "race@example.invalid", {
    now: baseTime, rawToken: "race-magic", rawClaimSecret: "race-claim",
    clientIp: "192.0.2.50", provider: raceProvider,
  });
  await verifyStaffLogin(env, "race-magic", "", "", new Date(baseTime.getTime() + 1000));
  const raceResults = await Promise.all([
    claimStaffLoginAttempt(env, "race-claim", new Date(baseTime.getTime() + 2000), "race-session-a"),
    claimStaffLoginAttempt(env, "race-claim", new Date(baseTime.getTime() + 2000), "race-session-b"),
  ]);
  assert.equal(raceResults.filter((result) => result.state === "authenticated").length, 1);
  assert.equal(count(database, "staff_session", "staff_account_id = 'staff-race'"), 1);
  assert.equal(count(database, "audit_event", "action = 'staff_login_succeeded' AND actor_ref = 'staff-race'"), 1);

  // Approval becomes unusable if the staff account is disabled before claim.
  const disableAfter = await begin(env, "disable-after@example.invalid", {
    now: new Date(baseTime.getTime() + 120_000), rawToken: "disable-after-magic",
    rawClaimSecret: "disable-after-claim", clientIp: "192.0.2.51", provider: provider(),
  });
  assert.ok(disableAfter.attemptCookie);
  await verifyStaffLogin(env, "disable-after-magic", "", "", new Date(baseTime.getTime() + 121_000));
  await setStaffAccountStatus(env, adminLogin.verified.principal, "staff-disable-after", "disabled", new Date(baseTime.getTime() + 122_000));
  assert.equal((await claimStaffLoginAttempt(env, "disable-after-claim", new Date(baseTime.getTime() + 123_000))).state, "expired");

  // Sliding inactivity updates are throttled; attempt polling never touches last_seen_at.
  const teacherSessionRow = database.query("SELECT id, last_seen_at FROM staff_session WHERE staff_account_id = 'staff-teacher'")[0];
  const sevenHours = new Date(baseTime.getTime() + 7 * 60 * 60 * 1000);
  assert.ok(await resolveStaffPrincipal(env, "teacher-session", sevenHours));
  const refreshedLastSeen = database.query("SELECT last_seen_at FROM staff_session WHERE id = ?", [teacherSessionRow.id])[0].last_seen_at;
  assert.equal(refreshedLastSeen, sevenHours.toISOString());
  await api(env, "/api/staff/auth/attempt/claim", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, Cookie: `${STAFF_SESSION_COOKIE}=teacher-session` },
  });
  assert.equal(database.query("SELECT last_seen_at FROM staff_session WHERE id = ?", [teacherSessionRow.id])[0].last_seen_at, refreshedLastSeen);
  assert.ok(await resolveStaffPrincipal(env, "teacher-session", new Date(sevenHours.getTime() + 29 * 86400_000)));
  assert.equal(await resolveStaffPrincipal(env, "teacher-session", new Date(baseTime.getTime() + 91 * 86400_000)), null, "absolute limit never slides");

  const multiLogin = await sameContextLogin(env, "multi@example.invalid", "multi", new Date(baseTime.getTime() + 180_000));
  assert.equal(await resolveStaffPrincipal(env, multiLogin.rawSession, new Date(baseTime.getTime() + 8 * 86400_000)), null, "multi-role session uses shortest inactivity limit");

  // Two devices coexist and admin revocation can target one or all.
  const firstPolicyLogin = await sameContextLogin(env, "policy@example.invalid", "policy-one", new Date(baseTime.getTime() + 240_000));
  const secondPolicyLogin = await sameContextLogin(env, "policy@example.invalid", "policy-two", new Date(baseTime.getTime() + 305_000));
  assert.equal(count(database, "staff_session", "staff_account_id = 'staff-policy' AND revoked_at IS NULL"), 2);
  await revokeStaffSessionById(env, adminLogin.verified.principal, firstPolicyLogin.verified.principal.sessionId, new Date(baseTime.getTime() + 310_000));
  assert.equal(await resolveStaffPrincipal(env, firstPolicyLogin.rawSession, new Date(baseTime.getTime() + 311_000)), null);
  assert.ok(await resolveStaffPrincipal(env, secondPolicyLogin.rawSession, new Date(baseTime.getTime() + 311_000)));
  await revokeAllStaffSessions(env, adminLogin.verified.principal, "staff-policy", new Date(baseTime.getTime() + 312_000));
  assert.equal(await resolveStaffPrincipal(env, secondPolicyLogin.rawSession, new Date(baseTime.getTime() + 313_000)), null);
  assert.equal(count(database, "audit_event", "action = 'staff_session_revoked_by_admin'"), 1);
  assert.equal(count(database, "audit_event", "action = 'staff_sessions_revoked_by_admin'"), 1);

  // Admin policy edits are bounded and shortening permanently expires old sessions.
  const policyTargetLogin = await sameContextLogin(env, "policy@example.invalid", "policy-three", new Date(baseTime.getTime() + 370_000));
  await assert.rejects(updateStaffSessionPolicies(env, claimedInA.principal, [
    policy("teacher", 30, 90), policy("accountant", 14, 60), policy("admin", 7, 30),
  ]), (error) => error.code === "forbidden");
  await assert.rejects(updateStaffSessionPolicies(env, adminLogin.verified.principal, [
    policy("teacher", 0, 90), policy("accountant", 14, 60), policy("admin", 7, 30),
  ]), (error) => error.code === "invalid_policy");
  const shortenAt = new Date(baseTime.getTime() + 2 * 86400_000);
  await updateStaffSessionPolicies(env, adminLogin.verified.principal, [
    policy("teacher", 1, 90), policy("accountant", 14, 60), policy("admin", 7, 30),
  ], shortenAt);
  assert.equal(await resolveStaffPrincipal(env, policyTargetLogin.rawSession, new Date(shortenAt.getTime() + 1000)), null);
  await updateStaffSessionPolicies(env, adminLogin.verified.principal, [
    policy("teacher", 30, 90), policy("accountant", 14, 60), policy("admin", 7, 30),
  ], new Date(shortenAt.getTime() + 2000));
  assert.equal(await resolveStaffPrincipal(env, policyTargetLogin.rawSession, new Date(shortenAt.getTime() + 3000)), null, "lengthening does not resurrect an expired session");

  const adminCookie = `${STAFF_SESSION_COOKIE}=${adminLogin.rawSession}`;
  const teamGet = await api(env, "/api/staff/team", { headers: { Cookie: adminCookie } });
  assert.equal(teamGet.status, 200);
  assert.ok((await teamGet.json()).accounts.some((entry) => entry.id === created.id));
  const teamCreate = await api(env, "/api/staff/team", {
    method: "POST", headers: { Cookie: adminCookie, Origin: env.APP_ORIGIN },
    body: { displayName: "API Ажилтан", email: "api-created@example.invalid", role: "teacher" },
  });
  assert.equal(teamCreate.status, 201);
  const teamCreatedId = (await teamCreate.clone().json()).id;
  const teamAliasAdd = await api(env, "/api/staff/team", {
    method: "PUT", headers: { Cookie: adminCookie, Origin: env.APP_ORIGIN },
    body: { action: "email-add", staffAccountId: teamCreatedId, email: "api-created-two@example.invalid" },
  });
  assert.equal(teamAliasAdd.status, 200);
  assert.equal(count(database, "staff_account_email", `staff_account_id = '${teamCreatedId}'`), 2);
  assert.notEqual((await api(env, "/api/staff/team", { headers: { Cookie: `${STAFF_SESSION_COOKIE}=teacher-session` } })).status, 200);
  assert.equal((await api(env, "/api/staff/team", { method: "DELETE", headers: { Cookie: adminCookie } })).status, 405);
  const settingsGet = await api(env, "/api/staff/settings/auth", { headers: { Cookie: adminCookie } });
  assert.equal(settingsGet.status, 200);
  assert.equal((await settingsGet.json()).policies.length, 3);
  const settingsPut = await api(env, "/api/staff/settings/auth", {
    method: "PUT",
    headers: { Cookie: adminCookie, Origin: env.APP_ORIGIN },
    body: { policies: [policy("teacher", 30, 90), policy("accountant", 14, 60), policy("admin", 7, 30)] },
  });
  assert.equal(settingsPut.status, 200);
  assert.equal((await settingsPut.json()).reauthenticationRequired, false);
  const teacherSettings = await api(env, "/api/staff/settings/auth", { headers: { Cookie: `${STAFF_SESSION_COOKIE}=teacher-session` } });
  assert.notEqual(teacherSettings.status, 200);
  assert.equal((await api(env, "/api/staff/settings/auth", { method: "POST" })).status, 405);
  staff(database, "staff-outbox-teacher", "outbox-teacher@example.invalid", "Outbox Багш", "teacher");
  const outboxTeacher = await sameContextLogin(env, "outbox-teacher@example.invalid", "outbox-teacher", new Date(baseTime.getTime() + 420_000));
  const outboxTeacherCookie = `${STAFF_SESSION_COOKIE}=${outboxTeacher.rawSession}`;
  assert.equal((await api(env, "/api/staff/outbox")).status, 401, "Outbox is never public");
  assert.equal((await api(env, "/api/staff/outbox", { headers: { Cookie: adminCookie } })).status, 200, "admin can list the Outbox");
  assert.equal((await api(env, "/api/staff/outbox", { headers: { Cookie: outboxTeacherCookie } })).status, 403, "teacher cannot list the Outbox");
  assert.equal((await api(env, "/api/staff/settings/email-archive-bcc", { headers: { Cookie: adminCookie } })).status, 200, "admin can read archive BCC settings");
  assert.equal((await api(env, "/api/staff/settings/email-archive-bcc", { headers: { Cookie: outboxTeacherCookie } })).status, 403, "teacher cannot read archive BCC settings");

  // Current roles and disabled status remain live authorization inputs.
  staff(database, "staff-role-change", "role-change@example.invalid", "Эрх Солих", "teacher");
  const roleLogin = await sameContextLogin(env, "role-change@example.invalid", "role-change", new Date(baseTime.getTime() + 430_000));
  await replaceStaffRoles(env, adminLogin.verified.principal, "staff-role-change", ["accountant"], new Date(baseTime.getTime() + 431_000));
  const changedPrincipal = await resolveStaffPrincipal(env, roleLogin.rawSession, new Date(baseTime.getTime() + 432_000));
  assert.ok(hasStaffCapability(changedPrincipal, "accountant.call_queue.view"));
  assert.ok(!hasStaffCapability(changedPrincipal, "calendar.view"));
  const accountantPrograms = await api(env, "/api/staff/program-calendar", {
    headers: { Cookie: `${STAFF_SESSION_COOKIE}=${roleLogin.rawSession}` },
  });
  assert.equal(accountantPrograms.status, 403, "accountants cannot retrieve curriculum data through the staff API");
  assert.equal((await api(env, "/api/staff/outbox", { headers: { Cookie: `${STAFF_SESSION_COOKIE}=${roleLogin.rawSession}` } })).status, 403, "accountant cannot list the Outbox");
  assert.equal((await api(env, "/api/staff/settings/email-archive-bcc", { headers: { Cookie: `${STAFF_SESSION_COOKIE}=${roleLogin.rawSession}` } })).status, 403, "accountant cannot read archive BCC settings");
  const accountantAttendance = await api(env, "/api/staff/proof/attendance", {
    headers: { Cookie: `${STAFF_SESSION_COOKIE}=${roleLogin.rawSession}` },
  });
  assert.equal(accountantAttendance.status, 403, "accountants cannot view course attendance");
  staff(database, "staff-attendance-teacher", "attendance-teacher@example.invalid", "Ирцийн Багш", "teacher");
  const attendanceTeacher = await sameContextLogin(env, "attendance-teacher@example.invalid", "attendance-teacher", new Date(baseTime.getTime() + 432_500));
  const teacherAttendance = await api(env, "/api/staff/proof/attendance", {
    headers: { Cookie: `${STAFF_SESSION_COOKIE}=${attendanceTeacher.rawSession}` },
  });
  assert.equal(teacherAttendance.status, 200, "teachers can view course attendance");
  const teacherAttendanceMutation = await api(env, "/api/staff/proof/attendance-mutation", {
    method: "POST", headers: { Cookie: `${STAFF_SESSION_COOKIE}=${attendanceTeacher.rawSession}`, Origin: env.APP_ORIGIN },
  });
  assert.equal(teacherAttendanceMutation.status, 200, "teachers can manage course attendance");
  assert.equal((await api(env, "/api/staff/attendance?date=2026-08-12")).status, 401, "attendance roster is never public");
  assert.equal((await api(env, "/api/staff/attendance", { method: "PUT" })).status, 405, "unsupported attendance methods are rejected");
  assert.equal((await api(env, "/api/staff/makeups")).status, 401, "make-up student data is never public");
  assert.equal((await api(env, "/api/staff/day-changes")).status, 401, "daily schedule operations are never public");
  assert.equal((await api(env, "/api/staff/makeups", { headers: { Cookie: `${STAFF_SESSION_COOKIE}=${roleLogin.rawSession}` } })).status, 403, "accountants cannot view make-up student data");
  assert.equal((await api(env, "/api/staff/day-changes", { headers: { Cookie: `${STAFF_SESSION_COOKIE}=${roleLogin.rawSession}` } })).status, 403, "accountants cannot manage course days");
  assert.equal((await api(env, "/api/staff/makeups", { method: "PUT" })).status, 405, "unsupported make-up methods are rejected");
  assert.equal((await api(env, "/api/staff/day-changes", { method: "PUT" })).status, 405, "unsupported daily-change methods are rejected");
  assert.equal((await api(env, "/api/staff/makeups", {
    method: "POST", headers: { Cookie: `${STAFF_SESSION_COOKIE}=${attendanceTeacher.rawSession}`, Origin: env.APP_ORIGIN }, body: { action: "unknown" },
  })).status, 404, "unknown make-up actions are rejected");
  assert.equal((await api(env, "/api/staff/day-changes", {
    method: "POST", headers: { Cookie: `${STAFF_SESSION_COOKIE}=${attendanceTeacher.rawSession}`, Origin: env.APP_ORIGIN }, body: { action: "unknown" },
  })).status, 404, "unknown daily-change actions are rejected");
  await setStaffAccountStatus(env, adminLogin.verified.principal, "staff-role-change", "disabled", new Date(baseTime.getTime() + 433_000));
  assert.equal(await resolveStaffPrincipal(env, roleLogin.rawSession, new Date(baseTime.getTime() + 434_000)), null);
  await setStaffAccountStatus(env, adminLogin.verified.principal, "staff-role-change", "active", new Date(baseTime.getTime() + 435_000));
  assert.equal(await resolveStaffPrincipal(env, roleLogin.rawSession, new Date(baseTime.getTime() + 436_000)), null, "re-enabling does not resurrect revoked sessions");

  const parentCookieRequest = new Request(`${env.APP_ORIGIN}/api/staff/session`, { headers: { Cookie: "naran_verified_email=parent-session-token" } });
  assert.equal(readStaffCookie(parentCookieRequest), "");
  assert.equal(readStaffAttemptCookie(parentCookieRequest), "");
  assert.deepEqual(await (await handleApiRequest(parentCookieRequest, env)).json(), { authenticated: false });

  const apiActiveProvider = provider();
  globalThis.fetch = async () => Response.json({ success: true, action: "staff_login_start" });
  staff(database, "staff-api", "api@example.invalid", "API Тест", "teacher");
  const apiPrepared = await begin(env, "api@example.invalid", {
    now: baseTime, rawToken: "api-magic", rawClaimSecret: "api-claim",
    clientIp: "192.0.2.80", provider: apiActiveProvider,
  });
  const activeResponse = await api(env, "/api/staff/auth/start", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "CF-Connecting-IP": "192.0.2.80", Cookie: cookiePair(apiPrepared.attemptCookie) },
    body: { email: "api@example.invalid", turnstileToken: "staff-test-token" },
  });
  const unknownResponse = await api(env, "/api/staff/auth/start", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "CF-Connecting-IP": "192.0.2.81" },
    body: { email: "unknown-api@example.invalid", turnstileToken: "staff-test-token" },
  });
  assert.equal(activeResponse.status, 202);
  assert.equal(unknownResponse.status, 202);
  assert.equal(await activeResponse.text(), await unknownResponse.text(), "public start does not enumerate staff identity");
  assert.match(activeResponse.headers.get("set-cookie") ?? "", new RegExp(STAFF_LOGIN_ATTEMPT_COOKIE));
  assert.match(unknownResponse.headers.get("set-cookie") ?? "", new RegExp(STAFF_LOGIN_ATTEMPT_COOKIE));
  assert.equal((await api(env, "/api/staff/auth/start", { method: "GET" })).status, 405);
  assert.equal((await api(env, "/api/staff/auth/start", { method: "POST", body: { email: "api@example.invalid" } })).status, 403);
  const missingTokenResponse = await api(env, "/api/staff/auth/start", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "CF-Connecting-IP": "192.0.2.82" },
    body: { email: "api@example.invalid" },
  });
  assert.equal(missingTokenResponse.status, 202);
  assert.equal(missingTokenResponse.headers.get("set-cookie"), null, "missing Turnstile token creates no staff login attempt");
  const limitedEnv = testEnv(database, {
    STAFF_LOGIN_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  const limitedResponse = await api(limitedEnv, "/api/staff/auth/start", {
    method: "POST",
    headers: { Origin: limitedEnv.APP_ORIGIN, "CF-Connecting-IP": "192.0.2.83" },
    body: { email: "api@example.invalid", turnstileToken: "staff-test-token" },
  });
  assert.equal(limitedResponse.status, 202);
  assert.equal(limitedResponse.headers.get("set-cookie"), null, "edge rate limiting rejects before a staff login attempt is created");
  const staffAuthConfig = await api(env, "/api/staff/auth/config");
  assert.deepEqual(await staffAuthConfig.json(), {
    emailLoginEnabled: true,
    turnstileSiteKey: "1x00000000000000000000AA",
  }, "staff login exposes only its independent public Turnstile site key when enabled");

  const productionEnv = testEnv(database, {
    APP_ENV: "production",
    APP_ORIGIN: "https://naranerdem.com",
    EMAIL_ENABLED: "false",
    AUTH_EMAIL_ENABLED: "false",
    STAFF_AUTH_EMAIL_ENABLED: "false",
    STAFF_AUTH_TURNSTILE_SITE_KEY: "production-site-key",
    STAFF_AUTH_TURNSTILE_SECRET_KEY: "production-secret",
    STAGING_EMAIL_OVERRIDE_TO: undefined,
  });
  assert.equal((await api(productionEnv, "/api/staff/auth/start", {
    method: "POST", headers: { Origin: productionEnv.APP_ORIGIN }, body: { email: "admin@example.invalid" },
  })).headers.get("set-cookie"), null, "production-disabled start creates no claim state");
  assert.deepEqual(await (await api(productionEnv, "/api/staff/auth/config")).json(), {
    emailLoginEnabled: false,
    turnstileSiteKey: null,
  }, "production staff auth cannot become ready without the required edge limiter");
  const productionStaffOnlyEnv = testEnv(database, {
    APP_ENV: "production",
    APP_ORIGIN: "https://naranerdem.com",
    EMAIL_ENABLED: "false",
    AUTH_EMAIL_ENABLED: "false",
    STAFF_AUTH_EMAIL_ENABLED: "true",
    STAFF_AUTH_TURNSTILE_SITE_KEY: "production-site-key",
    STAFF_AUTH_TURNSTILE_SECRET_KEY: "production-secret",
    STAFF_LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    STAGING_EMAIL_OVERRIDE_TO: undefined,
  });
  assert.deepEqual(await (await api(productionStaffOnlyEnv, "/api/staff/auth/config")).json(), {
    emailLoginEnabled: true,
    turnstileSiteKey: "production-site-key",
  }, "production staff login is independently enabled while parent email remains disabled");
  assert.equal(count(database, "audit_event", "metadata_json LIKE '%teacher-magic%' OR metadata_json LIKE '%teacher-claim%'"), 0, "audit logs contain no raw auth token");

  await revokeStaffSession(env, adminLogin.rawSession, new Date(baseTime.getTime() + 3 * 86400_000));
  assert.equal(await resolveStaffPrincipal(env, adminLogin.rawSession, new Date(baseTime.getTime() + 3 * 86400_000 + 1000)), null);

  console.log("ok persistent cross-context staff auth, policy, revocation, and UI security tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
