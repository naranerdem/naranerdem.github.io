import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = mkdtempSync(path.join(tmpdir(), "naranerdem-payment-reminder-safety-"));
const databasePath = path.join(directory, "reminders.sqlite3");
const reminderBundle = path.join(directory, "payment-reminders.mjs");
const cancellationBundle = path.join(directory, "payment-reminder-delivery.mjs");
const now = "2026-09-30T21:13:00.000Z";

function sql(source, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], {
    input: `PRAGMA foreign_keys=ON;\n${source}`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function quote(value) { return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
function bind(statement, values) {
  let index = 0;
  const bound = statement.replaceAll("?", () => quote(values[index++]));
  assert.equal(index, values.length, "all D1 bindings are consumed");
  return bound;
}
class Statement {
  constructor(database, statement) { this.database = database; this.statement = statement; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.statement, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.statement, this.values) }; }
  async run() {
    const rows = this.database.query(`${this.statement}; SELECT changes() AS changes`, this.values);
    return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } };
  }
}
class Database {
  prepare(statement) { return new Statement(this, statement); }
  query(statement, values = []) { const result = sql(`${bind(statement, values)};`, true); return result ? JSON.parse(result) : []; }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}
function env(DB, authorizedRun = "allowed-run") {
  return {
    APP_ENV: "staging", EMAIL_ENABLED: "true", RESEND_API_KEY: "no-send-key",
    EMAIL_FROM: "Naran Erdem <staging@example.test>", STAGING_EMAIL_OVERRIDE_TO: "safe@example.test",
    STAGING_TEST_EMAIL_RUN_ID: authorizedRun, DB,
  };
}
function seed(database, id, testRunId, dueAt = now, { isTest = true } = {}) {
  const stamp = "2026-09-30T20:00:00.000Z";
  database.query(`INSERT INTO registration_draft (
    id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email,
    home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 'year', 'Тест Асран', 'Ээж', '99000000', ?, ?, 'Тест хаяг', 'single', 'parent-rule', 'student-rule', 'awaiting_initial_payment', '2026-10-02T02:00:00.000Z', ?, ?, ?, ?)`,
  [id, `${id}-hash`.padEnd(64, "0"), `${id}@example.test`, `${id}@example.test`, Number(isTest), isTest ? testRunId : null, stamp, stamp]);
  database.query(`INSERT INTO registration_draft_child (
    id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status,
    selected_stage_code, selected_class_session_id, status, initial_payment_amount_mnt, payment_plan_code, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 0, 'Тест', ?, 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class', 'awaiting_initial_payment', 1000000, 'single', ?, ?, ?, ?)`,
  [`${id}-child`, id, id, Number(isTest), isTest ? testRunId : null, stamp, stamp]);
  database.query(`INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
    VALUES (?, ?, 'class', 'initial_payment', 'active', '2026-10-02T02:00:00.000Z', ?, ?, ?, ?)`, [`${id}-hold`, `${id}-child`, Number(isTest), isTest ? testRunId : null, stamp, stamp]);
  database.query(`INSERT INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [`${id}-request`, id, `NE-${id.toUpperCase()}`, stamp, stamp, Number(isTest), isTest ? testRunId : null]);
  database.query(`INSERT INTO payment_installment (
    id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt,
    original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, 1, 'initial', 1000000, ?, ?, 60, ?, 'pending', ?, ?, ?, ?)`,
  [`${id}-installment`, `${id}-request`, `${id}-child`, dueAt, dueAt, dueAt, stamp, stamp, Number(isTest), isTest ? testRunId : null]);
}

try {
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  sql(migrations.map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  for (const [source, output] of [["src/server/staff/payment-reminders.ts", reminderBundle], ["src/server/email/payment-reminder-delivery.ts", cancellationBundle]]) {
    const build = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(build.stderr);
  }
  const { processDuePaymentReminders } = await import(pathToFileURL(reminderBundle).href);
  const { cancelUnauthorisedPaymentReminderStatements } = await import(pathToFileURL(cancellationBundle).href);
  const database = new Database();
  database.query(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year', 'Тест', 'open', 1, 1, 'reminder-safety-test', ?, ?);
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('offering', 'annual_course', 'Тест сургалт', 'year', 'stage_1', 1, 'paid', 'active', 1, 'reminder-safety-test', ?, ?);
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
    VALUES ('class', 'offering', 'year', 'stage_1', 'Тест анги', 'Мягмар', '09:00', '10:20', 10, 'available', 1, 1, 'reminder-safety-test', ?, ?);`,
  [now, now, now, now, now, now]);

  seed(database, "suppressed", "other-run");
  const sent = [];
  const provider = { async send(message) { sent.push(message); return { providerMessageId: `provider-${sent.length}` }; } };
  await processDuePaymentReminders(env(database), new Date(now), provider);
  const suppressed = database.query(`SELECT status, last_error_code AS errorCode FROM payment_notification_milestone WHERE registration_draft_id = 'suppressed'`)[0];
  assert.deepEqual(suppressed, { status: "cancelled", errorCode: "staging_test_delivery_not_authorized" }, "a recipient override alone never authorizes a synthetic staging reminder");
  assert.equal(sent.length, 0, "suppressed staging work never reaches the provider");
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = 'suppressed'`)[0].count, 0, "suppression is terminal and creates no retrying Outbox row");

  seed(database, "authorized", "allowed-run");
  await processDuePaymentReminders(env(database), new Date("2026-09-30T21:14:00.000Z"), provider);
  assert.equal(sent.length, 1, "an exact test-run authorization permits its synthetic reminder");
  assert.match(sent[0].subject, /\[STAGING TEST\]/, "authorized staging delivery is visibly labelled");
  assert.match(sent[0].text, /Улаанбаатарын цагаар/, "the deadline names its timezone");
  assert.match(sent[0].text, /хугацаа өнгөрсөн/, "a queued reminder re-renders from processing time when it is now overdue");
  const authorizedOutbox = database.query(`SELECT status, delivery_authorized_at AS authorizedAt FROM outbound_email WHERE registration_draft_id = 'authorized'`)[0];
  assert.equal(authorizedOutbox.status, "sent");
  assert.ok(authorizedOutbox.authorizedAt, "the provider send has a durable authorization marker");

  seed(database, "cancel-before", "allowed-run");
  await processDuePaymentReminders(env(database), new Date("2026-09-30T21:15:00.000Z"), provider, {
    beforeDeliveryAuthorization: async (milestone) => {
      if (milestone.registrationDraftId === "cancel-before") {
        await database.batch(cancelUnauthorisedPaymentReminderStatements(env(database), milestone.registrationDraftChildId, "2026-09-30T21:15:00.500Z"));
      }
    },
  });
  assert.equal(sent.length, 1, "cancellation before authorization makes no provider call");
  assert.equal(database.query(`SELECT status FROM payment_notification_milestone WHERE registration_draft_id = 'cancel-before'`)[0].status, "cancelled");
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = 'cancel-before'`)[0].count, 0);

  seed(database, "cancel-after", "allowed-run");
  const boundaryProvider = { async send(message) {
    await database.batch(cancelUnauthorisedPaymentReminderStatements(env(database), "cancel-after-child", "2026-09-30T21:16:00.500Z"));
    sent.push(message);
    return { providerMessageId: "provider-boundary" };
  } };
  await processDuePaymentReminders(env(database), new Date("2026-09-30T21:16:00.000Z"), boundaryProvider);
  const boundary = database.query(`SELECT milestone.status AS milestoneStatus, email.status AS emailStatus, email.delivery_authorized_at AS authorizedAt
    FROM payment_notification_milestone AS milestone INNER JOIN outbound_email AS email ON email.id = milestone.outbound_email_id
    WHERE milestone.registration_draft_id = 'cancel-after'`)[0];
  assert.deepEqual({ milestoneStatus: boundary.milestoneStatus, emailStatus: boundary.emailStatus }, { milestoneStatus: "sent", emailStatus: "sent" },
    "a cancellation after durable authorization does not falsely mark an already-submitted delivery cancelled");
  assert.ok(boundary.authorizedAt);

  seed(database, "normal", "not-used", now, { isTest: false });
  const normalProvider = { async send(message, options) {
    sent.push({ message, options });
    return { providerMessageId: "provider-normal" };
  } };
  await processDuePaymentReminders(env(database), new Date("2026-09-30T21:17:00.000Z"), normalProvider);
  assert.equal(database.query(`SELECT status FROM payment_notification_milestone WHERE registration_draft_id = 'normal' AND milestone_type = 'initial_overdue'`)[0].status, "sent",
    "an ordinary eligible reminder remains deliverable without a staging-test authorization");
  assert.doesNotMatch(sent.at(-1).message.subject, /STAGING TEST/, "ordinary reminders are not labelled as synthetic tests");

  seed(database, "retry", "allowed-run");
  const retryKeys = [];
  let retryAttempts = 0;
  const retryProvider = { async send(_message, options) {
    retryAttempts += 1;
    retryKeys.push(options.idempotencyKey);
    if (retryAttempts === 1) throw new Error("synthetic no-send transport failure");
    return { providerMessageId: "provider-retry" };
  } };
  assert.equal(await processDuePaymentReminders(env(database), new Date("2026-09-30T21:18:00.000Z"), retryProvider), 0);
  assert.equal(await processDuePaymentReminders(env(database), new Date("2026-09-30T21:19:00.000Z"), retryProvider), 1);
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = 'retry'`)[0].count, 1,
    "a retry preserves one Outbox identity");
  assert.deepEqual(retryKeys, [retryKeys[0], retryKeys[0]], "a retry keeps the provider idempotency key");

  seed(database, "overlap", "allowed-run");
  let overlapCalls = 0;
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const overlapProvider = { async send() {
    overlapCalls += 1;
    await providerGate;
    return { providerMessageId: "provider-overlap" };
  } };
  const firstWorker = processDuePaymentReminders(env(database), new Date("2026-09-30T21:20:00.000Z"), overlapProvider);
  while (overlapCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  const secondWorker = processDuePaymentReminders(env(database), new Date("2026-09-30T21:20:00.000Z"), overlapProvider);
  releaseProvider();
  await Promise.all([firstWorker, secondWorker]);
  assert.equal(overlapCalls, 1, "overlapping scheduler workers authorize one provider delivery");
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM outbound_email WHERE registration_draft_id = 'overlap'`)[0].count, 1);

  const templateBundle = path.join(directory, "payment-reminder-template.mjs");
  const templateBuild = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/email/templates/payment-reminder.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${templateBundle}`], { encoding: "utf8" });
  if (templateBuild.status !== 0) throw new Error(templateBuild.stderr);
  const { paymentReminderTemplate } = await import(pathToFileURL(templateBundle).href);
  const upcoming = paymentReminderTemplate({ milestoneType: "later_reminder", childName: "Тест", classLabel: "Анги", amountMnt: 1,
    dueAt: "2026-10-01T00:01:00.000Z", processingAt: "2026-10-01T00:00:00.000Z", parentClaimed: false, bankName: null, accountHolderName: null, accountNumber: null, iban: null, transferInstruction: null });
  assert.match(upcoming.text, /Дараагийн төлбөрийн хугацаа ойртож байна/);
  const overdue = paymentReminderTemplate({ milestoneType: "later_reminder", childName: "Тест", classLabel: "Анги", amountMnt: 1,
    dueAt: "2026-09-30T20:34:00.000Z", processingAt: now, parentClaimed: false, bankName: null, accountHolderName: null, accountNumber: null, iban: null, transferInstruction: null });
  assert.match(overdue.text, /Төлбөрийн хугацаа өнгөрсөн/);
  assert.match(overdue.text, /Улаанбаатарын цагаар/);
  console.log("ok reminder safety: staging authorization, deadline wording, and cancellation boundary");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
