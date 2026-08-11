import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-registration-holds-"));
const databasePath = path.join(tempDir, "registration.sqlite3");
const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");

function bundle(source, output) {
  const result = spawnSync(esbuild, [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`esbuild failed\n${result.stdout}\n${result.stderr}`);
}

const registrationBundle = path.join(tempDir, "registration-submission.mjs");
const turnstileBundle = path.join(tempDir, "turnstile.mjs");
const emailVerificationBundle = path.join(tempDir, "email-verification.mjs");
bundle("src/server/services/registration-submission.ts", registrationBundle);
bundle("src/server/security/turnstile.ts", turnstileBundle);
bundle("src/server/auth/email-verification.ts", emailVerificationBundle);
const {
  changeDraftEmail,
  claimRegistrationEmailSend,
  confirmRegistrationChallenge,
  createRegistrationDraft,
  enforceResendCooldown,
  markRegistrationEmailSent,
  registrationStatusForSession,
  RegistrationSubmissionError,
} = await import(pathToFileURL(registrationBundle).href);
const { TurnstileError, verifyTurnstile } = await import(pathToFileURL(turnstileBundle).href);
const { verifyEmailToken } = await import(pathToFileURL(emailVerificationBundle).href);

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
  const result = spawnSync("sqlite3", args, { input: `.timeout 5000\nPRAGMA foreign_keys=ON;\n${input}`, encoding: "utf8" });
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

function iso(offsetMinutes = 0) {
  return new Date(Date.UTC(2026, 7, 11, 8, offsetMinutes, 0)).toISOString();
}

function env(database, overrides = {}) {
  return {
    APP_ENV: "staging",
    REGISTRATION_WRITE_ENABLED: "true",
    EMAIL_ENABLED: "true",
    AUTH_EMAIL_ENABLED: "true",
    APP_ORIGIN: "https://staging.example.test",
    EMAIL_FROM: "Наран Эрдэм <burtgel@mail.naranerdem.com>",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    DB: database,
    ...overrides,
  };
}

function submission(classId, waitlistId, children = 1) {
  return {
    guardian: {
      fullName: "Тест Асран",
      relationship: "Ээж",
      primaryPhone: "99000000",
      email: `parent-${randomUUID()}@example.test`,
      homeAddress: "Баянзүрх дүүрэг",
    },
    children: Array.from({ length: children }, (_, index) => ({
      surname: "Тест",
      givenName: `Хүүхэд ${index + 1}`,
      gender: "not_specified",
      dateOfBirth: "2015-05-10",
      currentGrade: "5",
      returningStatus: "new",
      selectedStageCode: "stage_1",
      selectedClassSessionId: classId || undefined,
      preferredWaitlistClassSessionId: waitlistId || undefined,
      codeInput: "ANY-CODE",
    })),
    paymentPlanCode: "full-year",
    parentRulesAcknowledged: true,
    studentRulesAcknowledged: true,
    turnstileToken: "tested-before-service",
  };
}

function count(database, table, where = "1 = 1") {
  return Number(database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)[0].count);
}

function addChallenge(database, draftId, email, now, expiresAt) {
  const outboundId = randomUUID();
  const challengeId = randomUUID();
  const rawToken = randomUUID();
  database.query(`
    INSERT INTO outbound_email (
      id, event_type, template_key, intended_to_email, actual_delivery_email,
      delivery_mode, status, attempt_count, queued_at, is_test, test_run_id,
      created_at, updated_at, registration_draft_id
    ) VALUES (?, 'registration_confirmation_requested', 'registration_confirmation_v1', ?, ?,
      'staging_override', 'sent', 1, ?, 1, ?, ?, ?, ?)
  `, [outboundId, email, "safe@example.test", now, `test:${draftId}`, now, now, draftId]);
  database.query(`
    INSERT INTO email_verification_challenge (
      id, normalized_email, token_hash, purpose, status, outbound_email_id,
      created_at, expires_at, is_test, test_run_id, updated_at, registration_draft_id
    ) VALUES (?, ?, ?, 'registration_email', 'pending', ?, ?, ?, 1, ?, ?, ?)
  `, [challengeId, email.toLowerCase(), createHash("sha256").update(rawToken).digest("hex"), outboundId,
    now, expiresAt, `test:${draftId}`, now, draftId]);
  return {
    id: challengeId,
    normalizedEmail: email.toLowerCase(),
    status: "pending",
    expiresAt,
    invalidatedAt: null,
    registrationDraftId: draftId,
    isTest: 1,
    testRunId: `test:${draftId}`,
    rawToken,
  };
}

function session(now, expiresAt) {
  const rawToken = randomUUID();
  return {
    id: randomUUID(),
    rawToken,
    tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    createdAt: now,
    expiresAt,
  };
}

try {
  const migrations = [1, 2, 3, 4, 5]
    .map((number) => readFileSync(path.resolve("migrations", `${String(number).padStart(4, "0")}_${[
      "initial_registration_foundation",
      "single_class_selection",
      "email_verification_foundation",
      "generic_code_input",
      "registration_drafts_and_holds",
    ][number - 1]}.sql`), "utf8"))
    .join("\n");
  sqlite(migrations);
  const database = new SqliteD1();
  database.query(`
    INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year-test', 'Тест жил', 'open', 1, 1, 'catalog-test', ?, ?)
  `, [iso(), iso()]);
  for (const [id, capacity, status, time] of [
    ["class-last-seat", 1, "available", "10:00"],
    ["class-roomy", 3, "available", "12:00"],
    ["class-full-preferred", 1, "full", "14:00"],
  ]) {
    database.query(`
      INSERT INTO class_session (
        id, academic_year_id, stage_code, display_label, weekday, start_time,
        end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at
      ) VALUES (?, 'year-test', 'stage_1', ?, 'Бямба', ?, '15:20', ?, ?, 1, 1, 'catalog-test', ?, ?)
    `, [id, id, time, capacity, status, iso(), iso()]);
  }

  const one = await createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso()));
  assert.equal(one.hasProvisionalHold, true);
  assert.equal(count(database, "registration_capacity_hold", "status = 'active'"), 1);

  const competing = await Promise.allSettled([
    createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(1))),
    createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(1))),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 0, "an existing hold protects the last seat");
  assert.equal(count(database, "registration_capacity_hold", "class_session_id = 'class-last-seat' AND deadline_at > '2026-08-11T08:01:00.000Z'"), 1);

  database.query("UPDATE registration_capacity_hold SET deadline_at = ? WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)", [iso(1), one.draftId]);
  const replacement = await createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(2)));
  assert.equal(replacement.hasProvisionalHold, true, "expired provisional hold restores capacity without cleanup");

  await assert.rejects(
    createRegistrationDraft(env(database), submission("class-roomy", undefined, 4), new Date(iso(3))),
    (error) => error instanceof RegistrationSubmissionError && error.code === "capacity_changed",
  );
  const partialDraft = database.query("SELECT id FROM registration_draft ORDER BY created_at DESC LIMIT 1")[0];
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${partialDraft.id}')`), 0, "multi-child failure creates no partial hold");

  const waitlistOnly = await createRegistrationDraft(env(database), submission(undefined, "class-full-preferred"), new Date(iso(4)));
  assert.equal(waitlistOnly.hasProvisionalHold, false);
  assert.equal(count(database, "registration_draft_waitlist_entry", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${waitlistOnly.draftId}')`), 0, "unverified draft does not enter FIFO queue");
  const waitChallenge = addChallenge(database, waitlistOnly.draftId, waitlistOnly.normalizedEmail, iso(4), iso(4 + 24 * 60));
  const waitConfirmed = await confirmRegistrationChallenge(env(database), waitChallenge, session(iso(5), iso(65)), new Date(iso(5)));
  assert.equal(waitConfirmed.status, "waitlisted");
  assert.equal(count(database, "registration_draft_waitlist_entry", "status = 'active'"), 1);
  assert.equal(count(database, "registration_capacity_hold", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${waitlistOnly.draftId}')`), 0);

  const fallback = await createRegistrationDraft(env(database), submission("class-roomy", "class-full-preferred"), new Date(iso(6)));
  const fallbackChallenge = addChallenge(database, fallback.draftId, fallback.normalizedEmail, iso(6), iso(6 + 24 * 60));
  const fallbackSession = session(iso(7), iso(67));
  const fallbackConfirmed = await confirmRegistrationChallenge(env(database), fallbackChallenge, fallbackSession, new Date(iso(7)));
  assert.equal(fallbackConfirmed.hasPaymentHold, true);
  assert.equal(fallbackConfirmed.paymentDeadlineAt, iso(7 + 24 * 60), "fresh payment hold starts at confirmation");
  assert.equal(count(database, "registration_draft_waitlist_entry", `registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = '${fallback.draftId}')`), 1);
  const fallbackStatus = await registrationStatusForSession(database, fallbackSession.rawToken, new Date(iso(8)));
  assert.equal(fallbackStatus.id, fallback.draftId);
  assert.equal(fallbackStatus.children.length, 1);
  await assert.rejects(
    registrationStatusForSession(database, "unrelated-session", new Date(iso(8))),
    (error) => error.code === "session_required",
  );
  const fifo = database.query("SELECT registration_draft_child_id FROM registration_draft_waitlist_entry WHERE class_session_id = 'class-full-preferred' ORDER BY created_at, id");
  assert.equal(fifo.length, 2);
  assert.notEqual(fifo[0].registration_draft_child_id, fifo[1].registration_draft_child_id);

  const lateFree = await createRegistrationDraft(env(database), submission("class-roomy"), new Date(iso(8)));
  database.query("UPDATE registration_capacity_hold SET deadline_at = ? WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)", ["2026-08-11T08:08:30.000Z", lateFree.draftId]);
  const lateFreeChallenge = addChallenge(database, lateFree.draftId, lateFree.normalizedEmail, iso(8), iso(8 + 24 * 60));
  const reacquired = await confirmRegistrationChallenge(env(database), lateFreeChallenge, session(iso(9), iso(69)), new Date(iso(9)));
  assert.equal(reacquired.lateReacquired, true);
  assert.equal(reacquired.hasPaymentHold, true);

  database.query("UPDATE registration_capacity_hold SET deadline_at = ? WHERE registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE registration_draft_id = ?)", [iso(9), replacement.draftId]);
  const competitor = await createRegistrationDraft(env(database), submission("class-last-seat"), new Date(iso(10)));
  const replacementChallenge = addChallenge(database, replacement.draftId, replacement.normalizedEmail, iso(2), iso(2 + 24 * 60));
  const lost = await confirmRegistrationChallenge(env(database), replacementChallenge, session(iso(11), iso(71)), new Date(iso(11)));
  assert.equal(lost.status, "seat_unavailable");
  assert.equal(lost.hasPaymentHold, false);
  assert.equal(count(database, "registration_capacity_hold", `class_session_id = 'class-last-seat' AND status = 'active' AND deadline_at > '${iso(11)}'`), 1, "late confirmation cannot overbook competitor");
  assert.ok(competitor.draftId);

  const emailChangeDraft = await createRegistrationDraft(env(database), submission("class-roomy"), new Date(iso(12)));
  const beforeEmailChange = database.query(`
    SELECT deadline_at AS deadlineAt FROM registration_capacity_hold
    WHERE registration_draft_child_id IN (
      SELECT id FROM registration_draft_child WHERE registration_draft_id = ?
    )
  `, [emailChangeDraft.draftId])[0];
  const draftRow = database.query(`
    SELECT id, normalized_email AS normalizedEmail, email, status,
      email_last_sent_at AS emailLastSentAt, expires_at AS expiresAt
    FROM registration_draft WHERE id = ?
  `, [emailChangeDraft.draftId])[0];
  await changeDraftEmail(database, draftRow, "changed@example.test", new Date(iso(13)));
  const afterEmailChange = database.query(`
    SELECT deadline_at AS deadlineAt FROM registration_capacity_hold
    WHERE registration_draft_child_id IN (
      SELECT id FROM registration_draft_child WHERE registration_draft_id = ?
    )
  `, [emailChangeDraft.draftId])[0];
  assert.equal(afterEmailChange.deadlineAt, beforeEmailChange.deadlineAt, "changing email does not extend provisional hold");
  await markRegistrationEmailSent(database, emailChangeDraft.draftId, new Date(iso(13)));
  const sentDraft = { ...draftRow, emailLastSentAt: iso(13) };
  assert.throws(
    () => enforceResendCooldown(sentDraft, new Date("2026-08-11T08:13:30.000Z")),
    (error) => error.code === "resend_cooldown",
  );
  await assert.rejects(
    claimRegistrationEmailSend(database, sentDraft, new Date("2026-08-11T08:13:30.000Z")),
    (error) => error.code === "resend_cooldown",
  );
  const deadlineAfterResendBookkeeping = database.query(`
    SELECT deadline_at AS deadlineAt FROM registration_capacity_hold
    WHERE registration_draft_child_id IN (
      SELECT id FROM registration_draft_child WHERE registration_draft_id = ?
    )
  `, [emailChangeDraft.draftId])[0];
  assert.equal(deadlineAfterResendBookkeeping.deadlineAt, beforeEmailChange.deadlineAt, "resend bookkeeping does not extend provisional hold");

  const afterPaymentExpiry = await createRegistrationDraft(
    env(database),
    submission("class-roomy", undefined, 3),
    new Date("2026-08-13T09:00:00.000Z"),
  );
  assert.equal(afterPaymentExpiry.hasProvisionalHold, true, "expired 24-hour holds do not consume capacity");
  assert.equal(count(database, "guardian_account"), 0);
  assert.equal(count(database, "student"), 0);

  const replayDraft = await createRegistrationDraft(env(database), submission(undefined, "class-full-preferred"), new Date("2026-08-13T10:00:00.000Z"));
  const replayChallenge = addChallenge(
    database,
    replayDraft.draftId,
    replayDraft.normalizedEmail,
    "2026-08-13T10:00:00.000Z",
    "2026-08-14T10:00:00.000Z",
  );
  const firstVerification = await verifyEmailToken(env(database), replayChallenge.rawToken);
  assert.match(firstVerification.redirectUrl, /status=confirmed/);
  const sessionToken = decodeURIComponent(firstVerification.cookie.match(/^naran_verified_email=([^;]+)/)[1]);
  const friendlyReplay = await verifyEmailToken(env(database), replayChallenge.rawToken, sessionToken);
  assert.match(friendlyReplay.redirectUrl, /status=already-verified/);
  await assert.rejects(
    verifyEmailToken(env(database), replayChallenge.rawToken),
    (error) => error.code === "invalid_or_expired_token",
  );
  const storedChallenge = database.query("SELECT token_hash AS tokenHash FROM email_verification_challenge WHERE id = ?", [replayChallenge.id])[0];
  assert.notEqual(storedChallenge.tokenHash, replayChallenge.rawToken);

  const production = env(database, {
    APP_ENV: "production",
    REGISTRATION_WRITE_ENABLED: "false",
    EMAIL_ENABLED: "false",
    AUTH_EMAIL_ENABLED: "false",
  });
  await assert.rejects(createRegistrationDraft(production, submission("class-roomy")), (error) => error.code === "disabled");

  let siteverifyCalls = 0;
  globalThis.fetch = async (_url, init) => {
    siteverifyCalls += 1;
    const body = init.body;
    assert.equal(body.get("secret"), "1x0000000000000000000000000000000AA");
    return Response.json({ success: true, action: "registration_submit" });
  };
  await assert.rejects(verifyTurnstile(env(database), ""), (error) => error instanceof TurnstileError && error.code === "missing");
  assert.equal(siteverifyCalls, 0);
  await verifyTurnstile(env(database), "documented-test-token");
  assert.equal(siteverifyCalls, 1);
  globalThis.fetch = async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  await assert.rejects(verifyTurnstile(env(database), "bad-token"), (error) => error.code === "invalid");
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  await assert.rejects(verifyTurnstile(env(database), "network-token"), (error) => error.code === "unavailable");

  console.log("ok staged registration capacity, confirmation, waitlist, and Turnstile tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
