import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

// This is a disposable local Worker/D1 integration test. Its session is a
// normally hashed test-only staff_session; no runtime authentication bypass is
// added to the Worker or production configuration.
const persistDir = mkdtempSync(path.join(tmpdir(), "naranerdem-credit-browser-"));
const testRunId = `browser-credit-${randomUUID()}`;
const rawSessionToken = randomUUID();
const sessionHash = createHash("sha256").update(rawSessionToken).digest("hex");
const port = 18789 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
const wranglerCli = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
let worker;
let workerOutput = "";
let browser;
let context;
let page;
let publicContext;
let passed = false;
let failureDetails = "";
const paymentPanelScreenshotDir = process.env.PAYMENT_PANEL_SCREENSHOT_DIR || "";

async function capturePaymentPanel(page, name) {
  if (!paymentPanelScreenshotDir) return;
  mkdirSync(paymentPanelScreenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(paymentPanelScreenshotDir, name), fullPage: true });
}

function runWrangler(args, label) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${label} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function waitForWorker() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Local Worker did not become ready: ${String(lastError)}\n${workerOutput}`);
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function execute(sqlText) {
  runWrangler([
    "d1", "execute", "DB", "--env", "staging", "--local", "--persist-to", persistDir,
    "--command", sqlText,
  ], "local D1 fixture setup");
}

function fixtureSql() {
  const now = new Date().toISOString();
  const openStart = "2026-01-01";
  const openEnd = "2027-12-31";
  return `
    PRAGMA foreign_keys = ON;
    INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('browser-year', 'Browser credit test year', 'open', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('browser-offering', 'annual_course', 'Browser credit offering', 'browser-year', 'stage_1', '2026-09-08', 1, 'paid', 'active', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
      VALUES
      ('browser-class-source', 'browser-offering', 'browser-year', 'stage_1', 'Browser credit source class', 'Мягмар', '09:00', '10:20', 30, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)}),
      ('browser-class-target', 'browser-offering', 'browser-year', 'stage_1', 'Browser credit target class', 'Мягмар', '15:00', '16:20', 30, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, last_date, weekly_weekday, start_time, end_time, created_at, updated_at)
      VALUES
      ('browser-class-source', 'weekly', '2026-09-08', NULL, 'Мягмар', '09:00', '10:20', ${sql(now)}, ${sql(now)}),
      ('browser-class-target', 'weekly', '2026-09-08', NULL, 'Мягмар', '15:00', '16:20', ${sql(now)}, ${sql(now)});
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES
      ('browser-offering-high', 'annual_course', 'Browser higher transfer offering', 'browser-year', 'stage_2', 1, 'paid', 'active', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)}),
      ('browser-offering-low', 'annual_course', 'Browser lower transfer offering', 'browser-year', 'stage_3', 1, 'paid', 'active', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
      VALUES
      ('browser-class-high', 'browser-offering-high', 'browser-year', 'stage_2', 'Browser higher transfer class', 'Wednesday', '09:00', '10:20', 30, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)}),
      ('browser-class-low', 'browser-offering-low', 'browser-year', 'stage_3', 'Browser lower transfer class', 'Thursday', '09:00', '10:20', 30, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)}),
      ('browser-class-waitlist', 'browser-offering', 'browser-year', 'stage_1', 'Browser waitlist class', 'Friday', '09:00', '10:20', 30, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO offering_course_pricing (activity_offering_id, one_time_amount_mnt, two_installment_enabled, first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at)
      VALUES
      ('browser-offering', 1000, 1, 500, 500, '2027-06-01', ${sql(now)}, ${sql(now)});
    INSERT INTO offering_course_pricing (activity_offering_id, one_time_amount_mnt, two_installment_enabled, first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at)
      VALUES
      ('browser-offering-high', 1200, 1, 600, 600, '2027-06-01', ${sql(now)}, ${sql(now)}),
      ('browser-offering-low', 800, 1, 400, 400, '2027-06-01', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_window (id, name, starts_on, ends_on, is_test, test_run_id, created_at, updated_at)
      VALUES ('browser-window', 'Browser test registration window', ${sql(openStart)}, ${sql(openEnd)}, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO registration_window_offering (registration_window_id, activity_offering_id, created_at)
      VALUES ('browser-window', 'browser-offering', ${sql(now)}),
        ('browser-window', 'browser-offering-high', ${sql(now)}),
        ('browser-window', 'browser-offering-low', ${sql(now)});
    UPDATE payment_collection_settings
      SET bank_name = 'Browser test bank', account_holder_name = 'Browser test holder',
        account_number = '0000000000', transfer_instruction = 'Browser test transfer', updated_at = ${sql(now)}
      WHERE singleton = 1;
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('browser-credit-teacher', 'browser-credit-teacher@example.test', 'Browser Credit Teacher', 'active', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at)
      VALUES ('browser-credit-teacher', 'teacher', ${sql(now)}),
        ('browser-credit-teacher', 'admin', ${sql(now)});
    INSERT INTO staff_session (id, staff_account_id, session_token_hash, created_at, expires_at, last_seen_at, is_test, test_run_id)
      VALUES ('browser-credit-session', 'browser-credit-teacher', ${sql(sessionHash)}, ${sql(now)}, '2027-12-31T00:00:00.000Z', ${sql(now)}, 1, ${sql(testRunId)});
    UPDATE discount_policy_setting SET family_multi_child_basis_points = 1000, updated_at = ${sql(now)} WHERE singleton = 1;
  `;
}

async function dbJson(query) {
  const result = runWrangler([
    "d1", "execute", "DB", "--env", "staging", "--local", "--persist-to", persistDir,
    "--command", query, "--json",
  ], "local D1 assertion");
  const parsed = JSON.parse(result.stdout);
  return parsed[0]?.results ?? [];
}

async function waitForDb(query, predicate, label) {
  const deadline = Date.now() + 8_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await dbJson(query);
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(rows)}\nLocal Worker output:\n${workerOutput.slice(-4_000)}`);
}

async function fillIntake(page, childName, paymentPlanCode = "two_installment", options = {}) {
  const stage = options.stage ?? "stage_1";
  const classSessionId = options.classSessionId ?? "browser-class-source";
  await page.goto(`${baseUrl}/staff/registration-intake/`);
  await page.locator("#intake-app").waitFor({ state: "visible" });
  await page.selectOption('select[name="intakeChannel"]', "paper_form");
  await page.fill('input[name="guardianName"]', `Browser guardian ${childName}`);
  await page.selectOption('select[name="guardianRelationship"]', "Ээж");
  await page.fill('input[name="guardianEmail"]', `${childName.toLowerCase()}@example.test`);
  await page.fill('input[name="guardianPhone"]', "99112233");
  await page.fill('input[name="guardianSecondaryPhone"]', "00112233");
  await page.fill('input[name="guardianFacebook"]', `Browser guardian ${childName}`);
  await page.fill('textarea[name="guardianAddress"]', "Browser test district");
  await page.fill('input[name="surname"]', "Browser");
  await page.fill('input[name="givenName"]', childName);
  await page.fill('input[name="dateOfBirth"]', "2015-05-10");
  await page.selectOption('select[name="currentGrade"]', "5");
  await page.selectOption('select[name="stage"]', stage);
  await page.selectOption('select[name="classSessionId"]', classSessionId);
  await page.selectOption('select[name="paymentPlanCode"]', paymentPlanCode);
  await page.check('input[name="parentRulesAcknowledged"]');
  await page.check('input[name="studentRulesAcknowledged"]');
  const submission = page.waitForResponse((response) => response.url().endsWith("/api/staff/registration-intake") && response.request().method() === "POST");
  await page.click("#intake-submit");
  const submissionResponse = await submission;
  try {
    await page.waitForURL(/\/staff\/payments\/\?registration=/);
  } catch (error) {
    throw new Error(`staff intake did not navigate: ${await page.locator("#intake-status").textContent()} / ${await submissionResponse.text()} at ${page.url()} (${String(error)})`);
  }
  return new URL(page.url()).searchParams.get("registration");
}

async function installTurnstileTestWidget(page) {
  // The browser substitutes only Cloudflare's external widget. The local
  // Worker still executes its normal Siteverify request with the staging test
  // secret, so registration submission is not replaced with a canned API.
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `window.turnstile={render(_element,options){queueMicrotask(()=>options.callback("XXXX.DUMMY.TOKEN.XXXX"));return 1},reset(){}};`,
    });
  });
}

async function submitPublicRegistration(browser, { childName, email, paymentPlanCode, expectedInitialAmount, siblings = [] }) {
  publicContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const publicPage = await publicContext.newPage();
  await installTurnstileTestWidget(publicPage);
  await publicPage.goto(`${baseUrl}/register/?new=1`);
  await publicPage.locator("#registration-form").waitFor({ state: "visible" });

  await publicPage.fill("#guardian-name", "Browser public guardian");
  await publicPage.selectOption("#guardian-relationship", { label: "Ээж" });
  await publicPage.fill("#guardian-email", email);
  await publicPage.fill("#guardian-phone", "99112234");
  await publicPage.fill("#guardian-secondary-phone", "00112233");
  await publicPage.fill("#guardian-facebook", "Browser public guardian");
  await publicPage.fill("#guardian-address", "Browser public test district");
  const card = publicPage.locator("[data-child-card]");
  await card.locator("[data-child-surname]").fill("Browser");
  await card.locator("[data-child-name]").fill(childName);
  await card.locator("[data-child-grade]").selectOption("5");
  await card.locator("[data-child-gender]").selectOption({ label: "Эмэгтэй" });
  await card.locator("[data-child-dob]").fill("2015-05-10");
  await card.locator('[data-child-returning][value="no"]').check();
  await card.locator("[data-child-stage]").selectOption("stage_1");
  await card.locator('[data-child-class][value="browser-class-source"]').check();
  await card.locator(`[data-child-payment-plan][value="${paymentPlanCode}"]`).check();
  for (const [index, sibling] of siblings.entries()) {
    await publicPage.locator("[data-add-child]").click();
    const siblingCard = publicPage.locator("[data-child-card]").nth(index + 1);
    await siblingCard.locator("[data-child-surname]").fill("Browser");
    await siblingCard.locator("[data-child-name]").fill(sibling.childName);
    await siblingCard.locator("[data-child-grade]").selectOption("5");
    await siblingCard.locator("[data-child-gender]").selectOption({ label: "Эрэгтэй" });
    await siblingCard.locator("[data-child-dob]").fill("2016-05-10");
    await siblingCard.locator('[data-child-returning][value="no"]').check();
    await siblingCard.locator("[data-child-stage]").selectOption("stage_1");
    await siblingCard.locator(`[data-child-class][value="${sibling.classSessionId}"]`).check();
    await siblingCard.locator(`[data-child-payment-plan][value="${sibling.paymentPlanCode}"]`).check();
  }

  await publicPage.locator("#registration-form button[type=submit]").click();
  await publicPage.locator("#guardian-rules-dialog").waitFor({ state: "visible" });
  await publicPage.locator("#acknowledge-guardian").click();
  await publicPage.locator("#student-rules-dialog").waitFor({ state: "visible" });
  await publicPage.locator("#acknowledge-student").click();
  await publicPage.locator("#review-panel").waitFor({ state: "visible" });
  await publicPage.getByText("Бүртгэл хараахан илгээгдээгүй байна.").waitFor({ state: "visible" });
  await publicPage.locator("#registration-turnstile").waitFor({ state: "visible" });

  const submitted = publicPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/registration/submit"
    && response.request().method() === "POST");
  await publicPage.locator("#submit-registration").click();
  const response = await submitted;
  if (!response.ok()) throw new Error(`public registration failed: ${await response.text()}`);
  const submissionResult = await response.json();
  assert.equal(submissionResult.emailSent, false,
    "the isolated local Worker has no provider credential and does not attempt external delivery");
  await publicPage.locator("#registration-result").waitFor({ state: "visible" });
  await assert.doesNotMatch(await publicPage.locator("#registration-result").textContent() || "", /дахин бүртгүүлэх|дахин оролдоно уу/i,
    "a committed public registration shows the result, never a resubmission prompt");

  const rows = await dbJson(`SELECT registration_draft_child.id AS childId,
      registration_draft_child.given_name AS givenName,
      registration_draft.id AS registrationDraftId,
      registration_capacity_hold.status AS holdStatus,
      payment_request.id AS paymentRequestId,
      registration_draft_child.initial_payment_amount_mnt AS paymentAmount
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      AND registration_capacity_hold.status = 'active'
    LEFT JOIN payment_request ON payment_request.registration_draft_id = registration_draft_child.registration_draft_id
    WHERE registration_draft.normalized_email = ${sql(email)} ORDER BY registration_draft_child.position`);
  assert.equal(rows.length, 1 + siblings.length, "the rendered public flow creates every requested registration child");
  assert.ok(rows.every((row) => row.holdStatus === "active"), "public registration creates one active capacity hold per child");
  assert.equal(Number(rows.find((row) => row.childId)?.paymentAmount), expectedInitialAmount,
    "public plan selection uses the authoritative initial installment rather than a browser price");
  const receipts = await dbJson(`SELECT COUNT(*) AS count FROM outbound_email
    WHERE registration_draft_id = ${sql(rows[0].registrationDraftId)}
      AND template_key = 'registration_receipt_v1'`);
  assert.equal(Number(receipts[0].count), 0,
    "without a configured local provider, public submission does not fabricate an Outbox receipt");
  await publicContext.close();
  publicContext = undefined;
  if (!siblings.length) return rows[0].childId;
  return [childName, ...siblings.map((sibling) => sibling.childName)].map((name) => {
    const row = rows.find((entry) => entry.givenName === name);
    assert.ok(row?.childId, `the rendered public flow returns the durable child identity for ${name}`);
    return row.childId;
  });
}

async function openCredit(page, childId) {
  const row = page.locator(`[data-registration-child="${childId}"]`);
  const creditOpen = row.locator('[data-credit-open]').last();
  if (!await creditOpen.isVisible()) {
    const detail = row.locator('button[data-payment-detail]').first();
    await detail.waitFor({ state: "visible" });
    if (await detail.getAttribute("aria-expanded") !== "true") await detail.click();
    await creditOpen.waitFor({ state: "visible" });
  }
  await creditOpen.waitFor({ state: "visible" });
  await row.locator('[data-credit-open]').last().click();
  const add = row.locator('[data-credit-subpanel-name="add"]');
  if (await add.getAttribute("aria-expanded") !== "true") await add.click();
  return row;
}

async function addCredit(page, childId, amount) {
  const row = await openCredit(page, childId);
  const form = row.locator('[data-child-credit-form="manual-add"]');
  await form.locator('input[name="amountMnt"]').fill(String(amount));
  await form.locator('textarea[name="reason"]').fill("Browser credit fixture adjustment");
  page.once("dialog", (dialog) => dialog.accept());
  await form.locator('button[type="submit"]').click();
  await page.getByText("Кредит нэмэгдлээ.").waitFor({ state: "visible" });
}

async function applyCredit(page, childId, amount) {
  const row = page.locator(`[data-registration-child="${childId}"]`);
  const creditOpen = row.locator('[data-credit-open]').last();
  if (!await creditOpen.isVisible()) {
    const detail = row.locator('button[data-payment-detail]').first();
    if (await detail.getAttribute("aria-expanded") !== "true") await detail.click();
    await creditOpen.waitFor({ state: "visible" });
  }
  if (await row.locator('[data-child-credit-form="apply"]:visible').count() === 0) await creditOpen.click();
  if (await row.locator('[data-child-credit-form="apply"]:visible').count() === 0) {
    await row.locator('[data-credit-subpanel-name="apply"]').click();
    assert.equal(await row.locator('[data-child-credit-form="manual-add"]:visible, [data-child-credit-form="correct"]:visible').count(), 0,
      "opening credit application closes the adjustment subpanel");
  }
  const form = row.locator('[data-child-credit-form="apply"]');
  await form.locator('input[name="amountMnt"]').fill(String(amount));
  await form.locator('textarea[name="reason"]').fill("Browser initial installment application");
  page.once("dialog", (dialog) => dialog.accept());
  const request = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments") && response.request().method() === "POST");
  await form.locator('button[type="submit"]').click();
  const response = await request;
  if (!response.ok()) throw new Error(`credit application failed: ${await response.text()}`);
}

async function correctCredit(page, childId, adjustmentMnt) {
  const row = page.locator(`[data-registration-child="${childId}"]`);
  const creditOpen = row.locator('[data-credit-open]').last();
  if (!await creditOpen.isVisible()) {
    const detail = row.locator('button[data-payment-detail]').first();
    if (await detail.getAttribute("aria-expanded") !== "true") await detail.click();
    await creditOpen.waitFor({ state: "visible" });
  }
  if (await row.locator('[data-credit-subpanel-name="correct"]:visible').count() === 0) await creditOpen.click();
  const correct = row.locator('[data-credit-subpanel-name="correct"]');
  if (await correct.getAttribute("aria-expanded") !== "true") await correct.click();
  assert.equal(await row.locator('[data-child-credit-form="manual-add"]:visible, [data-child-credit-form="apply"]:visible').count(), 0,
    "direct correction closes every other credit subpanel");
  const form = row.locator('[data-child-credit-form="correct"]');
  await form.locator('input[name="adjustmentMnt"]').fill(String(adjustmentMnt));
  await form.locator('textarea[name="reason"]').fill("Browser signed credit correction");
  await form.getByText("Үлдэх боломжтой кредит: 150 ₮").waitFor({ state: "visible" });
  page.once("dialog", (dialog) => dialog.accept());
  await form.locator('button[type="submit"]').click();
  await page.getByText("Кредитийн засвар хадгалагдлаа.").waitFor({ state: "visible" });
}

async function recordPartialCashPayment(page, childId) {
  const row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
  const form = row.locator("[data-payment-form]");
  await form.waitFor({ state: "visible" });
  await form.locator('input[name="amount"]').fill("250");
  await form.locator('select[name="source"]').selectOption("staff_manual_cash");
  const request = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await form.locator('button[type="submit"]').click();
  const response = await request;
  if (!response.ok()) throw new Error(`partial cash payment failed: ${await response.text()}`);
  await row.getByText("Төлбөр бүртгэгдлээ").waitFor({ state: "visible" });
}

async function recordCashPayment(page, childId, amount, { expectedAmount = amount } = {}) {
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  const row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
  const form = row.locator("[data-payment-form]");
  await form.waitFor({ state: "visible" });
  assert.equal(Number(await form.locator('input[name="amount"]').inputValue()), expectedAmount,
    "the rendered staff payment form requests the authoritative effective amount");
  await form.locator('input[name="amount"]').fill(String(amount));
  await form.locator('select[name="source"]').selectOption("staff_manual_cash");
  const request = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await form.locator('button[type="submit"]').click();
  const response = await request;
  const submitted = JSON.parse(response.request().postData() ?? "{}");
  if (!response.ok()) {
    const diagnostic = await dbJson(`SELECT payment_installment.amount_mnt AS rawAmountMnt,
        (SELECT COALESCE(SUM(payment_allocation.allocated_amount_mnt), 0) FROM payment_allocation
          WHERE payment_allocation.payment_installment_id = payment_installment.id) AS allocatedMnt,
        conditional_family_discount_quote.state AS quoteState,
        conditional_family_discount_quote.contingent_credit_amount_mnt AS contingentCreditMnt
      FROM payment_installment
      LEFT JOIN conditional_family_discount_quote
        ON conditional_family_discount_quote.registration_draft_child_id = payment_installment.registration_draft_child_id
      WHERE payment_installment.registration_draft_child_id = ${sql(childId)} AND payment_installment.installment_kind = 'initial'`);
    throw new Error(`cash payment failed: ${await response.text()}\n${JSON.stringify(diagnostic)}`);
  }
  await row.getByText("Төлбөр бүртгэгдлээ").waitFor({ state: "visible" });
  return submitted;
}

async function recordApprovedPartialCashPayment(page, childId, amount) {
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  const row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
  const form = row.locator("[data-payment-form]");
  await form.waitFor({ state: "visible" });
  const seat = form.locator('[data-seat-approval] input');
  await form.locator('input[name="amount"]').fill(String(amount));
  assert.equal(await seat.isDisabled(), false, "an ordinary reduced amount restores the explicit partial-seat approval control");
  await seat.check();
  await form.locator('input[name="remainingDueAt"]').fill("2027-01-01T10:00");
  const request = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await form.locator('button[type="submit"]').click();
  const response = await request;
  const submitted = JSON.parse(response.request().postData() ?? "{}");
  assert.equal(submitted.approveSeatConfirmation, true,
    "an explicitly checked reduced amount submits the ordinary partial-seat approval request");
  if (!response.ok()) throw new Error(`ordinary partial cash payment failed: ${await response.text()}`);
  await row.getByText("Төлбөр бүртгэгдлээ").waitFor({ state: "visible" });
}

async function approveConditionalSeat(page, childId, reason) {
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  const row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
  const form = row.locator("[data-conditional-seat-form]");
  await form.waitFor({ state: "visible" });
  await form.locator('[name="conditionalReason"]').fill(reason);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST" && response.request().postData()?.includes("payment.confirm-seat"));
  await form.locator('button[type="submit"]').click();
  const response = await responsePromise;
  const submittedQuoteId = JSON.parse(response.request().postData() ?? "{}").conditionalQuote?.quoteId;
  const submittedQuote = await dbJson(`SELECT registration_draft_child_id AS childId
    FROM conditional_family_discount_quote WHERE id = ${sql(submittedQuoteId ?? "")}`);
  assert.equal(submittedQuote[0]?.childId, childId,
    "a conditional-seat form binds its exact child quote even when siblings share a payment request");
  if (!response.ok()) {
    const diagnostic = await dbJson(`SELECT conditional_family_discount_quote.id AS quoteId,
        conditional_family_discount_quote.state AS quoteState,
        conditional_family_discount_quote.revision AS quoteRevision,
        payment_installment.amount_mnt AS rawAmountMnt,
        (SELECT COALESCE(SUM(payment_allocation.allocated_amount_mnt), 0) FROM payment_allocation
          WHERE payment_allocation.payment_installment_id = payment_installment.id) AS allocatedMnt,
        (SELECT GROUP_CONCAT(payment_confirmation.id || ':' || payment_confirmation.status || ':' || payment_confirmation.seat_confirmation_approved)
          FROM payment_confirmation INNER JOIN payment_allocation
            ON payment_allocation.received_payment_id = payment_confirmation.received_payment_id
          WHERE payment_confirmation.payment_request_id = payment_installment.payment_request_id
            AND payment_allocation.payment_installment_id = payment_installment.id) AS confirmations
      FROM conditional_family_discount_quote
      INNER JOIN payment_installment ON payment_installment.registration_draft_child_id = conditional_family_discount_quote.registration_draft_child_id
        AND payment_installment.installment_kind = 'initial'
      WHERE conditional_family_discount_quote.registration_draft_child_id = ${sql(childId)}
      ORDER BY conditional_family_discount_quote.id`);
    throw new Error(`conditional seat approval failed: ${await response.text()}\nrequest=${response.request().postData() ?? ""}\n${JSON.stringify(diagnostic)}`);
  }
  await row.getByText("Суудал баталгаажлаа").waitFor({ state: "visible" });
}

async function openContingentCreditAuthorization(page, childId) {
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  const row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
  const form = row.locator("[data-conditional-contingent-credit]");
  await form.waitFor({ state: "visible" });
  return { row, form };
}

async function authorizeContingentCredit(page, childId, reason) {
  const { row, form } = await openContingentCreditAuthorization(page, childId);
  assert.equal(Number(await form.locator('[name="amountMnt"]').inputValue()), 120,
    "the rendered contingent authorization proposes the exact donor residual, not a fabricated cash reduction");
  await form.locator('[name="reason"]').fill(reason);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST" && response.request().postData()?.includes("conditional-family.authorize-contingent-credit"));
  await form.locator('button[type="submit"]').click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`conditional contingent authorization failed: ${await response.text()}`);
  await row.getByText("Нөхцөлт кредитийг хамгаалж зөвшөөрлөө.").waitFor({ state: "visible" });
}

async function prepareConditionalSequentialPair(browser, page, marker) {
  const pair = await submitPublicRegistration(browser, {
    childName: `${marker}Donor`, email: `${marker.toLowerCase()}@example.test`, paymentPlanCode: "single", expectedInitialAmount: 1200,
    siblings: [{ childName: `${marker}Recipient`, classSessionId: "browser-class-target", paymentPlanCode: "single" }],
  });
  const [donor, recipient] = pair;
  await recordCashPayment(page, donor, 1200, { expectedAmount: 1080 });
  execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
    WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
      SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(donor)}));`);
  assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, `${marker} donor reaches conditional-seat review through the normal scheduler`);
  await approveConditionalSeat(page, donor, `${marker} conditional donor seat`);
  await recordCashPayment(page, recipient, 960, { expectedAmount: 1080 });
  await authorizeContingentCredit(page, recipient, `${marker} contingent settlement`);
  execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
    WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
      SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(recipient)}));`);
  return { donor, recipient };
}

async function confirmFamilyMembership(page, sourceChildId, relatedChildId, query, reason) {
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(sourceChildId)}`);
  const row = page.locator(`[data-registration-child="${sourceChildId}"]`);
  await row.locator("[data-family-discount-open]").click();
  const picker = row.locator("[data-family-discount-select]");
  await picker.waitFor({ state: "visible" });
  const filter = row.locator("[data-family-discount-filter]");
  await filter.fill(query);
  await filter.press("Tab");
  assert.equal(await picker.locator(`option[value="${relatedChildId}"]`).count(), 1,
    "the immediate family picker contains one unambiguous eligible child option");
  await picker.selectOption(relatedChildId);
  const confirmation = row.locator("[data-family-discount-confirm]");
  await confirmation.waitFor({ state: "visible" });
  const financialPreview = confirmation.locator("ul");
  await financialPreview.waitFor({ state: "visible" });
  assert.match(await financialPreview.innerText(), /100 ₮/, "the compact rendered preview shows the proposed agreement discount before confirmation");
  await confirmation.locator('textarea[name="reason"]').fill(reason);
  const request = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST" && response.request().postData()?.includes("family-discount.confirm"));
  await confirmation.locator('button[type="submit"]').click();
  const response = await request;
  if (!response.ok()) throw new Error(`family membership confirmation failed: ${await response.text()}`);
  await page.getByText("Гэр бүлийн гишүүнчлэл болон тохирох хөнгөлөлтийг баталгаажууллаа.").waitFor({ state: "visible" });
}

async function useFamilySuggestionFromRecipient(page, recipientChildId, donorChildId, amount) {
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(recipientChildId)}`);
  const recipient = page.locator(`[data-registration-child="${recipientChildId}"]`);
  await recipient.waitFor({ state: "visible" });
  const notice = recipient.locator("[data-family-credit-notice]");
  await notice.waitFor({ state: "visible" });
  assert.match(await notice.innerText(), /Энэ төлбөрт кредит хэрэглэх/, "recipient sees family credit guidance without opening the donor record");
  await recipient.locator("[data-payment-open]").click();
  const paymentForm = recipient.locator('[data-payment-form]');
  await paymentForm.waitFor({ state: "visible" });
  assert.equal(await paymentForm.locator('input[name="proceedWithoutFamilyCredit"]').count(), 1,
    "cash collection requires an explicit family-credit decision before submission");
  await paymentForm.locator("[data-payment-close]").click();
  await notice.locator("[data-family-credit-suggestion]").click();
  const confirmation = recipient.locator('[data-family-credit-apply]');
  await confirmation.waitFor({ state: "visible" });
  assert.equal(await page.locator(`[data-registration-child="${donorChildId}"] [data-child-credit-form="transfer"]:visible`).count(), 0,
    "the receiver-scoped suggestion never opens the donor's general transfer panel");
  assert.match(await confirmation.innerText(), new RegExp(`${amount} ₮`), "the fixed confirmation shows the capped transfer and resulting balances");
  await confirmation.locator('[data-family-credit-apply-cancel]').click();
  assert.equal(await recipient.locator('[data-family-credit-apply]').count(), 0,
    "dismissing the confirmation performs no transfer or application");
  const beforeFailure = await dbJson(`SELECT COUNT(*) AS value FROM child_credit_operation
    WHERE source_registration_draft_child_id = ${sql(donorChildId)} AND target_registration_draft_child_id = ${sql(recipientChildId)}`);
  execute(`CREATE TRIGGER browser_family_credit_application_failure BEFORE INSERT ON child_credit_entry
    WHEN NEW.entry_kind = 'credit_application' AND NEW.reason = 'Browser forced family application failure'
    BEGIN SELECT RAISE(ABORT, 'forced family application failure'); END;`);
  await notice.locator("[data-family-credit-suggestion]").click();
  const failedConfirmation = recipient.locator('[data-family-credit-apply]');
  await failedConfirmation.waitFor({ state: "visible" });
  await failedConfirmation.locator('textarea[name="reason"]').fill("Browser forced family application failure");
  const failedRequest = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments") && response.request().method() === "POST");
  await failedConfirmation.locator('button[type="submit"]').click();
  assert.equal((await failedRequest).ok(), false, "an application failure is surfaced without a successful settlement response");
  const afterFailure = await dbJson(`SELECT COUNT(*) AS value FROM child_credit_operation
    WHERE source_registration_draft_child_id = ${sql(donorChildId)} AND target_registration_draft_child_id = ${sql(recipientChildId)}`);
  assert.equal(Number(afterFailure[0]?.value), Number(beforeFailure[0]?.value),
    "a failed application rolls back the donor debit and intermediate transfer root");
  execute("DROP TRIGGER browser_family_credit_application_failure;");
  const retryConfirmation = recipient.locator('[data-family-credit-apply]');
  await retryConfirmation.waitFor({ state: "visible" });
  await retryConfirmation.locator('textarea[name="reason"]').fill("Browser family credit settlement");
  const request = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments") && response.request().method() === "POST");
  await retryConfirmation.locator('button[type="submit"]').click();
  const response = await request;
  if (!response.ok()) throw new Error(`suggested family credit settlement failed: ${await response.text()}`);
  await recipient.getByText("кредитийг энэ төлбөрт тооцлоо.").waitFor({ state: "visible" });
  const afterSuccess = await dbJson(`SELECT COUNT(*) AS value FROM child_credit_operation
    WHERE source_registration_draft_child_id = ${sql(donorChildId)} AND target_registration_draft_child_id = ${sql(recipientChildId)}`);
  assert.equal(Number(afterSuccess[0]?.value), Number(beforeFailure[0]?.value) + 1,
    "the retry commits one durable combined transfer/application operation");
}

async function staffPaymentProjection(page, childId) {
  return page.evaluate(async (targetChildId) => {
    const response = await fetch("/api/staff/payments", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("staff payment projection failed");
    const body = await response.json();
    return body.items.find((item) => item.registrationDraftChildId === targetChildId) ?? null;
  }, childId);
}

async function recordPaymentSearchNote(page, childId) {
  const row = page.locator(`[data-registration-child="${childId}"]`);
  const action = row.locator("[data-payment-checked]");
  await action.waitFor({ state: "visible" });
  const request = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await action.click();
  const response = await request;
  if (!response.ok()) throw new Error(`payment search note failed: ${await response.text()}`);
  await row.getByText("Төлбөр олдоогүйг тэмдэглэлээ.").waitFor({ state: "visible" });
  await row.locator('button[data-payment-detail][aria-expanded="false"]').waitFor({ state: "visible" });
}

async function verifyRegistrationExport(page, staffContext, childName) {
  await staffContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  await page.goto(`${baseUrl}/staff/payments/`);
  const copy = page.locator("#payment-copy");
  await copy.waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#payment-copy")?.disabled);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#payment-export").click(),
  ]);
  const downloadPath = await download.path();
  assert.ok(downloadPath, "authorized TSV export produces a browser download");
  const downloaded = readFileSync(downloadPath, "utf8");
  await copy.click();
  await page.getByText("Хуулагдлаа.").waitFor({ state: "visible" });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const tableRows = (value) => value.replace(/^\uFEFF/, "").split("\n").slice(3).join("\n");
  assert.equal(tableRows(copied), tableRows(downloaded),
    "clipboard and downloaded TSV share the same authorized header and row projection; only download BOM and generated-at metadata differ");
  assert.match(downloaded, /Нэмэлт утас/, "export includes the secondary-phone column");
  assert.match(downloaded, /00112233/, "export preserves a distinct secondary phone with leading zeros");
  assert.match(downloaded, new RegExp(childName), "export includes the staff-created registration row");
}

async function openAndAbandonTransfer(page, childId) {
  const row = page.locator(`[data-registration-child="${childId}"]`);
  if (await row.locator("[data-transfer-open]").count() === 0) await row.locator("button[data-payment-detail]").click();
  await row.locator("[data-transfer-open]").click();
  const form = row.locator("[data-transfer-initiate]");
  await form.waitFor({ state: "visible" });
  await form.locator('select[name="targetClassSessionId"]').selectOption("browser-class-target");
  await form.locator('textarea[name="reason"]').fill("Browser transfer preview and abandonment");
  const initiate = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await form.locator('button[type="submit"]').click();
  const initiated = await initiate;
  if (!initiated.ok()) throw new Error(`transfer initiation failed: ${await initiated.text()}`);
  const closeReason = row.locator("[data-transfer-close-reason]");
  await closeReason.waitFor({ state: "visible" });
  await closeReason.fill("Browser test keeps the source class");
  const closing = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await row.locator("[data-transfer-close]").click();
  const closed = await closing;
  if (!closed.ok()) throw new Error(`transfer abandonment failed: ${await closed.text()}`);
  await row.getByText("Шилжүүлгийг болилоо. Одоогийн анги хэвээр үлдлээ.").waitFor({ state: "visible" });
}

async function completeTransfer(page, childId, targetClassId, expectedDifferenceMnt) {
  const row = page.locator(`[data-registration-child="${childId}"]`);
  if (await row.locator("[data-transfer-open]").count() === 0) await row.locator("button[data-payment-detail]").click();
  await row.locator("[data-transfer-open]").click();
  const form = row.locator("[data-transfer-initiate]");
  await form.waitFor({ state: "visible" });
  await form.locator('select[name="targetClassSessionId"]').selectOption(targetClassId);
  await form.locator('textarea[name="reason"]').fill("Browser transfer completion");
  await form.locator('button[type="submit"]').click();
  if (expectedDifferenceMnt > 0) {
    const amount = row.locator("[data-transfer-amount]");
    await amount.waitFor({ state: "visible" });
    assert.equal(Number(await amount.inputValue()), expectedDifferenceMnt, "the rendered transfer difference uses authoritative pricing");
    await amount.fill(String(expectedDifferenceMnt));
    await row.locator("[data-transfer-pay]").click();
  }
  const complete = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await row.locator("[data-transfer-complete]").click();
  const completed = await complete;
  if (!completed.ok()) throw new Error(`transfer completion failed: ${await completed.text()}`);
  await row.getByText("Анги шилжүүлэг дууслаа.").waitFor({ state: "visible" });
}

function waitlistFixtureSql(prefix, token) {
  const now = new Date().toISOString();
  const draftId = `${prefix}-draft`; const childId = `${prefix}-child`; const entryId = `${prefix}-entry`; const offerId = `${prefix}-offer`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { draftId, childId, entryId, offerId, sql: `
    INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship,
      primary_phone, email, normalized_email, facebook_name, home_address, payment_plan_code, parent_rules_version,
      student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at)
    VALUES (${sql(draftId)}, ${sql(createHash("sha256").update(`${prefix}-access`).digest("hex"))}, 'browser-year',
      ${sql(`Browser ${prefix} guardian`)}, 'Ээж', '99112235', ${sql(`${prefix}@example.test`)}, ${sql(`${prefix}@example.test`)},
      'Browser FB', 'Browser waitlist address', 'per_child', 'parent-v1', 'student-v1', 'waitlisted',
      '2027-12-31T00:00:00.000Z', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth,
      current_grade, returning_status, selected_stage_code, preferred_waitlist_class_session_id, payment_plan_code, status,
      is_test, test_run_id, created_at, updated_at)
    VALUES (${sql(childId)}, ${sql(draftId)}, 0, 'Browser', ${sql(prefix)}, 'not_specified', '2015-05-10', '5', 'new',
      'stage_1', 'browser-class-waitlist', 'two_installment', 'waitlisted', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft_waitlist_entry (id, registration_draft_child_id, class_session_id, status, offered_at,
      offer_expires_at, is_test, test_run_id, created_at, updated_at)
    VALUES (${sql(entryId)}, ${sql(childId)}, 'browser-class-waitlist', 'offered', ${sql(now)}, '2027-01-01T00:00:00.000Z',
      1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO waitlist_seat_offer (id, waitlist_entry_id, registration_draft_child_id, class_session_id, status,
      response_token_hash, offered_at, respond_by_at, is_test, test_run_id, created_at, updated_at)
    VALUES (${sql(offerId)}, ${sql(entryId)}, ${sql(childId)}, 'browser-class-waitlist', 'active', ${sql(tokenHash)},
      ${sql(now)}, '2027-01-01T00:00:00.000Z', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});` };
}

async function exerciseWaitlistResponse(browser, prefix, decision) {
  const token = randomUUID();
  const fixture = waitlistFixtureSql(prefix, token);
  execute(fixture.sql);
  const responseContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const responsePage = await responseContext.newPage();
  await responsePage.goto(`${baseUrl}/waitlist-offer/#token=${token}`);
  await responsePage.getByText("Танд суудал гарлаа").waitFor({ state: "visible" });
  if (decision === "accept") {
    await responsePage.selectOption("#plan", "two_installment");
    await responsePage.locator("#accept").click();
    await responsePage.getByText("Төлбөрийн мэдээлэл").waitFor({ state: "visible" });
  } else {
    responsePage.once("dialog", (dialog) => dialog.accept());
    await responsePage.locator("#decline").click();
    await responsePage.getByText("Татгалзсаныг тэмдэглэлээ.").waitFor({ state: "visible" });
  }
  await responseContext.close();
  return fixture;
}

async function finalizeCreditOnlyRegistration(page, childId) {
  execute(`UPDATE credit_application_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
    WHERE registration_draft_child_id = ${sql(childId)};`);
  const scheduled = await fetch(`${baseUrl}/__scheduled`);
  assert.ok(scheduled.ok, "the local scheduled Worker accepts a deterministic credit-finalization trigger");
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  let row = page.locator(`[data-registration-child="${childId}"]`);
  const identity = row.locator(`[data-promotion-new="${childId}"]`);
  if (await identity.count()) {
    page.once("dialog", (dialog) => dialog.accept());
    await identity.click();
  }
  const confirmed = await dbJson(`SELECT canonical_enrollment_id AS enrollmentId FROM registration_draft_child
    WHERE id = ${sql(childId)}`);
  assert.ok(confirmed[0]?.enrollmentId, "credit-only settlement reaches the normal canonical enrollment path");
  return row;
}

async function finalizeCashRegistration(page, childId) {
  execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
    WHERE received_payment_id IN (
      SELECT received_payment.id FROM received_payment
      INNER JOIN payment_request ON payment_request.id = received_payment.payment_request_id
      WHERE payment_request.registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(childId)}
      )
    );`);
  const scheduled = await fetch(`${baseUrl}/__scheduled`);
  assert.ok(scheduled.ok, "the local scheduled Worker accepts the deterministic cash-finalization trigger");
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  const row = page.locator(`[data-registration-child="${childId}"]`);
  const identity = row.locator(`[data-promotion-new="${childId}"]`);
  if (await identity.count()) {
    page.once("dialog", (dialog) => dialog.accept());
    await identity.click();
  }
  const confirmed = await dbJson(`SELECT canonical_enrollment_id AS enrollmentId FROM registration_draft_child
    WHERE id = ${sql(childId)}`);
  assert.ok(confirmed[0]?.enrollmentId, "cash settlement reaches the normal canonical enrollment path");
  return row;
}

async function cancelAndRestoreRegistration(page, childId, { restore: shouldRestore = true } = {}) {
  let row = page.locator(`[data-registration-child="${childId}"]`);
  const group = row.locator('xpath=ancestor::div[starts-with(@id, "group-")][1]');
  if (await group.isHidden()) await group.locator('xpath=preceding-sibling::h2[1]//button[@data-group-toggle]').click();
  await row.waitFor({ state: "visible" });
  const detailToggle = row.locator("button[data-payment-detail]");
  if (await detailToggle.getAttribute("aria-expanded") !== "true") {
    await detailToggle.click();
  }
  const cancellation = row.locator("[data-registration-cancel-form]");
  if (await cancellation.count() !== 1) {
    const permissions = await page.evaluate(async (targetChildId) => {
      const [session, queue] = await Promise.all([
        fetch("/api/staff/session", { credentials: "same-origin" }).then((response) => response.json()),
        fetch("/api/staff/payments", { credentials: "same-origin" }).then((response) => response.json()),
      ]);
      return {
        capabilities: session.capabilities,
        canCancelRegistrations: queue.canCancelRegistrations,
        itemPresent: Boolean(queue.items?.some((item) => item.registrationDraftChildId === targetChildId)),
      };
    }, childId);
    const fragment = await row.evaluate((element) => element.innerHTML.slice(-4_000));
    throw new Error(`rendered cancellation control is unavailable: ${JSON.stringify(permissions)}\n${fragment}`);
  }
  const cancellationDisclosure = cancellation.locator("xpath=ancestor::details[1]");
  if (!(await cancellationDisclosure.evaluate((element) => element.open))) {
    await cancellationDisclosure.locator("summary").click();
  }
  await cancellation.waitFor({ state: "visible" });
  await cancellation.locator('select[name="reason"]').selectOption("guardian_request");
  await cancellation.locator('button[type="submit"]').click();
  const dialog = page.locator("#registration-cancel-dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("[data-registration-cancel-dismiss]").click();
  const afterDismiss = await dbJson(`SELECT status FROM registration_draft_child WHERE id = ${sql(childId)}`);
  assert.notEqual(afterDismiss[0]?.status, "cancelled", "dismissing the dialog sends no cancellation mutation");

  await cancellation.locator('button[type="submit"]').click();
  await dialog.waitFor({ state: "visible" });
  const cancelRequest = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await dialog.locator("[data-registration-cancel-confirm]").click();
  const cancelled = await cancelRequest;
  if (!cancelled.ok()) throw new Error(`registration cancellation failed: ${await cancelled.text()}`);
  const afterCancel = await dbJson(`SELECT status, canonical_enrollment_id AS enrollmentId FROM registration_draft_child
    WHERE id = ${sql(childId)}`);
  assert.equal(afterCancel[0]?.status, "cancelled", "explicit dialog confirmation cancels the exact displayed registration");
  if (!shouldRestore) return afterCancel[0];

  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
  const cancelledToggle = row.locator(`[data-cancelled-detail="${childId}"]`).last();
  await cancelledToggle.click();
  const restore = row.locator("[data-registration-reinstate]");
  await restore.waitFor({ state: "visible" });
  page.once("dialog", (dialog) => dialog.accept());
  const restoreRequest = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await restore.click();
  const restored = await restoreRequest;
  if (!restored.ok()) throw new Error(`registration restore failed: ${await restored.text()}`);
  const afterRestore = await dbJson(`SELECT status, canonical_enrollment_id AS enrollmentId FROM registration_draft_child
    WHERE id = ${sql(childId)}`);
  assert.notEqual(afterRestore[0]?.status, "cancelled", "eligible restoration returns the record to its active lifecycle");
  assert.equal(afterRestore[0]?.enrollmentId, afterCancel[0]?.enrollmentId,
    "restoration preserves the canonical enrollment identity instead of duplicating a seat");
}

try {
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "local migrations");
  execute(fixtureSql());
  worker = spawn(process.execPath, [wranglerCli, "dev", "--env", "staging", "--local", "--persist-to", persistDir,
    "--ip", "127.0.0.1", "--port", String(port), "--test-scheduled", "--var", `APP_ORIGIN:${baseUrl}`], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });
  await waitForWorker();

  browser = await chromium.launch({ headless: true });
  const publicTwoInstallmentChildId = await submitPublicRegistration(browser, {
    childName: "PublicTwoInstallment",
    email: "browser-public-two@example.test",
    paymentPlanCode: "two_installment",
    expectedInitialAmount: 500,
  });
  const publicOnePaymentChildId = await submitPublicRegistration(browser, {
    childName: "PublicOnePayment",
    email: "browser-public-one@example.test",
    paymentPlanCode: "single",
    expectedInitialAmount: 1000,
  });
  assert.ok(publicTwoInstallmentChildId && publicOnePaymentChildId,
    "both public payment-plan journeys return durable registration children");
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.addCookies([{ name: "naran_staff_session", value: rawSessionToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  page = await context.newPage();

  if (process.env.PARENT_REGISTRATION_UX_BROWSER_ONLY === "1") {
    const uxContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const uxPage = await uxContext.newPage();
    await installTurnstileTestWidget(uxPage);
    await uxPage.goto(`${baseUrl}/register/?new=1`);
    await uxPage.locator("#registration-form").waitFor({ state: "visible" });
    assert.equal(await uxPage.locator('[data-child-returning][value="no"]').isChecked(), true,
      "a new child visibly defaults to not having studied at the centre before");
    await uxPage.locator('[data-child-returning][value="yes"]').check();
    await uxPage.locator("[data-child-previous-stage]").selectOption("stage_1");
    await uxPage.reload();
    await uxPage.locator("#restore-registration-draft").click();
    assert.equal(await uxPage.locator('[data-child-returning][value="yes"]').isChecked(), true,
      "an explicitly chosen returning answer survives draft restoration");
    await uxPage.locator('[data-child-returning][value="no"]').check();
    await uxPage.locator("#registration-form button[type=submit]").click();
    await uxPage.getByText("* тэмдэгтэй заавал бөглөх талбаруудыг зөв, бүрэн бөглөнө үү.").waitFor({ state: "visible" });
    assert.equal(await uxPage.locator("#information-error .required-marker").count(), 1,
      "the required-field summary uses the same styled marker as form captions");
    assert.equal(await uxPage.evaluate(() => document.activeElement?.id), "guardian-name",
      "invalid continuation focuses the first actionable field");
    assert.equal(await uxPage.locator("#guardian-name").getAttribute("aria-invalid"), "true",
      "the focused required field retains accessible invalid state");
    assert.match(await uxPage.locator("#guardian-name").locator("xpath=..").textContent() || "", /\*\s+\(Энэ талбарыг бөглөнө үү\)/,
      "the focused field keeps its specific visible explanation inline with the required marker");
    assert.equal(await uxPage.locator("#guardian-name").locator("xpath=..//small").count(), 0,
      "the input has no duplicate validation message beneath its caption");

    await uxPage.fill("#guardian-name", "UX guardian");
    await uxPage.selectOption("#guardian-relationship", { label: "Ээж" });
    await uxPage.fill("#guardian-email", "ux-parent@example.test");
    await uxPage.fill("#guardian-phone", "99112234");
    await uxPage.fill("#guardian-facebook", "UX guardian");
    await uxPage.fill("#guardian-address", "UX district");
    const uxCard = uxPage.locator("[data-child-card]").first();
    await uxCard.locator("[data-child-surname]").fill("UX");
    await uxCard.locator("[data-child-name]").fill("Child");
    await uxCard.locator("[data-child-grade]").selectOption("5");
    await uxCard.locator("[data-child-gender]").selectOption({ label: "Эмэгтэй" });
    await uxCard.locator("[data-child-dob]").fill("2099-05-10");
    await uxPage.locator("#registration-form button[type=submit]").click();
    await uxPage.getByText("Төрсөн огноо өнөөдрөөс хойш байж болохгүй.").waitFor({ state: "visible" });
    assert.equal(await uxPage.evaluate(() => document.activeElement?.matches("[data-child-dob]") || false), true,
      "a future birth date focuses the child date field with a specific explanation");
    assert.match(await uxCard.locator("[data-child-dob]").locator("xpath=..").textContent() || "", /\*\s+\(Төрсөн огноо өнөөдрөөс хойш байж болохгүй\)/,
      "a long field-specific date error appears beside its caption instead of beneath the control");
    await uxCard.locator("[data-child-dob]").fill("2015-05-10");
    assert.equal(await uxCard.locator("[data-child-dob]").locator("xpath=..").locator(".caption-validation-error").count(), 0,
      "correcting a field removes only its inline error while retaining its required marker");
    await uxCard.locator("[data-child-stage]").selectOption("stage_1");
    await uxPage.locator("#registration-form button[type=submit]").click();
    await uxPage.getByText("Анги, цагаа сонгоно уу.").last().waitFor({ state: "visible" });
    assert.equal(await uxPage.evaluate(() => document.activeElement?.matches("[data-child-class]") || false), true,
      "a missing class choice focuses its actionable radio group");
    await uxCard.locator('[data-child-class][value="browser-class-source"]').check();
    await uxCard.locator('[data-child-payment-plan][value="single"]').check();
    await uxPage.locator("[data-add-child]").click();
    await uxPage.locator("#registration-form button[type=submit]").click();
    const secondCard = uxPage.locator("[data-child-card]").nth(1);
    assert.match(await uxPage.evaluate(() => document.activeElement?.getAttribute("name") || ""), /child-1-name/,
      "a multiple-child form focuses the first invalid control in the second child section");
    await secondCard.locator("[data-child-surname]").fill("UX");
    await secondCard.locator("[data-child-name]").fill("Sibling");
    await secondCard.locator("[data-child-grade]").selectOption("4");
    await secondCard.locator("[data-child-gender]").selectOption({ label: "Эрэгтэй" });
    await secondCard.locator("[data-child-dob]").fill("2016-05-10");
    await secondCard.locator("[data-child-stage]").selectOption("stage_1");
    await secondCard.locator('[data-child-class][value="browser-class-target"]').check();
    await secondCard.locator('[data-child-payment-plan][value="single"]').check();
    await uxPage.locator("#registration-form button[type=submit]").click();
    await uxPage.locator("#guardian-rules-dialog").waitFor({ state: "visible" });
    assert.equal(await uxPage.locator('#guardian-rules-dialog [data-close-dialog]').count(), 1,
      "the rules dialog keeps only its bottom return action");
    await uxPage.keyboard.press("Escape");
    assert.equal(await uxPage.locator("#review-panel").isHidden(), true,
      "escaping a rules dialog never records acceptance");
    await uxPage.locator("#registration-form button[type=submit]").click();
    await uxPage.locator("#acknowledge-guardian").click();
    await uxPage.locator("#student-rules-dialog").waitFor({ state: "visible" });
    await uxPage.setViewportSize({ width: 390, height: 844 });
    const studentActions = uxPage.locator("#student-rules-dialog .dialog-actions");
    assert.ok((await studentActions.boundingBox())?.y < 844, "mobile rules actions remain reachable in the viewport");
    await uxPage.getByRole("button", { name: "Буцах" }).click();
    assert.equal(await uxPage.locator("#review-panel").isHidden(), true,
      "returning from student rules never records acceptance");
    await uxPage.locator("#registration-form button[type=submit]").click();
    await uxPage.locator("#acknowledge-guardian").click();
    await uxPage.locator("#acknowledge-student").click();
    await uxPage.locator("#review-panel").waitFor({ state: "visible" });
    await uxContext.close();
  } else if (process.env.SEAT_COUNT_THRESHOLD_BROWSER_ONLY === "1") {
    const saveThreshold = async (value) => {
      await page.goto(`${baseUrl}/staff/settings/`);
      await page.locator("#tool-app").waitFor({ state: "visible" });
      const details = page.locator("#public-seat-count-threshold-setting details");
      if (!await details.evaluate((node) => node.open)) await details.locator("summary").click();
      const form = page.locator("#public-seat-count-threshold-form");
      await form.locator("#public-seat-count-threshold").fill(value);
      const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/staff/program-calendar")
        && candidate.request().method() === "POST");
      await form.getByRole("button", { name: "Хадгалах" }).click();
      assert.equal((await response).status(), 200, `threshold ${value || "NULL"} saves through the authorized settings form`);
    };
    const publicClassText = async () => {
      const publicPage = await browser.newPage();
      await publicPage.goto(`${baseUrl}/register/?new=1`);
      await publicPage.locator("#registration-form").waitFor({ state: "visible" });
      await publicPage.locator("[data-child-stage]").selectOption("stage_1");
      await publicPage.locator("[data-child-class]").first().waitFor({ state: "visible" });
      const text = await publicPage.locator("[data-child-card]").first().textContent();
      await publicPage.close();
      return text || "";
    };
    await saveThreshold("0");
    assert.doesNotMatch(await publicClassText(), /Сул суудал:\s*\d+/, "threshold zero hides numeric seats in the rendered public registration choices");
    await saveThreshold("2");
    assert.doesNotMatch(await publicClassText(), /Сул суудал:\s*\d+/, "a count above the threshold remains absent from public text");
    await saveThreshold("1000");
    assert.match(await publicClassText(), /Сул суудал:\s*\d+/, "a threshold above capacity restores the public numeric count");
    await page.goto(`${baseUrl}/staff/settings/`);
    await page.locator("#tool-app").waitFor({ state: "visible" });
    const invalidDetails = page.locator("#public-seat-count-threshold-setting details");
    if (!await invalidDetails.evaluate((node) => node.open)) await invalidDetails.locator("summary").click();
    const invalidForm = page.locator("#public-seat-count-threshold-form");
    await invalidForm.locator("#public-seat-count-threshold").fill("-1");
    const invalidResponse = page.waitForResponse((candidate) => candidate.url().endsWith("/api/staff/program-calendar")
      && candidate.request().method() === "POST");
    await invalidForm.getByRole("button", { name: "Хадгалах" }).click();
    assert.equal((await invalidResponse).status(), 400, "invalid threshold values are rejected by the authorized server route");
    assert.equal(await invalidForm.locator("#public-seat-count-threshold").inputValue(), "-1", "a rejected save preserves the entered value for correction");
    await saveThreshold("");
    assert.match(await publicClassText(), /Сул суудал:\s*\d+/, "the blank compatibility setting preserves the legacy public count display");
  } else if (process.env.CLASS_PUBLIC_VISIBILITY_BROWSER_ONLY === "1") {
    await page.goto(`${baseUrl}/staff/offerings/`);
    await page.locator("#tool-app").waitFor({ state: "visible" });
    await page.locator('[data-edit-offering="browser-offering"]').click();
    await page.locator("[data-add-class]").click();
    await page.locator("#class-form").getByRole("button", { name: "Хадгалах" }).click();
    await page.locator("#class-form .form-error").getByText("Энэ сургалтад баталгаатай хөтөлбөр холбогдоогүй тул шинэ анги нэмж болохгүй.").waitFor({ state: "visible" });
    assert.equal(await page.locator("#class-form").count(), 1,
      "an unsupported new class keeps its form open beside the actionable program-context explanation");
    await page.locator("[data-class-cancel]").click();
    const publicCatalog = async () => page.evaluate(async () => (await fetch("/api/registration/catalog")).json());
    const catalogClassIds = async () => (await publicCatalog()).academicYears.flatMap((year) => year.classSessions).map((entry) => entry.id);
    assert.deepEqual((await catalogClassIds()).filter((id) => id === "browser-class-source" || id === "browser-class-target").sort(),
      ["browser-class-source", "browser-class-target"], "both sibling classes begin in the public catalog");
    const hide = page.locator('[data-class-public-visibility="browser-class-source"]');
    await hide.waitFor({ state: "visible" });
    assert.equal(await hide.textContent(), "Нийтээс нуух", "the rendered staff control starts in the visible state");
    await hide.click();
    await page.getByText("Ангийг нийтээс нуусан.").waitFor({ state: "visible" });
    assert.equal((await catalogClassIds()).includes("browser-class-source"), false,
      "the rendered hide action removes the class from the public catalog");
    assert.equal((await catalogClassIds()).includes("browser-class-target"), true,
      "hiding one class leaves its sibling and Offering available publicly");
    const staffCatalog = await page.evaluate(async () => (await fetch("/api/staff/registration-intake", { credentials: "same-origin" })).json());
    assert.equal(staffCatalog.catalog.academicYears.flatMap((year) => year.classSessions).some((entry) => entry.id === "browser-class-source"), true,
      "staff intake retains the operationally eligible hidden class");
    const show = page.locator('[data-class-public-visibility="browser-class-source"]');
    await show.click();
    await page.getByText("Ангийг нийтэд харууллаа.").waitFor({ state: "visible" });
    assert.equal((await catalogClassIds()).includes("browser-class-source"), true,
      "the rendered show action restores the class without changing its operational state");
    await page.locator('[data-class-edit="browser-class-source"]').click();
    const availabilityForm = page.locator("#class-form");
    await availabilityForm.waitFor({ state: "visible" });
    await availabilityForm.locator("#class-open").uncheck();
    await availabilityForm.getByRole("button", { name: "Хадгалах" }).click();
    await page.getByText("Ангийг хадгаллаа.").waitFor({ state: "visible" });
    const closedCatalog = await publicCatalog();
    const closedSource = closedCatalog.academicYears.flatMap((year) => year.classSessions).find((entry) => entry.id === "browser-class-source");
    const openSibling = closedCatalog.academicYears.flatMap((year) => year.classSessions).find((entry) => entry.id === "browser-class-target");
    assert.equal(closedSource?.availability, "unavailable", "a legacy-dated class can close registration while remaining publicly listed");
    assert.equal(openSibling?.availability, "available", "closing one class does not close its sibling");
    await page.locator('[data-class-edit="browser-class-source"]').click();
    await page.locator("#class-form #class-open").check();
    await page.locator("#class-form").getByRole("button", { name: "Хадгалах" }).click();
    await page.getByText("Ангийг хадгаллаа.").waitFor({ state: "visible" });
    await page.locator('[data-class-public-visibility="browser-class-source"]').click();
    await page.getByText("Ангийг нийтээс нуусан.").waitFor({ state: "visible" });
    await page.locator('[data-class-public-visibility="browser-class-target"]').click();
    await page.getByText("Ангийг нийтээс нуусан.").waitFor({ state: "visible" });
    assert.equal((await catalogClassIds()).includes("browser-class-source"), false, "hiding both siblings removes the empty Offering from public choices");
    assert.equal((await catalogClassIds()).includes("browser-class-target"), false, "the second hidden sibling is also absent publicly");
    await page.locator('[data-class-public-visibility="browser-class-target"]').click();
    await page.getByText("Ангийг нийтэд харууллаа.").waitFor({ state: "visible" });
    assert.equal((await catalogClassIds()).includes("browser-class-target"), true, "showing one sibling restores the Offering's public choice");
    await page.goto(`${baseUrl}/staff/registration-windows/`);
    await page.locator("#tool-app").waitFor({ state: "visible" });
    await page.locator('[data-window-edit="browser-window"]').click();
    const windowForm = page.locator("#window-form");
    await windowForm.locator('input[name="offering"][value="browser-offering"]').uncheck();
    await windowForm.getByRole("button", { name: "Хадгалах" }).click();
    await page.getByText("Бүртгэлийг хадгаллаа.").waitFor({ state: "visible" });
    assert.equal((await catalogClassIds()).includes("browser-class-target"), false,
      "the existing Offering-level window exclusion still hides every class in that Offering");
    await page.locator('[data-window-edit="browser-window"]').click();
    await page.locator('#window-form input[name="offering"][value="browser-offering"]').check();
    await page.locator("#window-form").getByRole("button", { name: "Хадгалах" }).click();
    await page.getByText("Бүртгэлийг хадгаллаа.").waitFor({ state: "visible" });
    assert.equal((await catalogClassIds()).includes("browser-class-target"), true,
      "restoring Offering membership restores its individually visible sibling");
  } else if (process.env.HISTORICAL_SETTLEMENT_BROWSER_ONLY === "1") {
    execute(`UPDATE offering_course_pricing SET one_time_amount_mnt = 1200 WHERE activity_offering_id = 'browser-offering';`);
    const historical = await submitPublicRegistration(browser, {
      childName: "HistoricalSettlementA", email: "historical-settlement@example.test", paymentPlanCode: "single", expectedInitialAmount: 1200,
      siblings: [
        { childName: "HistoricalSettlementB", classSessionId: "browser-class-target", paymentPlanCode: "single" },
        { childName: "HistoricalSettlementC", classSessionId: "browser-class-target", paymentPlanCode: "single" },
      ],
    });
    const [historicalA, historicalB, historicalC] = historical;
    await recordCashPayment(page, historicalA, 1200, { expectedAmount: 1080 });
    await recordCashPayment(page, historicalB, 1080, { expectedAmount: 1080 });
    const legacyRows = await dbJson(`SELECT registration_draft_child.id AS childId, registration_draft_child.registration_draft_id AS draftId
      FROM registration_draft_child WHERE id IN (${sql(historicalA)}, ${sql(historicalB)}, ${sql(historicalC)}) ORDER BY id`);
    const historicalDraftId = legacyRows[0].draftId;
    // Fixture setup models released submission-time awards and receipts that
    // predate 0052's quote/confirmation linkage. The operation under test is
    // the rendered review action, never a canned response.
    execute(`DELETE FROM conditional_family_discount_quote WHERE registration_draft_child_id IN (${sql(historicalA)}, ${sql(historicalB)}, ${sql(historicalC)});
      INSERT INTO discount_award (id, registration_draft_child_id, award_type, basis_points, base_amount_mnt, award_amount_mnt,
        status, qualification_state, reason, awarded_at, is_test, test_run_id, created_at, updated_at)
      SELECT 'browser-history-award-' || id, id, 'family_multi_child', 1000, 1200, 120, 'active', 'earned',
        'same_registration_guardian_multiple_children', datetime('now'), 1, ${sql(testRunId)}, datetime('now'), datetime('now')
      FROM registration_draft_child WHERE id IN (${sql(historicalA)}, ${sql(historicalB)});
      INSERT INTO discount_award (id, registration_draft_child_id, award_type, basis_points, base_amount_mnt, award_amount_mnt,
        status, qualification_state, reason, awarded_at, is_test, test_run_id, created_at, updated_at)
      SELECT 'browser-history-award-' || id, id, 'family_multi_child', 1000, 1200, 120, 'active', 'provisional',
        'same_registration_guardian_multiple_children', datetime('now'), 1, ${sql(testRunId)}, datetime('now'), datetime('now')
      FROM registration_draft_child WHERE id = ${sql(historicalC)};
      INSERT INTO conditional_family_discount_quote (id, registration_draft_child_id, academic_year_id, relationship_basis, relationship_key,
        basis_points, base_amount_mnt, award_amount_mnt, installment_strategy, state, linked_discount_award_id, resolution_reason,
        created_at, updated_at, is_test, test_run_id)
      SELECT 'browser-history-quote-' || id, id, 'browser-year', 'same_submission', ${sql(`historical:${historicalDraftId}:browser-year`)},
        1000, 1200, 120, 'one_payment', CASE WHEN id = ${sql(historicalC)} THEN 'quoted_pending' ELSE 'qualified' END,
        'browser-history-award-' || id, 'historical_adoption', datetime('now'), datetime('now'), 1, ${sql(testRunId)}
      FROM registration_draft_child WHERE id IN (${sql(historicalA)}, ${sql(historicalB)}, ${sql(historicalC)});
      UPDATE discount_award SET conditional_quote_id = 'browser-history-quote-' || registration_draft_child_id
        WHERE registration_draft_child_id IN (${sql(historicalA)}, ${sql(historicalB)}, ${sql(historicalC)});
      DELETE FROM payment_confirmation WHERE received_payment_id IN (
        SELECT payment_allocation.received_payment_id FROM payment_allocation
        INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id IN (${sql(historicalA)}, ${sql(historicalB)})
      );
      UPDATE payment_allocation SET allocated_amount_mnt = 1080
      WHERE payment_installment_id IN (
        SELECT id FROM payment_installment
        WHERE registration_draft_child_id = ${sql(historicalA)} AND installment_kind = 'initial'
      );`);
    await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(historicalA)}`);
    const historicalRow = page.locator(`[data-registration-child="${historicalA}"]`);
    await historicalRow.waitFor({ state: "visible" });
    const historicalForm = historicalRow.locator("[data-historical-settlement-form]");
    await historicalForm.waitFor({ state: "visible" });
    assert.match(await historicalForm.innerText(), /Түүхэн төлбөрийг хянаж баталгаажуулах/,
      "the rendered review form identifies the explicit historical settlement action");
    assert.match(await historicalRow.innerText(), /Төлөх үлдэгдэл: 0 ₮/,
      "the historical review retains the effective zero payable balance without pretending the receipt is still unpaid");
    assert.match(await historicalRow.innerText(), /Илүү төлсөн дүн: 120 ₮[\s\S]*Бүртгэл баталгаажсаны дараа кредитэд тооцогдоно\./,
      "the rendered historical receipt states the excess once, then explains its deferred credit treatment");
    await page.setViewportSize({ width: 1200, height: 900 });
    await capturePaymentPanel(page, "historical-settlement-desktop.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await capturePaymentPanel(page, "historical-settlement-mobile.png");
    await historicalForm.locator('[name="historicalSettlementReason"]').fill("Browser legacy receipt review");
    const reviewResponse = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
      && response.request().method() === "POST" && response.request().postData()?.includes("payment.review-historical-settlement"));
    await historicalForm.getByRole("button", { name: "Төлбөрийг хянаж баталгаажуулах" }).click();
    assert.equal((await reviewResponse).status(), 200, "the rendered historical-review action binds the existing receipt without recording another payment");
    const reviewed = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM payment_confirmation WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = ${sql(historicalDraftId)})) AS confirmations,
      (SELECT COALESCE(SUM(received_amount_mnt), 0) FROM received_payment WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = ${sql(historicalDraftId)})) AS cash,
      (SELECT COALESCE(SUM(payment_allocation.allocated_amount_mnt), 0) FROM payment_allocation
        INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id = ${sql(historicalA)}) AS allocated`,
      (rows) => Number(rows[0]?.confirmations) === 1, "the reviewed historical receipt receives exactly one durable payment confirmation");
    assert.deepEqual({ confirmations: Number(reviewed[0].confirmations), cash: Number(reviewed[0].cash), allocated: Number(reviewed[0].allocated) },
      { confirmations: 1, cash: 2280, allocated: 1080 },
      "reviewing A preserves both actual receipts and A's original effective allocation");
    const reviewScope = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM registration_draft_child WHERE id = ${sql(historicalA)} AND canonical_enrollment_id IS NOT NULL) AS aCanonical,
      (SELECT COUNT(*) FROM registration_draft_child WHERE id = ${sql(historicalB)} AND canonical_enrollment_id IS NOT NULL) AS bCanonical,
      (SELECT COUNT(*) FROM registration_draft_child WHERE id = ${sql(historicalC)} AND canonical_enrollment_id IS NOT NULL) AS cCanonical,
      (SELECT COUNT(*) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(historicalA)}
        AND source_discount_award_id = ${sql(`browser-history-award-${historicalA}`)} AND amount_mnt = 120) AS aRoot,
      (SELECT COUNT(*) FROM payment_confirmation WHERE payment_request_id IN (SELECT id FROM payment_request
        WHERE registration_draft_id = ${sql(historicalDraftId)}) AND conditional_quote_id IS NOT NULL
        AND received_payment_id IN (SELECT payment_allocation.received_payment_id FROM payment_allocation
          INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
          WHERE payment_installment.registration_draft_child_id = ${sql(historicalB)})) AS bConfirmations`,
      (rows) => Number(rows[0]?.aCanonical) === 1 && Number(rows[0]?.aRoot) === 1,
      "the selected A review reaches only A's ordinary promotion and residual-credit recovery");
    assert.deepEqual({ aCanonical: Number(reviewScope[0].aCanonical), bCanonical: Number(reviewScope[0].bCanonical),
      cCanonical: Number(reviewScope[0].cCanonical), aRoot: Number(reviewScope[0].aRoot), bConfirmations: Number(reviewScope[0].bConfirmations) },
    { aCanonical: 1, bCanonical: 0, cCanonical: 0, aRoot: 1, bConfirmations: 0 },
    "one rendered A review cannot promote B/C, create B confirmation, or duplicate A's 120 MNT residual root");
    await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(historicalB)}`);
    const historicalBRow = page.locator(`[data-registration-child="${historicalB}"]`);
    await historicalBRow.waitFor({ state: "visible" });
    const historicalBForm = historicalBRow.locator("[data-historical-settlement-form]");
    await historicalBForm.waitFor({ state: "visible" });
    assert.match(await historicalBForm.innerText(), /Түүхэн төлбөрийг хянаж баталгаажуулах/,
      "reviewing A through the rendered action leaves B in its own explicit historical-review state");
    await historicalBForm.locator('[name="historicalSettlementReason"]').fill("Browser B legacy receipt review");
    const bReviewResponse = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
      && response.request().method() === "POST" && response.request().postData()?.includes("payment.review-historical-settlement"));
    await historicalBForm.getByRole("button", { name: "Төлбөрийг хянаж баталгаажуулах" }).click();
    assert.equal((await bReviewResponse).status(), 200,
      "B's later rendered review creates its own quote-bound confirmation rather than reusing A's registration-wide result");
    const sequentialReview = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM payment_confirmation WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = ${sql(historicalDraftId)})) AS confirmations,
      (SELECT COUNT(*) FROM registration_draft_child WHERE id = ${sql(historicalA)} AND canonical_enrollment_id IS NOT NULL) AS aCanonical,
      (SELECT COUNT(*) FROM registration_draft_child WHERE id = ${sql(historicalB)} AND canonical_enrollment_id IS NOT NULL) AS bCanonical,
      (SELECT COUNT(*) FROM registration_draft_child WHERE id = ${sql(historicalC)} AND canonical_enrollment_id IS NOT NULL) AS cCanonical,
      (SELECT COUNT(*) FROM child_credit_entry WHERE source_discount_award_id = ${sql(`browser-history-award-${historicalA}`)}) AS aRoots,
      (SELECT COUNT(*) FROM child_credit_entry WHERE source_discount_award_id = ${sql(`browser-history-award-${historicalB}`)}) AS bRoots`,
      (rows) => Number(rows[0]?.confirmations) === 2 && Number(rows[0]?.bCanonical) === 1,
      "B's independent rendered review reaches its own canonical confirmation");
    assert.deepEqual({ confirmations: Number(sequentialReview[0].confirmations), aCanonical: Number(sequentialReview[0].aCanonical),
      bCanonical: Number(sequentialReview[0].bCanonical), cCanonical: Number(sequentialReview[0].cCanonical),
      aRoots: Number(sequentialReview[0].aRoots), bRoots: Number(sequentialReview[0].bRoots) },
    { confirmations: 2, aCanonical: 1, bCanonical: 1, cCanonical: 0, aRoots: 1, bRoots: 0 },
    "sequential reviews retain separate A/B confirmations, one A residual root, no B residual, and C pending");
  } else if (process.env.CONDITIONAL_FAMILY_BROWSER_ONLY === "1") {
    execute(`UPDATE offering_course_pricing SET one_time_amount_mnt = 1200, first_installment_amount_mnt = 600,
      second_installment_amount_mnt = 600 WHERE activity_offering_id = 'browser-offering';`);
    const ordinary = await submitPublicRegistration(browser, {
      childName: "ConditionalOrdinaryRawPaid", email: "conditional-ordinary@example.test", paymentPlanCode: "single", expectedInitialAmount: 1200,
    });
    await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(ordinary)}`);
    const ordinarySeat = page.locator(`[data-registration-child="${ordinary}"] [data-seat-approval] input`);
    await ordinarySeat.waitFor({ state: "visible" });
    assert.equal(await ordinarySeat.isChecked(), true, "an ordinary full payment keeps the existing checked sufficient state");
    assert.equal(await ordinarySeat.isDisabled(), true, "an ordinary full payment keeps the existing disabled sufficient state");
    const ordinarySubmission = await recordCashPayment(page, ordinary, 1200);
    assert.equal(ordinarySubmission.approveSeatConfirmation, false,
      "the ordinary disabled sufficient state never submits a partial-seat approval flag");
    const ordinaryPartial = await submitPublicRegistration(browser, {
      childName: "ConditionalOrdinaryPartial", email: "conditional-ordinary-partial@example.test", paymentPlanCode: "single", expectedInitialAmount: 1200,
    });
    await recordApprovedPartialCashPayment(page, ordinaryPartial, 1199);
    execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
      WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(ordinary)}));`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok,
      "the rendered ordinary raw-paid payment reaches the same latest finalizer");
    const ordinaryPromotion = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM enrollment WHERE id = (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id = ${sql(ordinary)}) AND status = 'confirmed') AS enrollments,
      (SELECT COUNT(*) FROM conditional_family_discount_quote WHERE registration_draft_child_id = ${sql(ordinary)}) AS quotes`,
      (rows) => Number(rows[0]?.enrollments) === 1,
      "ordinary raw-paid promotion remains eligible without a conditional-seat workflow");
    assert.deepEqual({ enrollments: Number(ordinaryPromotion[0]?.enrollments), quotes: Number(ordinaryPromotion[0]?.quotes) },
      { enrollments: 1, quotes: 0 },
      "the conditional finalizer changes neither ordinary raw-paid enrollment nor its communication classification");

    const joint = await submitPublicRegistration(browser, {
      childName: "ConditionalJointA", email: "conditional-joint@example.test", paymentPlanCode: "single", expectedInitialAmount: 1200,
      siblings: [{ childName: "ConditionalJointB", classSessionId: "browser-class-target", paymentPlanCode: "single" }],
    });
    const [jointA, jointB] = joint;
    await recordCashPayment(page, jointA, 1080);
    const beforeSecond = await dbJson(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(jointA)}, ${sql(jointB)})
        AND award_type = 'family_multi_child') AS awards,
      (SELECT COUNT(*) FROM conditional_family_discount_quote WHERE registration_draft_child_id IN (${sql(jointA)}, ${sql(jointB)})
        AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')) AS pendingQuotes`);
    assert.equal(Number(beforeSecond[0]?.awards), 0, "one conditional receipt alone does not earn a family award");
    assert.equal(Number(beforeSecond[0]?.pendingQuotes), 2,
      "the first 1,080 MNT receipt leaves both agreements in the durable conditional state until their qualifying subset completes");
    await recordCashPayment(page, jointB, 1080);
    execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
      WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(jointA)}));`);
    const scheduled = await fetch(`${baseUrl}/__scheduled`);
    assert.ok(scheduled.ok, "the local scheduled Worker accepts the joint conditional settlement trigger");
    const jointResult = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(jointA)}, ${sql(jointB)})
        AND award_type = 'family_multi_child' AND qualification_state = 'earned') AS awards,
      (SELECT COALESCE(SUM(received_amount_mnt), 0) FROM received_payment WHERE payment_request_id IN (
        SELECT id FROM payment_request WHERE registration_draft_id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(jointA)}))) AS cash,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM payment_installment WHERE registration_draft_child_id IN (${sql(jointA)}, ${sql(jointB)})) AS raw
      `, (rows) => Number(rows[0]?.awards) === 2, "both joint conditional quotes become earned once both receipts finalize");
    assert.deepEqual({ awards: Number(jointResult[0]?.awards), cash: Number(jointResult[0]?.cash) }, { awards: 2, cash: 2160 },
      "joint 1,080 + 1,080 settlement preserves exactly 2,160 MNT cash and two earned awards");
    const [jointAProjection, jointBProjection] = await Promise.all([
      staffPaymentProjection(page, jointA),
      staffPaymentProjection(page, jointB),
    ]);
    assert.deepEqual([Number(jointAProjection?.totalRemainingMnt), Number(jointBProjection?.totalRemainingMnt)], [0, 0],
      "once both conditional receipts qualify, both rendered payment projections have no payable balance");

    const qualifiedThird = await submitPublicRegistration(browser, {
      childName: "ConditionalQualifiedThirdA", email: "conditional-qualified-third@example.test", paymentPlanCode: "single", expectedInitialAmount: 1200,
      siblings: [
        { childName: "ConditionalQualifiedThirdB", classSessionId: "browser-class-target", paymentPlanCode: "single" },
        { childName: "ConditionalQualifiedThirdC", classSessionId: "browser-class-target", paymentPlanCode: "single" },
      ],
    });
    const [qualifiedThirdA, qualifiedThirdB, qualifiedThirdC] = qualifiedThird;
    await recordCashPayment(page, qualifiedThirdA, 1080);
    await recordCashPayment(page, qualifiedThirdB, 1080);
    execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
      WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(qualifiedThirdA)}));`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok,
      "the two funded members establish the family qualification before the third payment is collected");
    await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(qualifiedThirdC)}`);
    const qualifiedThirdRow = page.locator(`[data-registration-child="${qualifiedThirdC}"]`);
    const qualifiedThirdForm = qualifiedThirdRow.locator('[data-payment-form]');
    await qualifiedThirdForm.waitFor({ state: "visible" });
    await page.setViewportSize({ width: 1200, height: 900 });
    const desktopColumns = await qualifiedThirdForm.locator(".staff-payment-financial-summary")
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length);
    assert.equal(desktopColumns, 2, "the staff payment calculation has two independent columns on desktop");
    await capturePaymentPanel(page, "conditional-payment-desktop.png");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileColumns = await qualifiedThirdForm.locator(".staff-payment-financial-summary")
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length);
    assert.equal(mobileColumns, 1, "the staff payment calculation stacks price before collection on a narrow viewport");
    await capturePaymentPanel(page, "conditional-payment-mobile.png");
    assert.equal(Number(await qualifiedThirdForm.locator('input[name="amount"]').inputValue()), 1080,
      "a third child with an already-qualified family is collected at the established 1,080 MNT effective amount without an override");
    assert.match(await qualifiedThirdForm.innerText(), /Гэр бүлийн хөнгөлөлт · 10%: 120 ₮/,
      "the rendered collection form shows the configured discount once in its price calculation");
    assert.match(await qualifiedThirdForm.innerText(), /Гэр бүлийн хөнгөлөлтийн нөхцөл хангагдсан\./,
      "the established qualification uses a concise factual explanation rather than a pending warning");
    const qualifiedThirdSeat = qualifiedThirdForm.locator('[data-seat-approval] input');
    assert.equal(await qualifiedThirdSeat.isDisabled(), true,
      "the normal effective amount is sufficient and does not require an insufficient-payment seat override");
    assert.equal(await qualifiedThirdSeat.isChecked(), true,
      "the sufficient control is visibly checked while remaining excluded from the partial-approval request");
    assert.equal(await qualifiedThirdForm.locator("[data-seat-approval-copy]").innerText(), "Суудлыг баталгаажуулах",
      "the sufficient seat control keeps the concise action label instead of replacing it with status prose");
    assert.equal(await qualifiedThirdForm.locator("[data-seat-approval-explanation]").isVisible(), true,
      "the sufficient conditional amount has a separate muted explanation");
    assert.doesNotMatch(await qualifiedThirdForm.innerText(), /Нөхцөлт тооцооллоор авах санал/,
      "an established family qualification does not retain the obsolete conditional collection proposal");
    assert.equal(await qualifiedThirdForm.locator(".staff-payment-financial-details").count(), 0,
      "an otherwise empty financial details disclosure is not rendered for the qualified payment");
    await qualifiedThirdForm.locator('input[name="amount"]').fill("1079");
    assert.equal(await qualifiedThirdSeat.isDisabled(), false,
      "reducing the amount restores the explicit incomplete-payment approval control");
    assert.equal(await qualifiedThirdSeat.isChecked(), false,
      "the incomplete-payment control is no longer presented as automatically approved");
    assert.equal(await qualifiedThirdForm.locator("[data-seat-approval-explanation]").isVisible(), false,
      "the completion explanation disappears when the entered amount is no longer sufficient");
    await qualifiedThirdForm.locator('input[name="amount"]').fill("1080");
    assert.equal(await qualifiedThirdSeat.isDisabled(), true,
      "returning to the effective conditional amount restores the protected sufficient state");
    const qualifiedThirdSubmission = await recordCashPayment(page, qualifiedThirdC, 1080);
    assert.equal(qualifiedThirdSubmission.approveSeatConfirmation, false,
      "the disabled sufficient control cannot submit a stale incomplete-payment approval");
    execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
      WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(qualifiedThirdC)}));`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok,
      "the third child's normal discounted payment reaches the protected family finalizer");
    const qualifiedThirdResult = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(qualifiedThirdA)}, ${sql(qualifiedThirdB)}, ${sql(qualifiedThirdC)})
        AND qualification_state = 'earned') AS awards,
      (SELECT COALESCE(SUM(received_amount_mnt), 0) FROM received_payment WHERE payment_request_id IN (
        SELECT id FROM payment_request WHERE registration_draft_id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(qualifiedThirdA)}))) AS cash`,
      (rows) => Number(rows[0]?.awards) === 3,
      "the third agreement earns exactly one award through normal finalization after its own cash payment");
    assert.deepEqual({ awards: Number(qualifiedThirdResult[0]?.awards), cash: Number(qualifiedThirdResult[0]?.cash) }, { awards: 3, cash: 3240 },
      "three independently recorded discounted receipts retain 3,240 MNT actual cash and three earned awards");
    const qualifiedThirdProjection = await staffPaymentProjection(page, qualifiedThirdC);
    assert.equal(Number(qualifiedThirdProjection?.totalRemainingMnt), 0,
      "the third child's protected finalizer leaves no payable balance after its normal 1,080 MNT receipt");

    if (process.env.PAYMENT_PANEL_BROWSER_ONLY !== "1") {
    const sequential = await submitPublicRegistration(browser, {
      childName: "ConditionalSequentialDonor", email: "conditional-sequential@example.test", paymentPlanCode: "single", expectedInitialAmount: 1200,
      siblings: [{ childName: "ConditionalSequentialRecipient", classSessionId: "browser-class-target", paymentPlanCode: "single" }],
    });
    const [sequentialDonor, sequentialRecipient] = sequential;
    await recordCashPayment(page, sequentialDonor, 1200, { expectedAmount: 1080 });
    execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
      WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(sequentialDonor)}));`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the donor's ordinary receipt reaches the conditional-seat decision point");
    await approveConditionalSeat(page, sequentialDonor, "Browser conditional donor seat");
    const donorBeforeRecipient = await dbJson(`SELECT canonical_enrollment_id AS enrollmentId FROM registration_draft_child
      WHERE id = ${sql(sequentialDonor)}`);
    assert.ok(donorBeforeRecipient[0]?.enrollmentId, "the explicit conditional-seat workflow confirms only the funded donor seat");

    await recordCashPayment(page, sequentialRecipient, 960, { expectedAmount: 1080 });
    const beforeDismiss = await dbJson(`SELECT
      (SELECT COUNT(*) FROM audit_event WHERE action = 'conditional_family_contingent_credit_authorized'
        AND subject_id IN (SELECT id FROM conditional_family_discount_quote WHERE registration_draft_child_id = ${sql(sequentialRecipient)})) AS authorizations,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id IN (${sql(sequentialDonor)}, ${sql(sequentialRecipient)})
        OR target_registration_draft_child_id IN (${sql(sequentialDonor)}, ${sql(sequentialRecipient)})) AS creditOperations,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(sequentialDonor)}, ${sql(sequentialRecipient)})) AS awards,
      (SELECT COUNT(*) FROM registration_draft_child INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
        WHERE registration_draft_child.id = ${sql(sequentialRecipient)} AND enrollment.status = 'confirmed') AS recipientEnrollments,
      (SELECT COUNT(*) FROM outbound_email WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(sequentialRecipient)})) AS notifications`);
    const dismissed = await openContingentCreditAuthorization(page, sequentialRecipient);
    await dismissed.form.locator('[data-conditional-contingent-credit-cancel]').click();
    const dismissedToggle = dismissed.row.locator(`[data-payment-detail]`).first();
    await dismissedToggle.waitFor({ state: "visible" });
    assert.equal(await dismissedToggle.getAttribute("aria-expanded"), "false",
      "dismissing the contingent proposal closes only its record without submitting any operation");
    const afterDismiss = await dbJson(`SELECT
      (SELECT COUNT(*) FROM audit_event WHERE action = 'conditional_family_contingent_credit_authorized'
        AND subject_id IN (SELECT id FROM conditional_family_discount_quote WHERE registration_draft_child_id = ${sql(sequentialRecipient)})) AS authorizations,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id IN (${sql(sequentialDonor)}, ${sql(sequentialRecipient)})
        OR target_registration_draft_child_id IN (${sql(sequentialDonor)}, ${sql(sequentialRecipient)})) AS creditOperations,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(sequentialDonor)}, ${sql(sequentialRecipient)})) AS awards,
      (SELECT COUNT(*) FROM registration_draft_child INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
        WHERE registration_draft_child.id = ${sql(sequentialRecipient)} AND enrollment.status = 'confirmed') AS recipientEnrollments,
      (SELECT COUNT(*) FROM outbound_email WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(sequentialRecipient)})) AS notifications`);
    assert.deepEqual(afterDismiss[0], beforeDismiss[0], "opening and dismissing contingent credit leaves authorization, value, awards, and enrollment untouched");

    await authorizeContingentCredit(page, sequentialRecipient, "Browser donor residual for recipient settlement");
    execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
      WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(sequentialRecipient)}));`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the recipient's authorized conditional settlement reaches the protected finalizer");
    const sequentialResult = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(sequentialDonor)}, ${sql(sequentialRecipient)})
        AND award_type = 'family_multi_child' AND qualification_state = 'earned') AS awards,
      (SELECT COALESCE(SUM(received_amount_mnt), 0) FROM received_payment WHERE payment_request_id IN (
        SELECT id FROM payment_request WHERE registration_draft_id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(sequentialDonor)}))) AS cash,
      (SELECT COUNT(*) FROM child_credit_operation WHERE operation_type = 'transfer'
        AND source_registration_draft_child_id = ${sql(sequentialDonor)} AND target_registration_draft_child_id = ${sql(sequentialRecipient)}
        AND amount_mnt = 120) AS transfers,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(sequentialDonor)}
        AND entry_kind = 'discount_award_credit') AS donorRoot,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(sequentialDonor)}
        AND entry_kind = 'credit_transfer_debit') AS donorDebit,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(sequentialRecipient)}
        AND entry_kind = 'credit_transfer_credit') AS recipientTransfer,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(sequentialRecipient)}
        AND entry_kind = 'credit_application') AS recipientApplication,
      (SELECT COUNT(*) FROM registration_draft_child INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
        WHERE registration_draft_child.id IN (${sql(sequentialDonor)}, ${sql(sequentialRecipient)}) AND enrollment.status = 'confirmed') AS enrollments`,
      (rows) => Number(rows[0]?.awards) === 2 && Number(rows[0]?.recipientApplication) === -120,
      "the protected sequential settlement creates and consumes the contingent value exactly once");
    assert.deepEqual({ awards: Number(sequentialResult[0]?.awards), cash: Number(sequentialResult[0]?.cash),
      transfers: Number(sequentialResult[0]?.transfers), donorRoot: Number(sequentialResult[0]?.donorRoot),
      donorDebit: Number(sequentialResult[0]?.donorDebit), recipientTransfer: Number(sequentialResult[0]?.recipientTransfer),
      recipientApplication: Number(sequentialResult[0]?.recipientApplication), enrollments: Number(sequentialResult[0]?.enrollments) },
    { awards: 2, cash: 2160, transfers: 1, donorRoot: 120, donorDebit: -120, recipientTransfer: 120, recipientApplication: -120, enrollments: 2 },
    "sequential 1,200 + 960 retains 2,160 MNT cash while one protected 120 MNT contingent credit has no spendable intermediate copy");
    const [sequentialDonorProjection, sequentialRecipientProjection] = await Promise.all([
      staffPaymentProjection(page, sequentialDonor),
      staffPaymentProjection(page, sequentialRecipient),
    ]);
    assert.deepEqual([Number(sequentialDonorProjection?.totalRemainingMnt), Number(sequentialRecipientProjection?.totalRemainingMnt)], [0, 0],
      "the rendered projections show both sequential agreements fully settled after the protected finalizer");
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "a finalizer replay is accepted");
    const replay = await dbJson(`SELECT COUNT(*) AS transfers FROM child_credit_operation WHERE operation_type = 'transfer'
      AND source_registration_draft_child_id = ${sql(sequentialDonor)} AND target_registration_draft_child_id = ${sql(sequentialRecipient)}`);
    assert.equal(Number(replay[0]?.transfers), 1, "a finalizer replay cannot duplicate the contingent transfer/application operation");

    const concurrentFinalizers = await prepareConditionalSequentialPair(browser, page, "ConditionalConcurrentFinalizers");
    const concurrentResponses = await Promise.all([
      fetch(`${baseUrl}/__scheduled`),
      fetch(`${baseUrl}/__scheduled`),
    ]);
    assert.ok(concurrentResponses.every((response) => response.ok),
      "two scheduler/finalizer attempts accept the same ready conditional settlement without an API failure");
    const concurrentResult = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(concurrentFinalizers.donor)}, ${sql(concurrentFinalizers.recipient)})
        AND qualification_state = 'earned') AS awards,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(concurrentFinalizers.donor)}
        AND target_registration_draft_child_id = ${sql(concurrentFinalizers.recipient)}) AS transfers,
      (SELECT COUNT(*) FROM enrollment WHERE id IN (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id IN (${sql(concurrentFinalizers.donor)}, ${sql(concurrentFinalizers.recipient)}))) AS enrollments`,
      (rows) => Number(rows[0]?.awards) === 2 && Number(rows[0]?.enrollments) === 2,
      "one of two simultaneous scheduler attempts claims and completes the ready settlement");
    assert.deepEqual({ awards: Number(concurrentResult[0]?.awards), transfers: Number(concurrentResult[0]?.transfers),
      enrollments: Number(concurrentResult[0]?.enrollments) }, { awards: 2, transfers: 1, enrollments: 2 },
    "concurrent finalizer attempts create exactly one contingent transfer and one enrollment per agreement");

    const failure = await submitPublicRegistration(browser, {
      childName: "ConditionalFailureDonor", email: "conditional-failure@example.test", paymentPlanCode: "single", expectedInitialAmount: 1200,
      siblings: [{ childName: "ConditionalFailureRecipient", classSessionId: "browser-class-target", paymentPlanCode: "single" }],
    });
    const [failureDonor, failureRecipient] = failure;
    await recordCashPayment(page, failureDonor, 1200, { expectedAmount: 1080 });
    execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
      WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(failureDonor)}));`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the failure fixture donor reaches conditional-seat review through the normal scheduler");
    await approveConditionalSeat(page, failureDonor, "Browser failure-retry donor seat");
    await recordCashPayment(page, failureRecipient, 960, { expectedAmount: 1080 });
    await authorizeContingentCredit(page, failureRecipient, "Browser injected-failure settlement");
    execute(`CREATE TRIGGER browser_conditional_family_settlement_failure
      BEFORE INSERT ON child_credit_entry
      WHEN NEW.entry_kind = 'credit_application' AND NEW.reason = 'Conditional family contingent settlement'
      BEGIN SELECT RAISE(ABORT, 'browser conditional settlement failure'); END;`);
    execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
      WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(failureRecipient)}));`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the injected local settlement failure is observable through the normal scheduled finalizer");
    const failed = await waitForDb(`SELECT
      (SELECT COALESCE(SUM(received_amount_mnt), 0) FROM received_payment WHERE payment_request_id IN (
        SELECT id FROM payment_request WHERE registration_draft_id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(failureDonor)}))) AS cash,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(failureDonor)}, ${sql(failureRecipient)})
        AND qualification_state = 'earned') AS earnedAwards,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(failureDonor)}, ${sql(failureRecipient)})
        AND qualification_state = 'provisional') AS provisionalAwards,
      (SELECT COALESCE(SUM(reserved_amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(failureDonor)}
        AND entry_kind = 'discount_award_credit') AS reservedCredit,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(failureDonor)}
        AND target_registration_draft_child_id = ${sql(failureRecipient)}) AS transfers,
      (SELECT COUNT(*) FROM registration_draft_child INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
        WHERE registration_draft_child.id = ${sql(failureRecipient)} AND enrollment.status = 'confirmed') AS recipientEnrollments,
      (SELECT COUNT(*) FROM conditional_family_discount_quote WHERE registration_draft_child_id IN (${sql(failureDonor)}, ${sql(failureRecipient)})
        AND last_error_code = 'settlement_retryable') AS retryableQuotes`,
      (rows) => Number(rows[0]?.retryableQuotes) === 2,
      "the injected financial-write failure leaves a durable retryable quote state");
    assert.deepEqual({ cash: Number(failed[0]?.cash), earnedAwards: Number(failed[0]?.earnedAwards),
      provisionalAwards: Number(failed[0]?.provisionalAwards), reservedCredit: Number(failed[0]?.reservedCredit),
      transfers: Number(failed[0]?.transfers), recipientEnrollments: Number(failed[0]?.recipientEnrollments) },
    { cash: 2160, earnedAwards: 0, provisionalAwards: 2, reservedCredit: 120, transfers: 0, recipientEnrollments: 0 },
    "a failure after reserved-root creation preserves cash but leaves no earned award, transfer, application, or recipient enrollment");
    const failedDonorProjection = await staffPaymentProjection(page, failureDonor);
    assert.equal(Number(failedDonorProjection?.availableCreditMnt), 0,
      "a provisional reserved award root is excluded from the real staff credit projection and ordinary credit controls");
    execute("DROP TRIGGER browser_conditional_family_settlement_failure;");
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the normal scheduler retries the released conditional settlement claim");
    const recovered = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(failureDonor)}, ${sql(failureRecipient)})
        AND qualification_state = 'earned') AS awards,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(failureDonor)}
        AND target_registration_draft_child_id = ${sql(failureRecipient)} AND operation_type = 'transfer') AS transfers,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(failureRecipient)}
        AND entry_kind = 'credit_application') AS application,
      (SELECT COALESCE(SUM(reserved_amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(failureDonor)}
        AND entry_kind = 'discount_award_credit') AS reservedCredit,
      (SELECT COUNT(*) FROM registration_draft_child INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
        WHERE registration_draft_child.id IN (${sql(failureDonor)}, ${sql(failureRecipient)}) AND enrollment.status = 'confirmed') AS enrollments`,
      (rows) => Number(rows[0]?.awards) === 2 && Number(rows[0]?.application) === -120 && Number(rows[0]?.enrollments) === 2,
      "retry resolves the protected settlement and promotes both eligible seats exactly once");
    assert.deepEqual({ awards: Number(recovered[0]?.awards), transfers: Number(recovered[0]?.transfers),
      application: Number(recovered[0]?.application), reservedCredit: Number(recovered[0]?.reservedCredit),
      enrollments: Number(recovered[0]?.enrollments) }, { awards: 2, transfers: 1, application: -120,
      reservedCredit: 0, enrollments: 2 },
    "retry/replay produces one complete settlement with no reserved or intermediate credit left behind");
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "a completed recovery is safe to replay through the normal scheduler");
    const recoveryReplay = await dbJson(`SELECT
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(failureDonor)}
        AND target_registration_draft_child_id = ${sql(failureRecipient)} AND operation_type = 'transfer') AS transfers,
      (SELECT COUNT(*) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(failureRecipient)}
        AND entry_kind = 'credit_application') AS applications,
      (SELECT COUNT(*) FROM enrollment WHERE id IN (
        SELECT canonical_enrollment_id FROM registration_draft_child WHERE id IN (${sql(failureDonor)}, ${sql(failureRecipient)}))) AS enrollments`);
    assert.deepEqual({ transfers: Number(recoveryReplay[0]?.transfers), applications: Number(recoveryReplay[0]?.applications),
      enrollments: Number(recoveryReplay[0]?.enrollments) }, { transfers: 1, applications: 1, enrollments: 2 },
    "a retry replay cannot duplicate the recovered transfer, application, or enrollment");

    const beforeReservation = await prepareConditionalSequentialPair(browser, page, "ConditionalBeforeReservation");
    execute(`CREATE TRIGGER browser_conditional_before_reservation_failure
      BEFORE INSERT ON child_credit_operation
      WHEN NEW.operation_type = 'discount_award_credit' AND NEW.source_registration_draft_child_id = ${sql(beforeReservation.donor)}
      BEGIN SELECT RAISE(ABORT, 'browser provisional award interruption'); END;`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the provisional-award interruption reaches the normal finalizer");
    const beforeReservationState = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(beforeReservation.donor)}, ${sql(beforeReservation.recipient)})
        AND qualification_state = 'provisional') AS provisionalAwards,
      (SELECT COUNT(*) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(beforeReservation.donor)}
        AND entry_kind = 'discount_award_credit') AS donorRoots,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(beforeReservation.donor)}
        AND target_registration_draft_child_id = ${sql(beforeReservation.recipient)}) AS transfers,
      (SELECT COUNT(*) FROM enrollment WHERE id = (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id = ${sql(beforeReservation.recipient)})) AS recipientEnrollments`,
      (rows) => Number(rows[0]?.provisionalAwards) === 2,
      "an interruption before donor reservation leaves durable provisional awards only");
    assert.deepEqual({ provisionalAwards: Number(beforeReservationState[0]?.provisionalAwards), donorRoots: Number(beforeReservationState[0]?.donorRoots),
      transfers: Number(beforeReservationState[0]?.transfers), recipientEnrollments: Number(beforeReservationState[0]?.recipientEnrollments) },
    { provisionalAwards: 2, donorRoots: 0, transfers: 0, recipientEnrollments: 0 },
    "provisional awards create neither a root nor an independently spendable transfer before reservation");
    execute("DROP TRIGGER browser_conditional_before_reservation_failure;");
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "scheduler recovery retries after the pre-reservation interruption");
    const beforeReservationRecovered = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(beforeReservation.donor)}, ${sql(beforeReservation.recipient)})
        AND qualification_state = 'earned') AS awards,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(beforeReservation.donor)}
        AND target_registration_draft_child_id = ${sql(beforeReservation.recipient)}) AS transfers,
      (SELECT COUNT(*) FROM enrollment WHERE id IN (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id IN (${sql(beforeReservation.donor)}, ${sql(beforeReservation.recipient)}))) AS enrollments`,
      (rows) => Number(rows[0]?.awards) === 2 && Number(rows[0]?.enrollments) === 2,
      "pre-reservation recovery converges through the ordinary finalizer");
    assert.deepEqual({ awards: Number(beforeReservationRecovered[0]?.awards), transfers: Number(beforeReservationRecovered[0]?.transfers),
      enrollments: Number(beforeReservationRecovered[0]?.enrollments) }, { awards: 2, transfers: 1, enrollments: 2 },
    "recovery after provisional creation produces one settlement without extra value");

    const afterFinancial = await prepareConditionalSequentialPair(browser, page, "ConditionalAfterFinancial");
    execute(`CREATE TRIGGER browser_conditional_before_resolution_failure
      BEFORE UPDATE OF state ON conditional_family_discount_quote
      WHEN NEW.state = 'qualified' AND NEW.registration_draft_child_id IN (${sql(afterFinancial.donor)}, ${sql(afterFinancial.recipient)})
      BEGIN SELECT RAISE(ABORT, 'browser financial settlement interruption'); END;`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the post-financial interruption reaches the normal finalizer");
    const afterFinancialState = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(afterFinancial.donor)}, ${sql(afterFinancial.recipient)})
        AND qualification_state = 'provisional') AS provisionalAwards,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(afterFinancial.donor)}
        AND target_registration_draft_child_id = ${sql(afterFinancial.recipient)}) AS transfers,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(afterFinancial.recipient)}
        AND entry_kind = 'credit_application') AS application,
      (SELECT COALESCE(SUM(reserved_amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(afterFinancial.donor)}
        AND entry_kind = 'discount_award_credit') AS reservedCredit,
      (SELECT COUNT(*) FROM enrollment WHERE id = (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id = ${sql(afterFinancial.recipient)})) AS recipientEnrollments`,
      (rows) => Number(rows[0]?.transfers) === 1,
      "the fault after financial application leaves a durable fenced settlement for recovery");
    assert.deepEqual({ provisionalAwards: Number(afterFinancialState[0]?.provisionalAwards), transfers: Number(afterFinancialState[0]?.transfers),
      application: Number(afterFinancialState[0]?.application), reservedCredit: Number(afterFinancialState[0]?.reservedCredit),
      recipientEnrollments: Number(afterFinancialState[0]?.recipientEnrollments) },
    { provisionalAwards: 2, transfers: 1, application: -120, reservedCredit: 0, recipientEnrollments: 0 },
    "after financial commit, the operation has no spendable residue and does not promote before qualification resolves");
    await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(afterFinancial.recipient)}`);
    await page.getByText("Бэлэн мөнгөний төлбөр бүртгэгдсэн. Нөөцөлсөн кредитийг хамгаалсан баталгаажуулалт хүлээгдэж байна.")
      .waitFor({ state: "visible" });
    execute("DROP TRIGGER browser_conditional_before_resolution_failure;");
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "scheduler recovery finalizes the already-committed contingent settlement");
    const afterFinancialRecovered = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(afterFinancial.donor)}, ${sql(afterFinancial.recipient)})
        AND qualification_state = 'earned') AS awards,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(afterFinancial.donor)}
        AND target_registration_draft_child_id = ${sql(afterFinancial.recipient)}) AS transfers,
      (SELECT COUNT(*) FROM enrollment WHERE id IN (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id IN (${sql(afterFinancial.donor)}, ${sql(afterFinancial.recipient)}))) AS enrollments`,
      (rows) => Number(rows[0]?.awards) === 2 && Number(rows[0]?.enrollments) === 2,
      "post-financial recovery completes qualification and promotion");
    assert.deepEqual({ awards: Number(afterFinancialRecovered[0]?.awards), transfers: Number(afterFinancialRecovered[0]?.transfers),
      enrollments: Number(afterFinancialRecovered[0]?.enrollments) }, { awards: 2, transfers: 1, enrollments: 2 },
    "post-financial recovery cannot create a second transfer or enrollment");

    const afterQualification = await prepareConditionalSequentialPair(browser, page, "ConditionalAfterQualification");
    execute(`CREATE TRIGGER browser_conditional_before_enrollment_failure
      BEFORE INSERT ON enrollment
      BEGIN SELECT RAISE(ABORT, 'browser enrollment interruption'); END;`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the post-qualification enrollment interruption reaches the normal finalizer");
    const afterQualificationState = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(afterQualification.donor)}, ${sql(afterQualification.recipient)})
        AND qualification_state = 'earned') AS awards,
      (SELECT COUNT(*) FROM conditional_family_discount_quote WHERE registration_draft_child_id IN (${sql(afterQualification.donor)}, ${sql(afterQualification.recipient)})
        AND state = 'qualified') AS qualifiedQuotes,
      (SELECT COUNT(*) FROM enrollment WHERE id = (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id = ${sql(afterQualification.recipient)})) AS recipientEnrollments`,
      (rows) => Number(rows[0]?.qualifiedQuotes) === 2,
      "qualification is durable even when promotion itself fails");
    assert.deepEqual({ awards: Number(afterQualificationState[0]?.awards), qualifiedQuotes: Number(afterQualificationState[0]?.qualifiedQuotes),
      recipientEnrollments: Number(afterQualificationState[0]?.recipientEnrollments) }, { awards: 2, qualifiedQuotes: 2, recipientEnrollments: 0 },
    "post-qualification interruption does not roll back earned settlement or invent a recipient enrollment");
    execute("DROP TRIGGER browser_conditional_before_enrollment_failure;");
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok, "the normal stranded-promotion recovery retries the qualified recipient");
    const afterQualificationRecovered = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(afterQualification.donor)}
        AND target_registration_draft_child_id = ${sql(afterQualification.recipient)}) AS transfers,
      (SELECT COUNT(*) FROM enrollment WHERE id IN (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id IN (${sql(afterQualification.donor)}, ${sql(afterQualification.recipient)}))) AS enrollments`,
      (rows) => Number(rows[0]?.enrollments) === 2,
      "promotion recovery completes after the transient enrollment failure");
    assert.deepEqual({ transfers: Number(afterQualificationRecovered[0]?.transfers), enrollments: Number(afterQualificationRecovered[0]?.enrollments) },
      { transfers: 1, enrollments: 2 }, "post-qualification recovery preserves the single settled operation");

    const cancellationRace = await prepareConditionalSequentialPair(browser, page, "ConditionalCancellationRace");
    execute(`CREATE TRIGGER browser_conditional_cancellation_race_failure
      BEFORE INSERT ON child_credit_entry
      WHEN NEW.entry_kind = 'credit_application' AND NEW.reason = 'Conditional family contingent settlement'
      BEGIN SELECT RAISE(ABORT, 'browser cancellation race interruption'); END;`);
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok,
      "the cancellation-race fixture reaches the protected finalizer before the conflicting cancellation");
    const cancellationInterrupted = await waitForDb(`SELECT
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(cancellationRace.donor)}, ${sql(cancellationRace.recipient)})
        AND qualification_state = 'provisional') AS provisionalAwards,
      (SELECT COUNT(*) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(cancellationRace.donor)}
        AND entry_kind = 'discount_award_credit') AS donorRoots,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(cancellationRace.donor)}
        AND target_registration_draft_child_id = ${sql(cancellationRace.recipient)}) AS transfers`,
      (rows) => Number(rows[0]?.provisionalAwards) === 2 && Number(rows[0]?.donorRoots) === 1,
      "the interrupted cancellation fixture has durable provisional recovery evidence only");
    assert.deepEqual({ provisionalAwards: Number(cancellationInterrupted[0]?.provisionalAwards), donorRoots: Number(cancellationInterrupted[0]?.donorRoots),
      transfers: Number(cancellationInterrupted[0]?.transfers) }, { provisionalAwards: 2, donorRoots: 1, transfers: 0 },
    "the conflicting cancellation begins before any contingent transfer/application commits");
    await cancelAndRestoreRegistration(page, cancellationRace.donor, { restore: false });
    execute("DROP TRIGGER browser_conditional_cancellation_race_failure;");
    assert.ok((await fetch(`${baseUrl}/__scheduled`)).ok,
      "a stale scheduler recovery runs after the source cancellation wins");
    const cancellationResolved = await waitForDb(`SELECT
      (SELECT state FROM conditional_family_discount_quote WHERE registration_draft_child_id = ${sql(cancellationRace.donor)}) AS donorState,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(cancellationRace.donor)}, ${sql(cancellationRace.recipient)})
        AND qualification_state = 'earned') AS earnedAwards,
      (SELECT COUNT(*) FROM child_credit_operation WHERE source_registration_draft_child_id = ${sql(cancellationRace.donor)}
        AND target_registration_draft_child_id = ${sql(cancellationRace.recipient)}) AS transfers,
      (SELECT COUNT(*) FROM enrollment WHERE id = (SELECT canonical_enrollment_id FROM registration_draft_child
        WHERE id = ${sql(cancellationRace.recipient)})) AS recipientEnrollments,
      (SELECT COALESCE(SUM(reserved_amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id = ${sql(cancellationRace.donor)}
        AND entry_kind = 'discount_award_credit') AS reservedCredit`,
      (rows) => rows[0]?.donorState === 'cancelled',
      "cancellation durably invalidates its pending conditional quote before recovery can complete it");
    assert.deepEqual({ donorState: cancellationResolved[0]?.donorState, earnedAwards: Number(cancellationResolved[0]?.earnedAwards),
      transfers: Number(cancellationResolved[0]?.transfers), recipientEnrollments: Number(cancellationResolved[0]?.recipientEnrollments),
      reservedCredit: Number(cancellationResolved[0]?.reservedCredit) },
    { donorState: 'cancelled', earnedAwards: 0, transfers: 0, recipientEnrollments: 0, reservedCredit: 0 },
    "a source cancellation winning before financial settlement leaves no earned award, transfer, target enrollment, or stranded reservation");

    const failureReview = await submitPublicRegistration(browser, {
      childName: "ConditionalFailureReviewFunded", email: "conditional-failure-review@example.test", paymentPlanCode: "single", expectedInitialAmount: 1200,
      siblings: [
        { childName: "ConditionalFailureReviewCancelA", classSessionId: "browser-class-target", paymentPlanCode: "single" },
        { childName: "ConditionalFailureReviewCancelB", classSessionId: "browser-class-target", paymentPlanCode: "single" },
      ],
    });
    const [failureReviewFunded, failureReviewCancelA, failureReviewCancelB] = failureReview;
    await recordCashPayment(page, failureReviewFunded, 1080);
    await cancelAndRestoreRegistration(page, failureReviewCancelA, { restore: false });
    await cancelAndRestoreRegistration(page, failureReviewCancelB, { restore: false });
    await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(failureReviewFunded)}`);
    const failureReviewRow = page.locator(`[data-registration-child="${failureReviewFunded}"]`);
    const failureReviewForm = failureReviewRow.locator("[data-conditional-failure-deadline]");
    await failureReviewForm.waitFor({ state: "visible" });
    const failureDueInput = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
    await failureReviewForm.locator('[name="dueAt"]').fill(failureDueInput);
    await failureReviewForm.locator('[name="reason"]').fill("Browser conditional qualification review");
    const deadlineRequest = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
      && response.request().method() === "POST" && response.request().postData()?.includes("conditional-family.failure-deadline"));
    await failureReviewForm.locator('button[type="submit"]').click();
    const deadlineResponse = await deadlineRequest;
    if (!deadlineResponse.ok()) throw new Error(`conditional failure deadline failed: ${await deadlineResponse.text()}`);
    await page.locator("#tool-message").getByText("Шинэ төлбөрийн хугацааг тогтоолоо.").waitFor({ state: "visible" });
    const failureReviewState = await dbJson(`SELECT state, conditional_failure_due_at AS dueAt FROM conditional_family_discount_quote
      WHERE registration_draft_child_id = ${sql(failureReviewFunded)}`);
    assert.deepEqual(failureReviewState[0], { state: "qualification_failed", dueAt: `${failureDueInput}:00.000Z` },
      "the rendered failure-review form keeps the conditional difference out of ordinary overdue flow until staff records a specific replacement deadline");
  } else if (process.env.FAMILY_DISCOUNT_BROWSER_ONLY === "1") {
    execute(`UPDATE offering_course_pricing SET one_time_amount_mnt = 1100, first_installment_amount_mnt = 550,
      second_installment_amount_mnt = 550 WHERE activity_offering_id = 'browser-offering-high';`);
    const familyAlpha = await fillIntake(page, "FamilyAlpha", "single");
    const familyBeta = await fillIntake(page, "FamilyBeta", "two_installment", {
      stage: "stage_2", classSessionId: "browser-class-high",
    });
    await recordCashPayment(page, familyAlpha, 1000);
    await finalizeCashRegistration(page, familyAlpha);
    await recordCashPayment(page, familyBeta, 550);
    await finalizeCashRegistration(page, familyBeta);
    await confirmFamilyMembership(page, familyAlpha, familyBeta, "FamilyBeta", "Browser cross-guardian family confirmation");
    const firstResult = await dbJson(`SELECT
        (SELECT COUNT(*) FROM family_group_member WHERE family_group_id = family_group_confirmation.family_group_id AND status = 'active') AS members,
        (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)})
          AND award_type = 'family_multi_child' AND status = 'active') AS awards,
        (SELECT COALESCE(SUM(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit WHERE debit.origin_entry_id = root.id), 0) - root.reserved_amount_mnt), 0)
          FROM child_credit_entry AS root WHERE root.registration_draft_child_id = ${sql(familyAlpha)} AND root.entry_kind = 'discount_award_credit') AS alphaAvailableCredit,
        (SELECT amount_mnt FROM payment_installment WHERE registration_draft_child_id = ${sql(familyBeta)} AND installment_kind = 'later') AS betaRawLaterAmount
      FROM family_group_confirmation ORDER BY created_at DESC LIMIT 1`);
    const familyBetaProjection = await staffPaymentProjection(page, familyBeta);
    assert.deepEqual({ members: Number(firstResult[0]?.members), awards: Number(firstResult[0]?.awards), alphaAvailableCredit: Number(firstResult[0]?.alphaAvailableCredit), betaRawLaterAmount: Number(firstResult[0]?.betaRawLaterAmount), betaRemaining: Number(familyBetaProjection?.totalRemainingMnt) },
      { members: 2, awards: 2, alphaAvailableCredit: 100, betaRawLaterAmount: 550, betaRemaining: 440 },
      "rendered family confirmation creates only the fully paid child's actual 100 MNT credit and reduces the other child's later obligation to 440 MNT");
    await useFamilySuggestionFromRecipient(page, familyBeta, familyAlpha, 100);
    const afterTransferAndApplication = await dbJson(`SELECT
        (SELECT COALESCE(SUM(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit WHERE debit.origin_entry_id = root.id), 0) - root.reserved_amount_mnt), 0)
          FROM child_credit_entry AS root WHERE root.registration_draft_child_id = ${sql(familyAlpha)} AND root.amount_mnt > 0) AS alphaAvailable,
        (SELECT COALESCE(SUM(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit WHERE debit.origin_entry_id = root.id), 0) - root.reserved_amount_mnt), 0)
          FROM child_credit_entry AS root WHERE root.registration_draft_child_id = ${sql(familyBeta)} AND root.amount_mnt > 0) AS betaAvailable,
        (SELECT COALESCE(SUM(received_amount_mnt), 0) FROM received_payment WHERE payment_request_id IN (
          SELECT id FROM payment_request WHERE registration_draft_id IN (SELECT registration_draft_id FROM registration_draft_child WHERE id IN (${sql(familyAlpha)}, ${sql(familyBeta)})))) AS cashReceived`);
    const afterApplicationProjection = await staffPaymentProjection(page, familyBeta);
    assert.deepEqual({ alphaAvailable: Number(afterTransferAndApplication[0]?.alphaAvailable), betaAvailable: Number(afterTransferAndApplication[0]?.betaAvailable), betaRemaining: Number(afterApplicationProjection?.totalRemainingMnt), cashReceived: Number(afterTransferAndApplication[0]?.cashReceived) },
      { alphaAvailable: 0, betaAvailable: 0, betaRemaining: 340, cashReceived: 1550 },
      "a deliberate browser transfer and application consume exactly the family credit without changing cash receipts");
    await confirmFamilyMembership(page, familyAlpha, familyBeta, "FamilyBeta", "Browser cross-guardian family confirmation");
    const replayResult = await dbJson(`SELECT
        (SELECT COUNT(*) FROM family_group_member WHERE family_group_id = family_group_confirmation.family_group_id AND status = 'active') AS members,
        (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)})
          AND award_type = 'family_multi_child' AND status = 'active') AS awards,
        (SELECT COUNT(*) FROM child_credit_entry WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)})
          AND entry_kind = 'discount_award_credit') AS creditRoots
      FROM family_group_confirmation ORDER BY created_at DESC LIMIT 1`);
    assert.deepEqual({ members: Number(replayResult[0]?.members), awards: Number(replayResult[0]?.awards), creditRoots: Number(replayResult[0]?.creditRoots) },
      { members: 2, awards: 2, creditRoots: 1 }, "family confirmation replay cannot duplicate the award or fully paid child's credit root");
    }
  } else {
  const cashChildId = await fillIntake(page, "CashBrowser");
  await recordPartialCashPayment(page, cashChildId);
  const partialCash = await dbJson(`SELECT
    (SELECT COUNT(*) FROM received_payment WHERE payment_request_id = payment_request.id) AS receivedCount,
    (SELECT COALESCE(SUM(received_amount_mnt), 0) FROM received_payment WHERE payment_request_id = payment_request.id) AS receivedAmount,
    payment_installment.status AS installmentStatus,
    (SELECT status FROM payment_confirmation WHERE received_payment_id IN (
      SELECT id FROM received_payment WHERE payment_request_id = payment_request.id
    ) ORDER BY created_at DESC LIMIT 1) AS confirmationStatus,
    registration_draft_child.canonical_enrollment_id AS enrollmentId
    FROM registration_draft_child
    INNER JOIN payment_request ON payment_request.registration_draft_id = registration_draft_child.registration_draft_id
    INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id
      AND payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.installment_kind = 'initial'
    WHERE registration_draft_child.id = ${sql(cashChildId)}`);
  assert.equal(Number(partialCash[0].receivedCount), 1, "one cash payment is recorded through the staff payment form");
  assert.equal(Number(partialCash[0].receivedAmount), 250, "the partial cash amount is immutable and distinct from credit");
  assert.equal(partialCash[0].installmentStatus, "pending",
    "the raw installment remains pending until the normal grace-period finalizer reconciles the recorded allocation");
  assert.equal(partialCash[0].confirmationStatus, "tentative",
    "partial cash creates the normal tentative confirmation record instead of an immediate lifecycle transition");
  assert.equal(partialCash[0].enrollmentId, null, "an unchecked partial cash payment does not directly create a canonical enrollment");
  await recordPaymentSearchNote(page, cashChildId);
  const paymentSearch = await dbJson(`SELECT
    (SELECT COUNT(*) FROM payment_evidence WHERE payment_request_id = payment_request.id AND evidence_type = 'staff_checked_not_found') AS evidenceCount,
    (SELECT COUNT(*) FROM audit_event WHERE subject_id = payment_request.id AND action = 'payment_checked_not_found') AS auditCount,
    registration_draft_child.canonical_enrollment_id AS enrollmentId
    FROM registration_draft_child
    INNER JOIN payment_request ON payment_request.registration_draft_id = registration_draft_child.registration_draft_id
    WHERE registration_draft_child.id = ${sql(cashChildId)}`);
  assert.equal(Number(paymentSearch[0].evidenceCount), 1, "the payment-search action records exactly one protected evidence note");
  assert.equal(Number(paymentSearch[0].auditCount), 1, "the payment-search action records exactly one audit event");
  assert.equal(paymentSearch[0].enrollmentId, null, "the audit-only payment-search action has no lifecycle side effect");
  await verifyRegistrationExport(page, context, "CashBrowser");

  // A confirmed two-installment agreement retains an ordinary, usable cash
  // recording path for its second installment before that deadline arrives.
  const laterCashChildId = await fillIntake(page, "LaterCashBrowser");
  await recordCashPayment(page, laterCashChildId, 500);
  await finalizeCashRegistration(page, laterCashChildId);
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(laterCashChildId)}`);
  const laterCashRow = page.locator(`[data-registration-child="${laterCashChildId}"]`);
  await laterCashRow.locator('[data-payment-open]').click();
  const laterForm = laterCashRow.locator(".staff-later-payment-form[data-payment-form]");
  await laterForm.waitFor({ state: "visible" });
  await laterCashRow.locator('[data-credit-open]').click();
  assert.equal(await laterForm.count(), 0, "switching to credit closes the payment panel without changing payment state");
  await laterCashRow.locator('[data-payment-open]').click();
  await laterForm.waitFor({ state: "visible" });
  await laterCashRow.locator('[data-payment-close]').click();
  assert.equal(await laterForm.count(), 0, "the payment panel closes explicitly without collapsing the record");
  await laterCashRow.locator('[data-payment-open]').click();
  await laterForm.waitFor({ state: "visible" });
  await laterForm.getByText("Төлбөрийн нөхцөл: 2 хувааж").waitFor({ state: "visible" });
  await laterForm.getByText("Хоёр дахь төлбөрийн хугацаа:").waitFor({ state: "visible" });
  assert.equal(Number(await laterForm.locator('input[name="amount"]').inputValue()), 500,
    "the confirmed record exposes the authoritative not-yet-due second-installment balance");
  const receivedAt = await laterForm.locator('input[name="receivedAt"]').inputValue();
  await laterForm.locator('input[name="receivedAt"]').fill("");
  await laterForm.locator('button[type="submit"]').click();
  await laterForm.getByText("Орсон хугацааг зөв оруулна уу.").waitFor({ state: "visible" });
  await laterForm.locator('input[name="receivedAt"]').fill(receivedAt);
  await laterForm.locator('select[name="source"]').selectOption("staff_manual_cash");
  let failRefresh = true;
  await page.route("**/api/staff/payments", async (route) => {
    if (failRefresh && route.request().method() === "GET") {
      failRefresh = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "түр туршилтын шинэчлэлтийн алдаа" } }) });
      return;
    }
    await route.continue();
  });
  const laterRequest = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await laterForm.locator('button[type="submit"]').click();
  const laterResponse = await laterRequest;
  if (!laterResponse.ok()) throw new Error(`later cash payment failed: ${await laterResponse.text()}`);
  await laterForm.locator('[data-action-feedback]').getByText("Төлбөр бүртгэгдлээ. Жагсаалтыг шинэчилж чадсангүй").waitFor({ state: "visible" });
  const retryRequest = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await laterForm.locator('button[type="submit"]').click();
  const retryResponse = await retryRequest;
  assert.ok(retryResponse.ok(), "an ambiguous retry of the same later-payment operation is accepted");
  assert.equal((await retryResponse.json()).idempotent, true, "the retry resolves the original receipt rather than creating another");
  await page.unroute("**/api/staff/payments");
  const laterCashState = await dbJson(`SELECT
    (SELECT COUNT(*) FROM received_payment WHERE payment_request_id = payment_request.id) AS receivedCount,
    (SELECT COUNT(*) FROM payment_allocation
      INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
      WHERE payment_allocation.received_payment_id IN (SELECT id FROM received_payment WHERE payment_request_id = payment_request.id)
        AND payment_installment.installment_kind = 'initial') AS initialAllocations,
    (SELECT COUNT(*) FROM payment_allocation
      INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
      WHERE payment_allocation.received_payment_id IN (SELECT id FROM received_payment WHERE payment_request_id = payment_request.id)
        AND payment_installment.installment_kind = 'later') AS laterAllocations,
    (SELECT COALESCE(SUM(received_amount_mnt), 0) FROM received_payment WHERE payment_request_id = payment_request.id) AS receivedAmount,
    registration_draft_child.canonical_enrollment_id AS enrollmentId,
    (SELECT COUNT(*) FROM registration_capacity_hold WHERE registration_draft_child_id = registration_draft_child.id AND status = 'active') AS activeHolds
    FROM registration_draft_child
    INNER JOIN payment_request ON payment_request.registration_draft_id = registration_draft_child.registration_draft_id
    WHERE registration_draft_child.id = ${sql(laterCashChildId)}`);
  assert.equal(Number(laterCashState[0].receivedCount), 2, "two cash receipts exist after the second installment and retry");
  assert.equal(Number(laterCashState[0].initialAllocations), 1, "the original first-installment allocation remains immutable");
  assert.equal(Number(laterCashState[0].laterAllocations), 1, "the second receipt is allocated once to the later installment");
  assert.equal(Number(laterCashState[0].receivedAmount), 1000, "cash receipts settle the two raw installments without fabricated credit");
  assert.ok(laterCashState[0].enrollmentId, "later cash collection does not change the confirmed enrollment identity");
  assert.equal(Number(laterCashState[0].activeHolds), 0, "later cash collection does not create another capacity hold");
  await finalizeCashRegistration(page, laterCashChildId);
  const settledSourceRow = page.locator(`[data-registration-child="${laterCashChildId}"]`);
  await settledSourceRow.locator('[data-additional-class-open]').click();
  const laterCashPreview = settledSourceRow.locator('[data-additional-class-preview]');
  await laterCashPreview.waitFor({ state: "visible" });
  await laterCashPreview.locator('select[name="targetClassSessionId"]').selectOption("browser-class-target");
  await laterCashPreview.locator('select[name="paymentPlanCode"]').selectOption("single");
  await laterCashPreview.locator('button[type="submit"]').click();
  await laterCashPreview.locator('input[name="parentAcknowledged"]').check();
  await laterCashPreview.locator('input[name="childAcknowledged"]').check();
  await laterCashPreview.locator('[data-additional-class-create]').click();
  const laterCashAdmission = await dbJson(`SELECT target_registration_draft_child_id AS targetChildId
    FROM additional_class_admission WHERE source_registration_draft_child_id = ${sql(laterCashChildId)}
      AND status = 'pending_confirmation' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(laterCashAdmission.length, 1, "the fully cash-settled source can create a pending discounted one-payment target");
  await recordCashPayment(page, laterCashAdmission[0].targetChildId, 800);
  await finalizeCashRegistration(page, laterCashAdmission[0].targetChildId);
  const laterCashAward = await dbJson(`SELECT
    additional_class_admission.status AS admissionStatus,
    (SELECT COUNT(*) FROM child_credit_entry WHERE source_discount_award_id = (
      SELECT id FROM discount_award WHERE registration_draft_child_id = ${sql(laterCashChildId)}
        AND status = 'active' LIMIT 1
    ) AND entry_kind = 'discount_award_credit') AS sourceAwardCreditEntries,
    (SELECT amount_mnt FROM child_credit_entry WHERE source_discount_award_id = (
      SELECT id FROM discount_award WHERE registration_draft_child_id = ${sql(laterCashChildId)}
        AND status = 'active' LIMIT 1
    ) AND entry_kind = 'discount_award_credit' LIMIT 1) AS sourceAwardCreditMnt
    FROM additional_class_admission
    WHERE target_registration_draft_child_id = ${sql(laterCashAdmission[0].targetChildId)}`);
  assert.equal(laterCashAward[0]?.admissionStatus, "confirmed", "the discounted one-payment target confirms through ordinary finalization");
  assert.equal(Number(laterCashAward[0]?.sourceAwardCreditEntries), 1, "the fully paid cash source receives one linked award credit");
  assert.equal(Number(laterCashAward[0]?.sourceAwardCreditMnt), 100, "the source award credit uses the configured 10% policy");

  // A released two-installment agreement's first installment is deliberately
  // cash-only. Use a one-payment agreement here to exercise the separate,
  // supported credit-only initial-settlement path.
  const childId = await fillIntake(page, "CreditBrowser", "single");
  assert.ok(childId, "staff intake returns a normal registration anchor");
  const freshRow = page.locator(`[data-registration-child="${childId}"]`);
  await freshRow.waitFor({ state: "visible" });
  const openControl = freshRow.locator('button[data-payment-detail][aria-expanded="true"]');
  if (await openControl.count()) await openControl.click();
  const summary = freshRow.locator('[data-payment-detail][role="button"]');
  await summary.click();
  await freshRow.locator('[data-credit-open]').waitFor({ state: "visible" });
  await freshRow.getByText("Утас: 99112233, 00112233").waitFor({ state: "visible" });
  await freshRow.getByText("Facebook: Browser guardian CreditBrowser").waitFor({ state: "visible" });
  await freshRow.locator('[data-credit-open]').last().click();
  await freshRow.locator('[data-credit-subpanel-name="add"]').waitFor({ state: "visible" });
  assert.equal(await freshRow.locator('[data-child-credit-form]:visible').count(), 0, "credit subpanels start closed on a fresh opening");
  await freshRow.locator('[data-credit-close]').click();
  assert.equal(await freshRow.locator('.staff-credit-summary').count(), 0, "credit panel has an explicit close control even before an inner form opens");
  assert.equal(await freshRow.locator('.staff-payment-detail:visible').count(), 1, "closing credit leaves the selected record open");
  await freshRow.locator('[data-credit-open]').last().click();
  await freshRow.locator('[data-credit-subpanel-name="add"]').click();
  assert.equal(await freshRow.locator('[data-child-credit-form="manual-add"]:visible').count(), 1, "new-credit opens its form directly");
  await freshRow.locator('[data-credit-subpanel-name="add"]').click();
  assert.equal(await freshRow.locator('[data-child-credit-form]:visible').count(), 0, "direct credit actions close their own shared inner panel");

  await addCredit(page, childId, 1000);
  await applyCredit(page, childId, 1000);
  const prePromotion = await dbJson(`SELECT canonical_student_id AS canonicalStudentId FROM registration_draft_child WHERE id = ${sql(childId)}`);
  assert.equal(prePromotion[0].canonicalStudentId, null, "credit-only initial settlement remains a normal pending draft until finalization");
  const cash = await dbJson(`SELECT COUNT(*) AS count FROM received_payment WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(childId)}))`);
  assert.equal(Number(cash[0].count), 0, "credit application does not fabricate a received cash payment");

  execute(`UPDATE credit_application_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z' WHERE registration_draft_child_id = ${sql(childId)};`);
  const beforeScheduled = await dbJson(`SELECT status, finalize_after AS finalizeAfter FROM credit_application_confirmation WHERE registration_draft_child_id = ${sql(childId)}`);
  assert.equal(beforeScheduled[0]?.status, "tentative", `the credit confirmation exists in the same disposable D1 before scheduling: ${JSON.stringify(beforeScheduled)}`);
  const scheduled = await fetch(`${baseUrl}/__scheduled`);
  const scheduledBody = await scheduled.text();
  assert.ok(scheduled.ok, `the actual local scheduled Worker accepts the deterministic fixture trigger: ${scheduledBody}`);
  const creditConfirmation = await waitForDb(`SELECT status, finalize_after AS finalizeAfter FROM credit_application_confirmation WHERE registration_draft_child_id = ${sql(childId)}`,
    (rows) => rows[0]?.status === "finalized", "the actual local scheduled Worker finalizes the credit confirmation");
  assert.equal(creditConfirmation[0]?.status, "finalized", `the actual local scheduled Worker finalizes the credit confirmation: ${JSON.stringify(creditConfirmation)}`);
  await page.reload();
  const afterFinalizer = await dbJson(`SELECT canonical_student_id AS canonicalStudentId, canonical_enrollment_id AS enrollmentId, status, promotion_status AS promotionStatus, identity_resolution_status AS identityStatus FROM registration_draft_child WHERE id = ${sql(childId)}`);
  const createIdentity = page.locator(`[data-promotion-new="${childId}"]`);
  if (!afterFinalizer[0]?.enrollmentId) {
    await createIdentity.waitFor({ state: "visible" });
    page.once("dialog", (dialog) => dialog.accept());
    await createIdentity.click();
  }
  assert.ok(afterFinalizer[0]?.enrollmentId, `credit finalization must produce a canonical enrollment: ${JSON.stringify(afterFinalizer)}`);
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  await page.getByRole("button", { name: /Төлбөр баталгаажсан/ }).waitFor({ state: "visible", timeout: 5_000 });
  await page.locator(`[data-registration-child="${childId}"]`).getByText("Кредитээр тооцсон: 1,000 ₮").waitFor({ state: "visible", timeout: 5_000 });
  const actionOrder = await page.locator(`[data-registration-child="${childId}"] .staff-panel-actions[aria-label="Бүртгэлийн үйлдэл"]`).textContent();
  const availableActions = ["Мэдээлэл", "Төлбөр", "Кредит", "Шилжих", "Анги нэмэх"]
    .filter((label) => actionOrder.includes(label));
  assert.deepEqual(availableActions, [...availableActions].sort((left, right) => actionOrder.indexOf(left) - actionOrder.indexOf(right)),
    "available outer actions use the staff workflow order");
  const promoted = await dbJson(`SELECT canonical_student_id AS canonicalStudentId, canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE id = ${sql(childId)}`);
  assert.ok(promoted[0].canonicalStudentId && promoted[0].enrollmentId, "normal finalization promotes the credit-settled draft");
  const ledger = await dbJson(`SELECT COUNT(*) AS entries, COUNT(DISTINCT operation_id) AS operations FROM child_credit_entry WHERE registration_draft_child_id = ${sql(childId)} AND canonical_student_id = ${sql(promoted[0].canonicalStudentId)}`);
  assert.equal(Number(ledger[0].entries), 2, "the pre-promotion credit root and application survive canonical promotion exactly once");
  assert.equal(Number(ledger[0].operations), 2, "operation identity survives canonical promotion");

  // A subsequent pending additional admission shares the same canonical
  // credit ledger. Applying only part of it to the target must not mint a
  // second balance, and cancelling that pending target must leave the unused
  // balance available from the still-active source record.
  await addCredit(page, childId, 200);
  await correctCredit(page, childId, -50);
  const sourceRow = page.locator(`[data-registration-child="${childId}"]`);
  if (await sourceRow.locator('[data-additional-class-open]').count() === 0) await sourceRow.locator('button[data-payment-detail]').click();
  await sourceRow.locator('[data-additional-class-open]').click();
  const additional = sourceRow.locator('[data-additional-class-preview]');
  await additional.waitFor({ state: "visible" });
  await additional.locator('select[name="targetClassSessionId"]').selectOption("browser-class-target");
  await additional.locator('select[name="paymentPlanCode"]').selectOption("two_installment");
  await additional.locator('button[type="submit"]').click();
  await additional.locator('input[name="parentAcknowledged"]').check();
  await additional.locator('input[name="childAcknowledged"]').check();
  await additional.locator('[data-additional-class-create]').click();
  await page.locator('[data-registration-child]').filter({ hasText: "Browser CreditBrowser" }).last().waitFor({ state: "visible" });
  const admission = await dbJson(`SELECT target_registration_draft_child_id AS targetChildId, status FROM additional_class_admission WHERE source_registration_draft_child_id = ${sql(childId)}`);
  assert.equal(admission.length, 1, "one pending additional admission is created through the rendered staff flow");
  assert.equal(admission[0].status, "pending_confirmation", "the added class is pending and has no direct canonical enrollment");
  const targetChildId = admission[0].targetChildId;
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(targetChildId)}`);
  const targetRow = page.locator(`[data-registration-child="${targetChildId}"]`);
  await targetRow.waitFor({ state: "visible" });
  await targetRow.getByText("Кредит: 150 ₮").waitFor({ state: "visible" });
  const targetOwnership = await dbJson(`SELECT registration_draft_child.canonical_student_id AS childStudentId,
    additional_class_admission.canonical_student_id AS admissionStudentId
    FROM registration_draft_child LEFT JOIN additional_class_admission
      ON additional_class_admission.target_registration_draft_child_id = registration_draft_child.id
    WHERE registration_draft_child.id = ${sql(targetChildId)}`);
  assert.equal(targetOwnership[0].childStudentId, promoted[0].canonicalStudentId, "pending additional admission is bound to the existing canonical child before credit application");
  await applyCredit(page, targetChildId, 100);
  const afterTargetApply = await dbJson(`SELECT
    (SELECT COUNT(*) FROM child_credit_entry WHERE canonical_student_id = ${sql(promoted[0].canonicalStudentId)} AND entry_kind = 'manual_addition') AS roots,
    (SELECT COALESCE(SUM(amount_mnt), 0) FROM child_credit_entry WHERE canonical_student_id = ${sql(promoted[0].canonicalStudentId)}) AS netAmount`);
  assert.equal(Number(afterTargetApply[0].roots), 2, "target application reuses the source-owned ledger instead of creating a duplicate credit root");
  assert.equal(Number(afterTargetApply[0].netAmount), 50, "a signed correction and partial target application leave the authoritative unused balance");
  await targetRow.locator("details.staff-payment-release summary").click();
  await targetRow.locator('[data-registration-cancel-form] button[type="submit"]').click();
  const cancellationDialog = page.locator("#registration-cancel-dialog");
  await cancellationDialog.waitFor({ state: "visible" });
  await cancellationDialog.locator('[data-registration-cancel-confirm]').click();
  await page.getByText("Бүртгэл цуцлагдлаа.").waitFor({ state: "visible" });
  const cancelledTarget = await dbJson(`SELECT status, canonical_enrollment_id AS enrollmentId FROM registration_draft_child WHERE id = ${sql(targetChildId)}`);
  assert.equal(cancelledTarget[0].status, "cancelled", "pending additional target cancellation uses the existing guarded lifecycle");
  assert.equal(cancelledTarget[0].enrollmentId, null, "cancelling the pending target never creates a canonical enrollment");
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  const sourceAfterCancel = page.locator(`[data-registration-child="${childId}"]`);
  await sourceAfterCancel.getByText("Кредит: 50 ₮").waitFor({ state: "visible" });

  // A terminal target never owns or consumes the source child's remaining
  // credit. Simulate the normal expired-draft boundary in this disposable D1
  // fixture after creating the target through the real rendered staff flow.
  await sourceAfterCancel.locator('[data-additional-class-open]').click();
  const expiringPreview = sourceAfterCancel.locator('[data-additional-class-preview]');
  await expiringPreview.waitFor({ state: "visible" });
  await expiringPreview.locator('select[name="targetClassSessionId"]').selectOption("browser-class-target");
  await expiringPreview.locator('select[name="paymentPlanCode"]').selectOption("two_installment");
  await expiringPreview.locator('button[type="submit"]').click();
  await expiringPreview.locator('input[name="parentAcknowledged"]').check();
  await expiringPreview.locator('input[name="childAcknowledged"]').check();
  await expiringPreview.locator('[data-additional-class-create]').click();
  const expiringTarget = await dbJson(`SELECT target_registration_draft_child_id AS targetChildId FROM additional_class_admission
    WHERE source_registration_draft_child_id = ${sql(childId)} AND status = 'pending_confirmation' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(expiringTarget.length, 1, "a later pending additional target is created through the rendered staff flow");
  execute(`UPDATE registration_draft SET status = 'expired' WHERE id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(expiringTarget[0].targetChildId)});`);
  const expiryRecovery = await page.evaluate(async (draftChildId) => (await fetch("/api/staff/payments", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "additional-class.retry-confirmation", registrationDraftChildId: draftChildId }),
  })).status, expiringTarget[0].targetChildId);
  assert.equal(expiryRecovery, 200, "the normal retry endpoint resolves an expired target");
  assert.equal((await dbJson(`SELECT status FROM additional_class_admission WHERE target_registration_draft_child_id = ${sql(expiringTarget[0].targetChildId)}`))[0]?.status, "expired",
    "an expired target no longer blocks unrelated source actions");
  const sourceCreditAfterExpiry = await dbJson(`SELECT COALESCE(SUM(amount_mnt), 0) AS netAmount FROM child_credit_entry
    WHERE canonical_student_id = ${sql(promoted[0].canonicalStudentId)}`);
  assert.equal(Number(sourceCreditAfterExpiry[0].netAmount), 50,
    "expiry of a pending added class preserves the source child's unused credit");
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  await page.locator(`[data-registration-child="${childId}"]`).getByText("Кредит: 50 ₮").waitFor({ state: "visible" });

  // A fully settled source can select an independent one-payment target. The
  // rendered payment form must subtract only its durable contingent credit;
  // the credit remains unapplied until the fenced finalizer settles it.
  const onePaymentSource = await fillIntake(page, "OnePaymentAdditionalBrowser", "single");
  await addCredit(page, onePaymentSource, 1000);
  await applyCredit(page, onePaymentSource, 1000);
  await finalizeCreditOnlyRegistration(page, onePaymentSource);
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(onePaymentSource)}`);
  const onePaymentSourceRow = page.locator(`[data-registration-child="${onePaymentSource}"]`);
  await onePaymentSourceRow.locator('[data-additional-class-open]').click();
  const onePaymentPreview = onePaymentSourceRow.locator('[data-additional-class-preview]');
  await onePaymentPreview.waitFor({ state: "visible" });
  await onePaymentPreview.locator('select[name="targetClassSessionId"]').selectOption("browser-class-target");
  await onePaymentPreview.locator('select[name="paymentPlanCode"]').selectOption("single");
  await onePaymentPreview.locator('button[type="submit"]').click();
  await onePaymentPreview.locator("strong").getByText("Нэг удаа төлөх", { exact: true }).waitFor({ state: "visible" });
  await onePaymentPreview.locator('input[name="parentAcknowledged"]').check();
  await onePaymentPreview.locator('input[name="childAcknowledged"]').check();
  await onePaymentPreview.locator('[data-additional-class-create]').click();
  const onePaymentAdmission = await dbJson(`SELECT target_registration_draft_child_id AS targetChildId, status
    FROM additional_class_admission
    WHERE source_registration_draft_child_id = ${sql(onePaymentSource)}
      AND status = 'pending_confirmation'
    ORDER BY created_at DESC LIMIT 1`);
  assert.equal(onePaymentAdmission.length, 1, "the rendered one-payment target creates one pending admission");
  const onePaymentTargetId = onePaymentAdmission[0].targetChildId;
  const onePaymentReservation = await dbJson(`SELECT proposed_source_award_credit_mnt AS proposedSourceAwardCreditMnt,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM additional_class_credit_reservation
        WHERE admission_id = additional_class_admission.id AND status = 'pending') AS reservedCreditMnt
    FROM additional_class_admission WHERE target_registration_draft_child_id = ${sql(onePaymentTargetId)}`);
  assert.deepEqual({ proposed: Number(onePaymentReservation[0]?.proposedSourceAwardCreditMnt), reserved: Number(onePaymentReservation[0]?.reservedCreditMnt) },
    { proposed: 100, reserved: 100 }, "the explicit add-class proposal persists its contingent source-award reservation before cash collection");
  await recordCashPayment(page, onePaymentTargetId, 800);
  const beforeReservedSettlement = await dbJson(`SELECT
      registration_draft_child.canonical_enrollment_id AS targetEnrollmentId,
      payment_installment.status AS installmentStatus,
      COALESCE((SELECT SUM(amount_mnt) FROM additional_class_credit_reservation
        WHERE admission_id = additional_class_admission.id AND status = 'pending'), 0) AS pendingReservationMnt,
      COALESCE((SELECT SUM(-amount_mnt) FROM child_credit_entry
        WHERE payment_installment_id = payment_installment.id AND entry_kind = 'credit_application'), 0) AS appliedCreditMnt
    FROM additional_class_admission
    INNER JOIN registration_draft_child ON registration_draft_child.id = additional_class_admission.target_registration_draft_child_id
    INNER JOIN payment_installment ON payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.installment_kind = 'initial'
    WHERE additional_class_admission.target_registration_draft_child_id = ${sql(onePaymentTargetId)}`);
  assert.equal(beforeReservedSettlement[0]?.targetEnrollmentId, null,
    "recording the reduced cash receipt does not independently promote the target");
  assert.equal(beforeReservedSettlement[0]?.installmentStatus, "pending",
    "the reservation does not make the installment paid before protected settlement");
  assert.equal(Number(beforeReservedSettlement[0]?.pendingReservationMnt), 100,
    "the source award remains a pending reservation before the finalizer owns it");
  assert.equal(Number(beforeReservedSettlement[0]?.appliedCreditMnt), 0,
    "the contingent credit is not prematurely written as an application");
  execute(`UPDATE payment_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z'
    WHERE received_payment_id IN (
      SELECT received_payment.id FROM received_payment
      INNER JOIN payment_request ON payment_request.id = received_payment.payment_request_id
      WHERE payment_request.registration_draft_id = (
        SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(onePaymentTargetId)}
      )
    );`);
  const onePaymentScheduled = await fetch(`${baseUrl}/__scheduled`);
  assert.ok(onePaymentScheduled.ok, "the normal scheduled finalizer handles the one-payment additional target");
  const onePaymentResult = await dbJson(`SELECT
      additional_class_admission.status AS admissionStatus,
      registration_draft_child.canonical_enrollment_id AS targetEnrollmentId,
      (SELECT COUNT(*) FROM discount_award
        WHERE registration_draft_child_id = ${sql(onePaymentSource)} AND status = 'active') AS sourceAwards,
      (SELECT COUNT(*) FROM child_credit_entry
        WHERE source_discount_award_id = (
          SELECT id FROM discount_award WHERE registration_draft_child_id = ${sql(onePaymentSource)}
            AND status = 'active' LIMIT 1
        ) AND entry_kind = 'discount_award_credit') AS sourceAwardCreditEntries,
      (SELECT amount_mnt FROM child_credit_entry
        WHERE source_discount_award_id = (
          SELECT id FROM discount_award WHERE registration_draft_child_id = ${sql(onePaymentSource)}
            AND status = 'active' LIMIT 1
      ) AND entry_kind = 'discount_award_credit' LIMIT 1) AS sourceAwardCreditMnt,
      (SELECT COALESCE(SUM(allocated_amount_mnt), 0) FROM payment_allocation
        INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id = ${sql(onePaymentTargetId)}) AS targetCashMnt,
      (SELECT COALESCE(SUM(-amount_mnt), 0) FROM child_credit_entry
        WHERE registration_draft_child_id = ${sql(onePaymentTargetId)} AND entry_kind = 'credit_application') AS targetCreditAppliedMnt,
      (SELECT COUNT(*) FROM additional_class_credit_reservation
        WHERE admission_id = additional_class_admission.id AND status = 'pending') AS pendingReservationCount
    FROM additional_class_admission
    INNER JOIN registration_draft_child
      ON registration_draft_child.id = additional_class_admission.target_registration_draft_child_id
    WHERE additional_class_admission.target_registration_draft_child_id = ${sql(onePaymentTargetId)}`);
  assert.equal(onePaymentResult[0]?.admissionStatus, "confirmed", "the paid one-payment admission completes normally");
  assert.ok(onePaymentResult[0]?.targetEnrollmentId, "the one-payment target receives exactly one canonical enrollment");
  assert.equal(Number(onePaymentResult[0]?.sourceAwards), 1, "confirmation activates the missing source base award once");
  assert.equal(Number(onePaymentResult[0]?.sourceAwardCreditEntries), 1, "the fully paid source receives one linked credit root");
  assert.equal(Number(onePaymentResult[0]?.sourceAwardCreditMnt), 100, "the linked source credit equals its configured 10% award");
  assert.equal(Number(onePaymentResult[0]?.targetCashMnt), 800, "the actual receipt remains the reduced cash amount");
  assert.equal(Number(onePaymentResult[0]?.targetCreditAppliedMnt), 100, "the fenced finalizer applies exactly the reserved source credit");
  assert.equal(Number(onePaymentResult[0]?.pendingReservationCount), 0, "successful settlement consumes the reservation exactly once");
  const sharedReferral = await dbJson(`SELECT enrollment_referral_code.code AS code
    FROM enrollment_referral_code
    INNER JOIN registration_draft_child AS source ON source.canonical_enrollment_id = enrollment_referral_code.enrollment_id
    WHERE source.id = ${sql(onePaymentSource)} AND enrollment_referral_code.status = 'active'`);
  const childReferralCount = await dbJson(`SELECT COUNT(*) AS count
    FROM enrollment_referral_code
    WHERE student_id = (SELECT canonical_student_id FROM registration_draft_child WHERE id = ${sql(onePaymentSource)})
      AND status = 'active'`);
  assert.equal(Number(childReferralCount[0]?.count), 1,
    "an additional confirmed class reuses the child's active referral identity instead of minting a second code");
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(onePaymentTargetId)}`);
  await page.locator(`[data-registration-child="${onePaymentTargetId}"]`).getByText(sharedReferral[0].code).waitFor({ state: "visible" });

  // Cross-guardian family qualification is a rendered staff workflow. It
  // retains separate students, cash receipts, and child-credit roots while
  // awarding each fully-paid agreement from its own immutable price snapshot.
  const familyAlpha = await fillIntake(page, "FamilyAlpha", "single");
  const familyBeta = await fillIntake(page, "FamilyBeta", "single");
  await recordCashPayment(page, familyAlpha, 1000);
  await finalizeCashRegistration(page, familyAlpha);
  await recordCashPayment(page, familyBeta, 1000);
  await finalizeCashRegistration(page, familyBeta);
  await confirmFamilyMembership(page, familyAlpha, familyBeta, "FamilyBeta", "Browser cross-guardian family confirmation");
  const familyFirstResult = await dbJson(`SELECT
      (SELECT COUNT(*) FROM family_group_member WHERE family_group_id = family_group_confirmation.family_group_id AND status = 'active') AS members,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)})
        AND award_type = 'family_multi_child' AND status = 'active') AS awards,
      (SELECT COALESCE(SUM(amount_mnt), 0) FROM child_credit_entry WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)})
        AND entry_kind = 'discount_award_credit') AS residualCredit
    FROM family_group_confirmation ORDER BY created_at DESC LIMIT 1`);
  assert.equal(Number(familyFirstResult[0]?.members), 2, "rendered family confirmation persists two separate active members");
  assert.equal(Number(familyFirstResult[0]?.awards), 2, "each independently paid agreement receives one non-stacking family award");
  assert.equal(Number(familyFirstResult[0]?.residualCredit), 200, "fully paid agreements retain two separate 10% residual credit roots");
  const familyGamma = await fillIntake(page, "FamilyGamma", "single");
  await recordCashPayment(page, familyGamma, 1000);
  await finalizeCashRegistration(page, familyGamma);
  await confirmFamilyMembership(page, familyAlpha, familyGamma, "FamilyGamma", "Browser third family member confirmation");
  const familyThirdResult = await dbJson(`SELECT
      (SELECT COUNT(*) FROM family_group_member WHERE family_group_id = family_group_confirmation.family_group_id AND status = 'active') AS members,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)}, ${sql(familyGamma)})
        AND award_type = 'family_multi_child' AND status = 'active') AS awards,
      (SELECT COUNT(DISTINCT canonical_student_id) FROM child_credit_entry WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)}, ${sql(familyGamma)})
        AND entry_kind = 'discount_award_credit') AS creditOwners
    FROM family_group_confirmation ORDER BY created_at DESC LIMIT 1`);
  assert.equal(Number(familyThirdResult[0]?.members), 3, "adding a third child reuses the existing family group");
  assert.equal(Number(familyThirdResult[0]?.awards), 3, "repeated group activation creates no duplicate family-award value");
  assert.equal(Number(familyThirdResult[0]?.creditOwners), 3, "family membership never pools sibling credit ownership");
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(familyAlpha)}`);
  const replayRow = page.locator(`[data-registration-child="${familyAlpha}"]`);
  await replayRow.locator("[data-family-discount-open]").click();
  const replayPicker = replayRow.locator("[data-family-discount-select]");
  await replayPicker.waitFor({ state: "visible" });
  assert.equal(await replayPicker.locator(`option[value="${familyGamma}"]`).count(), 0,
    "an existing family member is not offered again for a duplicate rendered confirmation");
  const familyReplayResult = await dbJson(`SELECT
      (SELECT COUNT(*) FROM family_group_member WHERE family_group_id = family_group_confirmation.family_group_id AND status = 'active') AS members,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)}, ${sql(familyGamma)})
        AND award_type = 'family_multi_child' AND status = 'active') AS awards
    FROM family_group_confirmation ORDER BY created_at DESC LIMIT 1`);
  assert.equal(Number(familyReplayResult[0]?.members), 3, "a deliberate repeated confirmation does not duplicate active membership");
  assert.equal(Number(familyReplayResult[0]?.awards), 3, "reopening the family picker creates no additional discount value");

  const sourceCapacityBeforeTransfer = await dbJson(`SELECT COUNT(*) AS reserved FROM registration_capacity_hold
    WHERE class_session_id = 'browser-class-target' AND status = 'active'`);
  await openAndAbandonTransfer(page, childId);
  const closedTransfer = await dbJson(`SELECT status, source_enrollment_id AS sourceEnrollmentId,
    target_class_session_id AS targetClassId FROM class_transfer
    WHERE source_enrollment_id = (SELECT canonical_enrollment_id FROM registration_draft_child WHERE id = ${sql(childId)})
    ORDER BY created_at DESC LIMIT 1`);
  assert.equal(closedTransfer[0]?.status, "closed", "the rendered transfer workflow records an explicit abandonment");
  assert.ok(closedTransfer[0]?.sourceEnrollmentId, "transfer abandonment remains bound to the selected source enrollment");
  assert.equal(closedTransfer[0]?.targetClassId, "browser-class-target", "transfer preview retains the chosen authoritative target");
  const sourceCapacityAfterTransfer = await dbJson(`SELECT COUNT(*) AS reserved FROM registration_capacity_hold
    WHERE class_session_id = 'browser-class-target' AND status = 'active'`);
  assert.equal(Number(sourceCapacityAfterTransfer[0].reserved), Number(sourceCapacityBeforeTransfer[0].reserved),
    "closing the transfer releases only its target reservation");

  // The action strip is mutually exclusive even under rapid mobile switching.
  const row = page.locator(`[data-registration-child="${childId}"]`);
  await row.locator('[data-transfer-open]').click();
  await row.locator('[data-credit-open]').last().click();
  await row.locator('[data-registration-view]').click();
  await expectSingleVisiblePanel(row);
  await row.locator('button[data-payment-detail]').click();
  await row.locator('[data-payment-detail][role="button"]').click();
  await row.locator('[data-credit-open]').last().click();
  await expectSingleVisiblePanel(row);

  const restoreChildId = await fillIntake(page, "RestoreBrowser", "single");
  await addCredit(page, restoreChildId, 1000);
  await applyCredit(page, restoreChildId, 1000);
  await finalizeCreditOnlyRegistration(page, restoreChildId);
  await cancelAndRestoreRegistration(page, restoreChildId);

  const higherTransferChildId = await fillIntake(page, "HigherTransferBrowser", "single");
  await addCredit(page, higherTransferChildId, 1000);
  await applyCredit(page, higherTransferChildId, 1000);
  await finalizeCreditOnlyRegistration(page, higherTransferChildId);
  const higherSourceEnrollmentId = (await dbJson(`SELECT canonical_enrollment_id AS enrollmentId
    FROM registration_draft_child WHERE id = ${sql(higherTransferChildId)}`))[0]?.enrollmentId;
  assert.ok(higherSourceEnrollmentId, "the higher-price source has a canonical enrollment before transfer");
  await completeTransfer(page, higherTransferChildId, "browser-class-high", 200);
  const higherTransfer = await dbJson(`SELECT class_transfer.status, class_transfer.required_difference_mnt AS differenceMnt,
      (SELECT COUNT(*) FROM enrollment WHERE class_session_id = 'browser-class-source' AND transferred_out_at IS NOT NULL) AS sourceSuperseded,
      (SELECT COUNT(*) FROM enrollment WHERE class_session_id = 'browser-class-high' AND status = 'confirmed' AND transferred_out_at IS NULL) AS currentTarget,
      (SELECT COUNT(*) FROM class_transfer_payment WHERE class_transfer_payment_obligation_id IN (
        SELECT id FROM class_transfer_payment_obligation WHERE class_transfer_id = class_transfer.id
      )) AS differencePayments
    FROM class_transfer WHERE source_enrollment_id = ${sql(higherSourceEnrollmentId)} ORDER BY created_at DESC LIMIT 1`);
  assert.equal(higherTransfer[0]?.status, "completed", "higher-price transfer completes through the rendered staff flow");
  assert.equal(Number(higherTransfer[0]?.differenceMnt), 200, "higher-price transfer preserves its authoritative price difference");
  assert.equal(Number(higherTransfer[0]?.sourceSuperseded), 1, "higher-price completion supersedes exactly one source enrollment");
  assert.equal(Number(higherTransfer[0]?.currentTarget), 1, "higher-price completion leaves exactly one current target enrollment");
  assert.equal(Number(higherTransfer[0]?.differencePayments), 1, "higher-price settlement records one immutable difference payment");

  const lowerTransferChildId = await fillIntake(page, "LowerTransferBrowser", "single");
  await addCredit(page, lowerTransferChildId, 1000);
  await applyCredit(page, lowerTransferChildId, 1000);
  await finalizeCreditOnlyRegistration(page, lowerTransferChildId);
  const lowerSourceEnrollmentId = (await dbJson(`SELECT canonical_enrollment_id AS enrollmentId
    FROM registration_draft_child WHERE id = ${sql(lowerTransferChildId)}`))[0]?.enrollmentId;
  assert.ok(lowerSourceEnrollmentId, "the lower-price source has a canonical enrollment before transfer");
  await completeTransfer(page, lowerTransferChildId, "browser-class-low", 0);
  const lowerTransfer = await dbJson(`SELECT class_transfer.status, class_transfer.resulting_credit_mnt AS creditMnt,
      (SELECT COUNT(*) FROM enrollment WHERE class_session_id = 'browser-class-source' AND transferred_out_at IS NOT NULL) AS sourceSuperseded,
      (SELECT COUNT(*) FROM enrollment WHERE class_session_id = 'browser-class-low' AND status = 'confirmed' AND transferred_out_at IS NULL) AS currentTarget,
      (SELECT COUNT(*) FROM class_transfer_credit WHERE class_transfer_id = class_transfer.id AND available_amount_mnt = class_transfer.resulting_credit_mnt) AS credits
    FROM class_transfer WHERE source_enrollment_id = ${sql(lowerSourceEnrollmentId)} ORDER BY created_at DESC LIMIT 1`);
  assert.equal(lowerTransfer[0]?.status, "completed", "lower-price transfer completes through the rendered staff flow");
  assert.equal(Number(lowerTransfer[0]?.creditMnt), 200, "lower-price transfer creates its authoritative credit difference");
  assert.equal(Number(lowerTransfer[0]?.sourceSuperseded), 2, "each completed transfer supersedes only its own source enrollment");
  assert.equal(Number(lowerTransfer[0]?.currentTarget), 1, "lower-price completion leaves exactly one current target enrollment");
  assert.equal(Number(lowerTransfer[0]?.credits), 1, "lower-price completion records one durable available credit");

  const acceptedOffer = await exerciseWaitlistResponse(browser, "BrowserWaitlistAccept", "accept");
  const acceptedState = await dbJson(`SELECT waitlist_seat_offer.status AS offerStatus,
      registration_draft_waitlist_entry.status AS entryStatus,
      (SELECT COUNT(*) FROM registration_capacity_hold WHERE registration_draft_child_id = ${sql(acceptedOffer.childId)} AND status = 'active') AS holds,
      (SELECT COUNT(*) FROM payment_request WHERE registration_draft_id = ${sql(acceptedOffer.draftId)}) AS requests,
      (SELECT COUNT(*) FROM enrollment WHERE id = ${sql(`${acceptedOffer.childId}:enrollment`)}) AS enrollments
    FROM waitlist_seat_offer INNER JOIN registration_draft_waitlist_entry
      ON registration_draft_waitlist_entry.id = waitlist_seat_offer.waitlist_entry_id
    WHERE waitlist_seat_offer.id = ${sql(acceptedOffer.offerId)}`);
  assert.equal(acceptedState[0]?.offerStatus, "converted", "public waitlist acceptance converts the exact active offer");
  assert.equal(Number(acceptedState[0]?.holds), 1, "accepted offer converts capacity into one ordinary initial-payment hold");
  assert.equal(Number(acceptedState[0]?.requests), 1, "accepted offer creates one authoritative payment request");
  assert.equal(Number(acceptedState[0]?.enrollments), 0, "waitlist acceptance does not bypass ordinary payment confirmation into enrollment");

  const declinedOffer = await exerciseWaitlistResponse(browser, "BrowserWaitlistDecline", "decline");
  const declinedState = await dbJson(`SELECT waitlist_seat_offer.status AS offerStatus,
      registration_draft_waitlist_entry.status AS entryStatus,
      (SELECT COUNT(*) FROM registration_capacity_hold WHERE registration_draft_child_id = ${sql(declinedOffer.childId)} AND status = 'active') AS holds
    FROM waitlist_seat_offer INNER JOIN registration_draft_waitlist_entry
      ON registration_draft_waitlist_entry.id = waitlist_seat_offer.waitlist_entry_id
    WHERE waitlist_seat_offer.id = ${sql(declinedOffer.offerId)}`);
  assert.equal(declinedState[0]?.offerStatus, "declined", "public waitlist decline resolves the exact active offer");
  assert.equal(Number(declinedState[0]?.holds), 0, "declining a waitlist offer creates no hold or enrollment");

  }
  passed = true;
  console.log(`ok child-credit browser workflow (${testRunId})`);
} catch (error) {
  failureDetails = error instanceof Error ? (error.stack || error.message) : String(error);
  throw error;
} finally {
  if (context) {
    if (passed) {
      await context.tracing.stop();
    } else {
      const artifactDir = mkdtempSync(path.join(tmpdir(), "naranerdem-credit-browser-failure-"));
      mkdirSync(artifactDir, { recursive: true });
      if (page) await page.screenshot({ path: path.join(artifactDir, "failure.png"), fullPage: true }).catch(() => undefined);
      await context.tracing.stop({ path: path.join(artifactDir, "trace.zip") }).catch(() => undefined);
      writeFileSync(path.join(artifactDir, "diagnostic.txt"), `${failureDetails}\n\nLocal Worker output:\n${workerOutput}`);
      console.error(`credit browser failure artifacts: ${artifactDir}`);
    }
    await context.close().catch(() => undefined);
  }
  if (publicContext) await publicContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}

async function expectSingleVisiblePanel(row) {
  await row.locator(".staff-panel-region").waitFor({ state: "visible" });
  await row.locator(".staff-panel-region > *").first().waitFor({ state: "visible" });
  const visible = await row.locator(".staff-panel-region > *").evaluateAll((nodes) => nodes.filter((node) => !node.hidden).length);
  assert.equal(visible, 1, "rapid panel switching leaves exactly one owned panel visible");
}
