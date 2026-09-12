import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('browser-offering', 'annual_course', 'Browser credit offering', 'browser-year', 'stage_1', 1, 'paid', 'active', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
      VALUES
      ('browser-class-source', 'browser-offering', 'browser-year', 'stage_1', 'Browser credit source class', 'Tuesday', '09:00', '10:20', 10, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)}),
      ('browser-class-target', 'browser-offering', 'browser-year', 'stage_1', 'Browser credit target class', 'Tuesday', '15:00', '16:20', 10, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES
      ('browser-offering-high', 'annual_course', 'Browser higher transfer offering', 'browser-year', 'stage_2', 1, 'paid', 'active', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)}),
      ('browser-offering-low', 'annual_course', 'Browser lower transfer offering', 'browser-year', 'stage_3', 1, 'paid', 'active', 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at)
      VALUES
      ('browser-class-high', 'browser-offering-high', 'browser-year', 'stage_2', 'Browser higher transfer class', 'Wednesday', '09:00', '10:20', 10, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)}),
      ('browser-class-low', 'browser-offering-low', 'browser-year', 'stage_3', 'Browser lower transfer class', 'Thursday', '09:00', '10:20', 10, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)}),
      ('browser-class-waitlist', 'browser-offering', 'browser-year', 'stage_1', 'Browser waitlist class', 'Friday', '09:00', '10:20', 10, 'available', 1, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
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
      VALUES ('browser-credit-teacher', 'teacher', ${sql(now)});
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

async function submitPublicRegistration(browser, { childName, email, paymentPlanCode, expectedInitialAmount }) {
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
      registration_draft.id AS registrationDraftId,
      registration_capacity_hold.status AS holdStatus,
      payment_request.id AS paymentRequestId,
      registration_draft_child.initial_payment_amount_mnt AS paymentAmount
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      AND registration_capacity_hold.status = 'active'
    LEFT JOIN payment_request ON payment_request.registration_draft_id = registration_draft_child.registration_draft_id
    WHERE registration_draft.normalized_email = ${sql(email)}`);
  assert.equal(rows.length, 1, "the rendered public flow creates exactly one registration child");
  assert.equal(rows[0].holdStatus, "active", "public registration creates one active capacity hold");
  assert.equal(Number(rows[0].paymentAmount), expectedInitialAmount,
    "public plan selection uses the authoritative initial installment rather than a browser price");
  const receipts = await dbJson(`SELECT COUNT(*) AS count FROM outbound_email
    WHERE registration_draft_id = ${sql(rows[0].registrationDraftId)}
      AND template_key = 'registration_receipt_v1'`);
  assert.equal(Number(receipts[0].count), 0,
    "without a configured local provider, public submission does not fabricate an Outbox receipt");
  await publicContext.close();
  publicContext = undefined;
  return rows[0].childId;
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

async function recordCashPayment(page, childId, amount) {
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  const row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
  const form = row.locator("[data-payment-form]");
  await form.waitFor({ state: "visible" });
  assert.equal(Number(await form.locator('input[name="amount"]').inputValue()), amount,
    "the rendered staff payment form requests the authoritative effective amount");
  await form.locator('select[name="source"]').selectOption("staff_manual_cash");
  const request = page.waitForResponse((response) => response.url().endsWith("/api/staff/payments")
    && response.request().method() === "POST");
  await form.locator('button[type="submit"]').click();
  const response = await request;
  if (!response.ok()) throw new Error(`cash payment failed: ${await response.text()}`);
  await row.getByText("Төлбөр бүртгэгдлээ").waitFor({ state: "visible" });
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

async function cancelAndRestoreRegistration(page, childId) {
  let row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
  const cancellation = row.locator("[data-registration-cancel-form]");
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

  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  row = page.locator(`[data-registration-child="${childId}"]`);
  await row.waitFor({ state: "visible" });
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

  if (process.env.FAMILY_DISCOUNT_BROWSER_ONLY === "1") {
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
  await recordCashPayment(page, laterCashAdmission[0].targetChildId, 900);
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

  const childId = await fillIntake(page, "CreditBrowser");
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

  await addCredit(page, childId, 500);
  await applyCredit(page, childId, 500);
  const prePromotion = await dbJson(`SELECT canonical_student_id AS canonicalStudentId FROM registration_draft_child WHERE id = ${sql(childId)}`);
  assert.equal(prePromotion[0].canonicalStudentId, null, "credit-only initial settlement remains a normal pending draft until finalization");
  const cash = await dbJson(`SELECT COUNT(*) AS count FROM received_payment WHERE payment_request_id IN (SELECT id FROM payment_request WHERE registration_draft_id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(childId)}))`);
  assert.equal(Number(cash[0].count), 0, "credit application does not fabricate a received cash payment");

  execute(`UPDATE credit_application_confirmation SET finalize_after = '2000-01-01T00:00:00.000Z' WHERE registration_draft_child_id = ${sql(childId)};`);
  const scheduled = await fetch(`${baseUrl}/__scheduled`);
  assert.ok(scheduled.ok, "the actual local scheduled Worker accepts the deterministic fixture trigger");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const creditConfirmation = await dbJson(`SELECT status, finalize_after AS finalizeAfter FROM credit_application_confirmation WHERE registration_draft_child_id = ${sql(childId)}`);
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
  await page.getByText("Төлбөр баталгаажсан (1)").waitFor({ state: "visible", timeout: 5_000 });
  await page.getByText("Кредитээр тооцсон: 500 ₮").waitFor({ state: "visible", timeout: 5_000 });
  const actionOrder = await page.locator(`[data-registration-child="${childId}"] .staff-panel-actions[aria-label="Бүртгэлийн үйлдэл"]`).textContent();
  assert.ok(actionOrder.indexOf("Мэдээлэл") < actionOrder.indexOf("Төлбөр")
    && actionOrder.indexOf("Төлбөр") < actionOrder.indexOf("Кредит")
    && actionOrder.indexOf("Кредит") < actionOrder.indexOf("Шилжих")
    && actionOrder.indexOf("Шилжих") < actionOrder.indexOf("Анги нэмэх"), "outer actions use the staff workflow order");
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
  await onePaymentPreview.getByText("Нэг удаа төлөх").waitFor({ state: "visible" });
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
  await confirmFamilyMembership(page, familyAlpha, familyGamma, "FamilyGamma", "Browser deliberate repeated family confirmation");
  const familyReplayResult = await dbJson(`SELECT
      (SELECT COUNT(*) FROM family_group_member WHERE family_group_id = family_group_confirmation.family_group_id AND status = 'active') AS members,
      (SELECT COUNT(*) FROM discount_award WHERE registration_draft_child_id IN (${sql(familyAlpha)}, ${sql(familyBeta)}, ${sql(familyGamma)})
        AND award_type = 'family_multi_child' AND status = 'active') AS awards
    FROM family_group_confirmation ORDER BY created_at DESC LIMIT 1`);
  assert.equal(Number(familyReplayResult[0]?.members), 3, "a deliberate repeated confirmation does not duplicate active membership");
  assert.equal(Number(familyReplayResult[0]?.awards), 3, "a deliberate repeated confirmation creates no additional discount value");

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

  const restoreChildId = await fillIntake(page, "RestoreBrowser");
  await addCredit(page, restoreChildId, 500);
  await applyCredit(page, restoreChildId, 500);
  await finalizeCreditOnlyRegistration(page, restoreChildId);
  await cancelAndRestoreRegistration(page, restoreChildId);

  const higherTransferChildId = await fillIntake(page, "HigherTransferBrowser");
  await addCredit(page, higherTransferChildId, 500);
  await applyCredit(page, higherTransferChildId, 500);
  await finalizeCreditOnlyRegistration(page, higherTransferChildId);
  await completeTransfer(page, higherTransferChildId, "browser-class-high", 200);
  const higherTransfer = await dbJson(`SELECT class_transfer.status, class_transfer.required_difference_mnt AS differenceMnt,
      (SELECT COUNT(*) FROM enrollment WHERE class_session_id = 'browser-class-source' AND transferred_out_at IS NOT NULL) AS sourceSuperseded,
      (SELECT COUNT(*) FROM enrollment WHERE class_session_id = 'browser-class-high' AND status = 'confirmed' AND transferred_out_at IS NULL) AS currentTarget,
      (SELECT COUNT(*) FROM class_transfer_payment WHERE class_transfer_payment_obligation_id IN (
        SELECT id FROM class_transfer_payment_obligation WHERE class_transfer_id = class_transfer.id
      )) AS differencePayments
    FROM class_transfer WHERE source_registration_draft_child_id = ${sql(higherTransferChildId)} ORDER BY created_at DESC LIMIT 1`);
  assert.equal(higherTransfer[0]?.status, "completed", "higher-price transfer completes through the rendered staff flow");
  assert.equal(Number(higherTransfer[0]?.differenceMnt), 200, "higher-price transfer preserves its authoritative price difference");
  assert.equal(Number(higherTransfer[0]?.sourceSuperseded), 1, "higher-price completion supersedes exactly one source enrollment");
  assert.equal(Number(higherTransfer[0]?.currentTarget), 1, "higher-price completion leaves exactly one current target enrollment");
  assert.equal(Number(higherTransfer[0]?.differencePayments), 1, "higher-price settlement records one immutable difference payment");

  const lowerTransferChildId = await fillIntake(page, "LowerTransferBrowser");
  await addCredit(page, lowerTransferChildId, 500);
  await applyCredit(page, lowerTransferChildId, 500);
  await finalizeCreditOnlyRegistration(page, lowerTransferChildId);
  await completeTransfer(page, lowerTransferChildId, "browser-class-low", 0);
  const lowerTransfer = await dbJson(`SELECT class_transfer.status, class_transfer.resulting_credit_mnt AS creditMnt,
      (SELECT COUNT(*) FROM enrollment WHERE class_session_id = 'browser-class-source' AND transferred_out_at IS NOT NULL) AS sourceSuperseded,
      (SELECT COUNT(*) FROM enrollment WHERE class_session_id = 'browser-class-low' AND status = 'confirmed' AND transferred_out_at IS NULL) AS currentTarget,
      (SELECT COUNT(*) FROM class_transfer_credit WHERE class_transfer_id = class_transfer.id AND available_amount_mnt = class_transfer.resulting_credit_mnt) AS credits
    FROM class_transfer WHERE source_registration_draft_child_id = ${sql(lowerTransferChildId)} ORDER BY created_at DESC LIMIT 1`);
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
} finally {
  if (context) {
    if (passed) {
      await context.tracing.stop();
    } else {
      const artifactDir = mkdtempSync(path.join(tmpdir(), "naranerdem-credit-browser-failure-"));
      mkdirSync(artifactDir, { recursive: true });
      if (page) await page.screenshot({ path: path.join(artifactDir, "failure.png"), fullPage: true }).catch(() => undefined);
      await context.tracing.stop({ path: path.join(artifactDir, "trace.zip") }).catch(() => undefined);
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
