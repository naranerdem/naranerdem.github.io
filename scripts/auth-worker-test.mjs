import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveDeliveryAddress } from "../src/server/email/delivery-policy.ts";

const wranglerCli = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
const bundleDir = mkdtempSync(path.join(tmpdir(), "naranerdem-auth-worker-test-"));

function bundleWorker(name, environment) {
  const outputDir = path.join(bundleDir, name);
  const args = [wranglerCli, "deploy", "--dry-run", "--outdir", outputDir];
  if (environment === "production") args.push("--env=");
  else args.push("--env", "staging");

  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Worker bundle failed\n${result.stdout}\n${result.stderr}`);
  const modulePath = path.join(outputDir, "worker.mjs");
  cpSync(path.join(outputDir, "worker.js"), modulePath);
  return import(`${pathToFileURL(modulePath).href}?cache=${Date.now()}`);
}

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...values) {
    this.bindings = values;
    return this;
  }

  run() {
    return Promise.resolve(this.database.execute(this));
  }

  first() {
    return Promise.resolve(this.database.first(this));
  }

  all() {
    throw new Error("Unexpected all() in auth test");
  }
}

class FakeD1 {
  constructor() {
    this.outboundEmails = new Map();
    this.challenges = new Map();
    this.sessions = new Map();
    this.sqlLog = [];
    this.boundValues = [];
  }

  prepare(sql) {
    this.sqlLog.push(sql);
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    return statements.map((statement) => this.execute(statement));
  }

  execute(statement) {
    const sql = statement.sql.replace(/\s+/g, " ").trim();
    const values = statement.bindings;
    this.boundValues.push(...values);

    if (sql.startsWith("INSERT INTO outbound_email")) {
      const row = {
        id: values[0],
        eventType: values[1],
        intendedEmail: values[3],
        actualEmail: values[4],
        deliveryMode: values[5],
        status: "queued",
        attemptCount: 0,
        queuedAt: values[6],
        contextJson: values[7],
        idempotencyKey: values[8],
        isTest: values[9],
        testRunId: values[10],
        providerMessageId: null,
        failureCode: null,
      };
      assert.equal([...this.outboundEmails.values()].some((item) => item.idempotencyKey === row.idempotencyKey), false);
      this.outboundEmails.set(row.id, row);
      return this.result(1);
    }

    if (sql.startsWith("INSERT INTO email_verification_challenge")) {
      this.challenges.set(values[0], {
        id: values[0],
        normalizedEmail: values[1],
        tokenHash: values[2],
        outboundEmailId: values[3],
        createdAt: values[4],
        expiresAt: values[5],
        isTest: values[6],
        testRunId: values[7],
        registrationDraftId: values[9],
        status: "pending",
        usedAt: null,
        invalidatedAt: null,
      });
      return this.result(1);
    }

    if (sql.startsWith("UPDATE outbound_email") && sql.includes("status = 'sent'")) {
      const row = this.outboundEmails.get(values[4]);
      if (!row || !["queued", "failed"].includes(row.status)) return this.result(0);
      row.status = "sent";
      row.providerMessageId = values[0];
      row.attemptCount += values[1];
      row.failureCode = null;
      return this.result(1);
    }

    if (sql.startsWith("UPDATE outbound_email") && sql.includes("outbox_subject IS NULL")) {
      const row = this.outboundEmails.get(values[5]);
      if (!row || row.outboxSubject) return this.result(0);
      row.sensitivity = values[0];
      row.outboxSubject = values[1];
      row.outboxText = values[2];
      row.bccRecipientsJson = values[3];
      return this.result(1);
    }

    if (sql.startsWith("UPDATE outbound_email") && sql.includes("status = 'failed'")) {
      const row = this.outboundEmails.get(values[4]);
      if (!row || !["queued", "failed"].includes(row.status)) return this.result(0);
      row.status = "failed";
      row.attemptCount += values[0];
      row.failureCode = values[2];
      return this.result(1);
    }

    if (sql.startsWith("INSERT INTO verified_email_session")) {
      const challenge = [...this.challenges.values()].find((item) => item.tokenHash === values[4]);
      if (!challenge || challenge.status !== "pending" || challenge.expiresAt <= values[5] || challenge.invalidatedAt) {
        return this.result(0);
      }
      this.sessions.set(values[0], {
        id: values[0],
        normalizedEmail: challenge.normalizedEmail,
        sessionTokenHash: values[1],
        createdAt: values[2],
        expiresAt: values[3],
        isTest: challenge.isTest,
        testRunId: challenge.testRunId,
      });
      return this.result(1);
    }

    if (sql.startsWith("UPDATE email_verification_challenge")) {
      const challenge = [...this.challenges.values()].find((item) => item.tokenHash === values[2]);
      if (!challenge || challenge.status !== "pending" || challenge.expiresAt <= values[3] || challenge.invalidatedAt) {
        return this.result(0);
      }
      challenge.status = "used";
      challenge.usedAt = values[0];
      return this.result(1);
    }

    throw new Error(`Unexpected SQL in auth test: ${sql}`);
  }

  first(statement) {
    const sql = statement.sql.replace(/\s+/g, " ").trim();
    const values = statement.bindings;
    if (sql.includes("FROM outbound_email WHERE id = ?")) {
      const row = this.outboundEmails.get(values[0]);
      return row ? {
        sensitivity: row.sensitivity ?? null,
        bccRecipientsJson: row.bccRecipientsJson ?? null,
        outboxSubject: row.outboxSubject ?? null,
        eventType: row.eventType,
      } : null;
    }
    if (sql.includes("FROM email_verification_challenge") && sql.includes("WHERE token_hash = ?")) {
      const challenge = [...this.challenges.values()].find((item) => item.tokenHash === values[0]);
      if (!challenge) return null;
      return {
        id: challenge.id,
        normalizedEmail: challenge.normalizedEmail,
        status: challenge.status,
        expiresAt: challenge.expiresAt,
        invalidatedAt: challenge.invalidatedAt,
        registrationDraftId: challenge.registrationDraftId,
        isTest: challenge.isTest,
        testRunId: challenge.testRunId,
        outboundEmailId: challenge.outboundEmailId,
      };
    }
    throw new Error(`Unexpected first() SQL in auth test: ${sql}`);
  }

  result(changes) {
    return { success: true, results: [], meta: { changes } };
  }
}

function stagingEnv(database, overrides = {}) {
  return {
    APP_ENV: "staging",
    REGISTRATION_WRITE_ENABLED: "false",
    APP_ORIGIN: "https://staging.example.test",
    EMAIL_ENABLED: "true",
    AUTH_EMAIL_ENABLED: "true",
    EMAIL_FROM: "Наран Эрдэм <burtgel@mail.naranerdem.com>",
    RESEND_API_KEY: "resend-test-secret",
    STAGING_EMAIL_OVERRIDE_TO: "safe-inbox@example.test",
    STAGING_AUTH_TEST_KEY: "staging-gate-secret",
    DB: database,
    ...overrides,
  };
}

function productionEnv(database, overrides = {}) {
  return {
    ...stagingEnv(database),
    APP_ENV: "production",
    APP_ORIGIN: "https://naranerdem.com",
    STAGING_EMAIL_OVERRIDE_TO: undefined,
    ...overrides,
  };
}

function startRequest(email, key = "staging-gate-secret", method = "POST") {
  return new Request("https://staging.example.test/api/auth/email/start", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "X-Naran-Test-Key": key } : {}),
    },
    body: method === "POST" ? JSON.stringify({ email }) : undefined,
  });
}

function rawTokenFromMessage(message) {
  const match = message.text.match(/token=([A-Za-z0-9_-]+)/);
  assert.ok(match, "real plain-text template contains the one-time magic link");
  return match[1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

try {
  const verificationSource = readFileSync("src/server/auth/email-verification.ts", "utf8");
  assert.match(verificationSource, /REGISTRATION_PROVISIONAL_HOLD_TTL_SECONDS = 20 \* 60/);
  assert.match(verificationSource, /REGISTRATION_CONFIRMATION_TTL_SECONDS = 24 \* 60 \* 60/);
  assert.match(verificationSource, /AUTH_MAGIC_LINK_TTL_SECONDS = 15 \* 60/);
  const stagingWorker = (await bundleWorker("staging", "staging")).default;
  const productionWorker = (await bundleWorker("production", "production")).default;

  const gateDb = new FakeD1();
  let providerCallCount = 0;
  globalThis.fetch = async () => {
    providerCallCount += 1;
    return Response.json({ id: "should-not-send" });
  };
  assert.equal((await stagingWorker.fetch(startRequest("parent@example.com", ""), stagingEnv(gateDb))).status, 404);
  assert.equal((await stagingWorker.fetch(startRequest("parent@example.com", "wrong-key"), stagingEnv(gateDb))).status, 404);
  const wrongMethod = await stagingWorker.fetch(startRequest("parent@example.com", "staging-gate-secret", "GET"), stagingEnv(gateDb));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(providerCallCount, 0);

  const productionDb = new FakeD1();
  const productionStart = await productionWorker.fetch(
    new Request("https://naranerdem.com/api/auth/email/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Naran-Test-Key": "staging-gate-secret" },
      body: JSON.stringify({ email: "parent@example.com" }),
    }),
    productionEnv(productionDb),
  );
  assert.equal(productionStart.status, 404, "staging test gate never enables production sends");
  assert.equal(productionDb.outboundEmails.size, 0);

  const missingOverrideDb = new FakeD1();
  const missingOverride = await stagingWorker.fetch(
    startRequest("Parent@Example.COM"),
    stagingEnv(missingOverrideDb, { STAGING_EMAIL_OVERRIDE_TO: undefined }),
  );
  assert.equal(missingOverride.status, 503);
  assert.equal(missingOverrideDb.outboundEmails.size, 0);
  assert.equal(providerCallCount, 0);

  const successfulDb = new FakeD1();
  const providerCalls = [];
  const logicalSends = new Map();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    const key = new Headers(init.headers).get("Idempotency-Key");
    const authorization = new Headers(init.headers).get("Authorization");
    const message = JSON.parse(init.body);
    providerCalls.push({ key, authorization, message });
    if (!logicalSends.has(key)) {
      logicalSends.set(key, `resend-message-${logicalSends.size + 1}`);
      throw new TypeError("response lost after provider accepted the idempotent request");
    }
    return Response.json({ id: logicalSends.get(key) });
  };

  const started = await stagingWorker.fetch(startRequest(" Parent@Example.COM "), stagingEnv(successfulDb));
  assert.equal(started.status, 202, await started.text());
  assert.equal(providerCalls.length, 2, "one retry follows an ambiguous network failure");
  assert.equal(providerCalls[0].key, providerCalls[1].key);
  assert.equal(logicalSends.size, 1, "provider idempotency keeps one logical send");
  assert.equal(successfulDb.outboundEmails.size, 1);
  assert.equal(successfulDb.challenges.size, 1);

  const outbound = [...successfulDb.outboundEmails.values()][0];
  const challenge = [...successfulDb.challenges.values()][0];
  const deliveredMessage = providerCalls[1].message;
  const rawToken = rawTokenFromMessage(deliveredMessage);
  assert.equal(outbound.intendedEmail, "parent@example.com");
  assert.equal(outbound.actualEmail, "safe-inbox@example.test");
  assert.equal(outbound.deliveryMode, "staging_override");
  assert.equal(outbound.status, "sent");
  assert.equal(outbound.attemptCount, 2);
  assert.equal(challenge.tokenHash, sha256(rawToken));
  assert.notEqual(challenge.tokenHash, rawToken);
  assert.doesNotMatch(JSON.stringify(successfulDb.boundValues), new RegExp(rawToken));
  assert.doesNotMatch(outbound.contextJson, new RegExp(rawToken));
  assert.match(deliveredMessage.subject, /И-мэйл хаягаа баталгаажуулна уу/);
  assert.match(deliveredMessage.html, /И-мэйл хаягаа баталгаажуулах/);
  assert.match(deliveredMessage.text, /24 цаг/);
  assert.match(deliveredMessage.text, /\/verify-email\/#token=/);
  for (const forbidden of ["resend-test-secret", "staging-gate-secret"]) {
    assert.doesNotMatch(deliveredMessage.html, new RegExp(forbidden));
    assert.doesNotMatch(deliveredMessage.text, new RegExp(forbidden));
  }

  const scannerGet = await stagingWorker.fetch(
    new Request(`https://staging.example.test/api/auth/email/verify?token=${rawToken}`),
    stagingEnv(successfulDb),
  );
  assert.equal(scannerGet.status, 405, "scanner GET cannot consume a registration confirmation");
  assert.equal(scannerGet.headers.get("allow"), "POST");
  assert.equal(successfulDb.sessions.size, 0);
  assert.equal(challenge.status, "pending");

  const wrongToken = await stagingWorker.fetch(
    new Request("https://staging.example.test/api/auth/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    }),
    stagingEnv(successfulDb),
  );
  assert.equal(wrongToken.status, 400);
  assert.equal(successfulDb.sessions.size, 0);

  const verified = await stagingWorker.fetch(
    new Request("https://staging.example.test/api/auth/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: rawToken }),
    }),
    stagingEnv(successfulDb),
  );
  assert.equal(verified.status, 303);
  assert.equal(verified.headers.get("location"), "https://staging.example.test/register/?email=verified");
  const cookie = verified.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^naran_verified_email=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=3600/);
  assert.equal(successfulDb.sessions.size, 1);
  assert.equal(challenge.status, "used");
  assert.equal([...successfulDb.sessions.values()][0].normalizedEmail, "parent@example.com");

  const replay = await stagingWorker.fetch(
    new Request("https://staging.example.test/api/auth/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: rawToken }),
    }),
    stagingEnv(successfulDb),
  );
  assert.equal(replay.status, 400);
  assert.equal(successfulDb.sessions.size, 1);

  const unsupportedVerify = await stagingWorker.fetch(
    new Request("https://staging.example.test/api/auth/email/verify"),
    stagingEnv(successfulDb),
  );
  assert.equal(unsupportedVerify.status, 405);
  assert.equal(unsupportedVerify.headers.get("allow"), "POST");

  const expiredDb = new FakeD1();
  const expiredMessages = [];
  globalThis.fetch = async (_url, init) => {
    expiredMessages.push(JSON.parse(init.body));
    return Response.json({ id: "resend-expired-test" });
  };
  assert.equal((await stagingWorker.fetch(startRequest("expired@example.com"), stagingEnv(expiredDb))).status, 202);
  const expiredToken = rawTokenFromMessage(expiredMessages[0]);
  [...expiredDb.challenges.values()][0].expiresAt = "2000-01-01T00:00:00.000Z";
  const expired = await stagingWorker.fetch(
    new Request("https://staging.example.test/api/auth/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: expiredToken }),
    }),
    stagingEnv(expiredDb),
  );
  assert.equal(expired.status, 400);
  assert.equal(expiredDb.sessions.size, 0);

  const failedDb = new FakeD1();
  let failureCalls = 0;
  globalThis.fetch = async () => {
    failureCalls += 1;
    return Response.json({ error: "provider unavailable", apiKey: "must-not-leak" }, { status: 503 });
  };
  const failed = await stagingWorker.fetch(startRequest("failed@example.com"), stagingEnv(failedDb));
  assert.equal(failed.status, 503);
  assert.equal(failureCalls, 2);
  const failedOutbound = [...failedDb.outboundEmails.values()][0];
  assert.equal(failedOutbound.status, "failed");
  assert.equal(failedOutbound.attemptCount, 2);
  assert.equal(failedOutbound.failureCode, "provider_rejected");
  assert.doesNotMatch(await failed.text(), /provider unavailable|apiKey|must-not-leak/i);

  assert.deepEqual(
    resolveDeliveryAddress("production", "parent@example.com", "ignored@example.com"),
    { actualEmail: "parent@example.com", deliveryMode: "production" },
  );
  assert.doesNotMatch(successfulDb.sqlLog.join("\n"), /guardian_account|student/i);
  const authSources = [
    "src/server/auth/crypto.ts",
    "src/server/auth/email-verification.ts",
    "src/server/email/service.ts",
    "src/server/email/resend.ts",
  ].map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(authSources, /console\.(log|info|warn|error)/);

  console.log("ok email verification security and Worker route tests");
} finally {
  rmSync(bundleDir, { recursive: true, force: true });
}
