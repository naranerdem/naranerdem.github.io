import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

// A disposable local Worker/D1 test. It creates a regular hashed staff session
// in local D1; neither the Worker nor production authentication is bypassed.
const persistDir = mkdtempSync(path.join(tmpdir(), "naranerdem-archive-bcc-browser-"));
const rawSessionToken = randomUUID();
const sessionHash = createHash("sha256").update(rawSessionToken).digest("hex");
const port = 19200 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
const wranglerCli = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
let worker;
let browser;
let context;
let workerOutput = "";

function runWrangler(args, label) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${label} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function sql(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function execute(command) {
  runWrangler(["d1", "execute", "DB", "--env", "staging", "--local", "--persist-to", persistDir, "--command", command], "local D1 setup");
}

async function waitForWorker() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Local Worker did not become ready: ${String(lastError)}\n${workerOutput}`);
}

async function openArchiveForm(page) {
  const details = page.locator("#email-archive-bcc-setting details");
  if (!await details.evaluate((node) => node.open)) await details.locator("summary").click();
  await page.locator("#email-archive-bcc-form").waitFor({ state: "visible" });
  return page.locator("#email-archive-bcc-form");
}

async function save(page, adminValue, teacherValue = "") {
  const form = await openArchiveForm(page);
  await form.locator("#email-archive-bcc-admin-recipients").fill(adminValue);
  await form.locator("#email-archive-bcc-teacher-recipients").fill(teacherValue);
  const request = page.waitForRequest((candidate) => candidate.url().endsWith("/api/staff/program-calendar") && candidate.method() === "POST");
  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/staff/program-calendar") && candidate.request().method() === "POST");
  await form.getByRole("button", { name: "Хадгалах" }).click();
  const completed = await response;
  if (completed.ok()) {
    await page.waitForFunction(() => !document.querySelector("#email-archive-bcc-setting details")?.open
      && document.querySelector("#tool-message")?.textContent?.includes("И-мэйлийн дотоод хуулбарыг хадгаллаа."));
  }
  return { request: await request, response: completed };
}

async function savedRecipients(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/staff/settings/email-archive-bcc", { credentials: "same-origin" });
    return (await response.json()).setting;
  });
}

async function saveSeatCountThreshold(page, value) {
  const details = page.locator("#public-seat-count-threshold-setting details");
  if (!await details.evaluate((node) => node.open)) await details.locator("summary").click();
  const form = page.locator("#public-seat-count-threshold-form");
  await form.locator("#public-seat-count-threshold").fill(value);
  const request = page.waitForRequest((candidate) => candidate.url().endsWith("/api/staff/program-calendar") && candidate.method() === "POST");
  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/staff/program-calendar") && candidate.request().method() === "POST");
  await form.getByRole("button", { name: "Хадгалах" }).click();
  return { request: await request, response: await response };
}

try {
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "local migrations");
  const now = new Date().toISOString();
  execute(`INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('archive-admin', 'archive-admin@example.test', 'Archive Admin', 'active', 1, 'browser-archive-bcc', ${sql(now)}, ${sql(now)});
    INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at) VALUES ('archive-admin', 'admin', ${sql(now)});
    INSERT INTO staff_session (id, staff_account_id, session_token_hash, created_at, expires_at, last_seen_at, is_test, test_run_id)
    VALUES ('archive-session', 'archive-admin', ${sql(sessionHash)}, ${sql(now)}, '2027-12-31T00:00:00.000Z', ${sql(now)}, 1, 'browser-archive-bcc');`);
  worker = spawn(process.execPath, [wranglerCli, "dev", "--env", "staging", "--local", "--persist-to", persistDir,
    "--ip", "127.0.0.1", "--port", String(port), "--var", `APP_ORIGIN:${baseUrl}`], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });
  await waitForWorker();

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.addCookies([{ name: "naran_staff_session", value: rawSessionToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/staff/settings/`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  assert.match(await page.locator("#email-archive-bcc-setting").textContent(), /таслал эсвэл шинэ мөрөөр/, "form explains supported separators");

  const dotted = "dotted.name+tag@example.test";
  let saved = await save(page, dotted, "teacher.one@example.test");
  assert.equal(saved.response.status(), 200, "a dotted plus-address saves through the rendered form");
  assert.deepEqual(JSON.parse(saved.request.postData() ?? "{}").adminRecipients, [dotted], "the client preserves admin dots and plus tags");
  assert.deepEqual(JSON.parse(saved.request.postData() ?? "{}").teacherRecipients, ["teacher.one@example.test"], "the client keeps the teacher list separate");
  let setting = await savedRecipients(page);
  assert.deepEqual(setting.adminRecipients, [dotted], "admin recipients persist");
  assert.deepEqual(setting.teacherRecipients, ["teacher.one@example.test"], "teacher recipients persist");
  await page.reload(); await page.locator("#tool-app").waitFor({ state: "visible" });
  assert.equal(await (await openArchiveForm(page)).locator("#email-archive-bcc-admin-recipients").inputValue(), dotted, "saved admin address reloads in the real form");
  assert.equal(await (await openArchiveForm(page)).locator("#email-archive-bcc-teacher-recipients").inputValue(), "teacher.one@example.test", "saved teacher address reloads in the real form");

  saved = await save(page, "comma.one@example.test, comma.two+tag@example.test", "teacher.two@example.test");
  assert.equal(saved.response.status(), 200, "comma-separated addresses save");
  assert.deepEqual((await savedRecipients(page)).adminRecipients, ["comma.one@example.test", "comma.two+tag@example.test"]);

  saved = await save(page, "lf.one@example.test\nlf.two@example.test", "teacher.lf@example.test");
  assert.equal(saved.response.status(), 200, "LF-separated addresses save");
  assert.deepEqual((await savedRecipients(page)).adminRecipients, ["lf.one@example.test", "lf.two@example.test"]);

  saved = await save(page, "crlf.one@example.test\r\ncrlf.two@example.test", "teacher.crlf@example.test");
  assert.equal(saved.response.status(), 200, "CRLF-separated addresses save");
  assert.deepEqual((await savedRecipients(page)).adminRecipients, ["crlf.one@example.test", "crlf.two@example.test"]);

  const retained = ["trim.one@example.test", "trim.two+tag@example.test"];
  saved = await save(page, " \n trim.one@example.test ,\r\n trim.two+tag@example.test,\n\n", " teacher.trim@example.test ");
  assert.equal(saved.response.status(), 200, "whitespace and trailing separators are ignored");
  assert.deepEqual((await savedRecipients(page)).adminRecipients, retained);

  const invalidValue = "valid@example.test, invalid-address";
  const form = await openArchiveForm(page);
  await form.locator("#email-archive-bcc-admin-recipients").fill(invalidValue);
  const rejected = page.waitForResponse((candidate) => candidate.url().endsWith("/api/staff/program-calendar") && candidate.request().method() === "POST");
  await form.getByRole("button", { name: "Хадгалах" }).click();
  assert.equal((await rejected).status(), 400, "one invalid address rejects the save");
  assert.match(await page.locator("#tool-message").textContent(), /invalid-address/, "the authenticated admin sees the invalid entry");
  assert.equal(await form.locator("#email-archive-bcc-admin-recipients").inputValue(), invalidValue, "a rejected save retains the entered values");
  assert.deepEqual((await savedRecipients(page)).adminRecipients, retained, "a rejected save keeps the prior persisted setting");
  assert.deepEqual((await savedRecipients(page)).teacherRecipients, ["teacher.trim@example.test"], "a rejected save leaves the other internal-recipient list unchanged");

  const literalBackslashN = "literal.one@example.test\\nliteral.two@example.test";
  await form.locator("#email-archive-bcc-admin-recipients").fill(literalBackslashN);
  const literalRejected = page.waitForResponse((candidate) => candidate.url().endsWith("/api/staff/program-calendar") && candidate.request().method() === "POST");
  await form.getByRole("button", { name: "Хадгалах" }).click();
  assert.equal((await literalRejected).status(), 400, "literal backslash-n is not treated as a newline separator");
  assert.deepEqual((await savedRecipients(page)).adminRecipients, retained, "literal backslash-n rejection also preserves the saved setting");
  const thresholdSave = await saveSeatCountThreshold(page, "2");
  assert.equal(thresholdSave.response.status(), 200, "the rendered threshold setting accepts a nonnegative integer");
  assert.equal(JSON.parse(thresholdSave.request.postData() ?? "{}").remainingSeatThreshold, 2, "the setting form sends the numeric threshold without changing capacity state");
  const overview = await page.evaluate(async () => (await fetch("/api/staff/program-calendar", { credentials: "same-origin" })).json());
  assert.equal(overview.publicSeatCountThreshold.remainingSeatThreshold, 2, "the saved public threshold reloads through the authorized staff overview");
  console.log("ok browser archive BCC entry formats, feedback, and persistence");
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}
