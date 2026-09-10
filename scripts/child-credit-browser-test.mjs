import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    INSERT INTO offering_course_pricing (activity_offering_id, one_time_amount_mnt, two_installment_enabled, first_installment_amount_mnt, second_installment_amount_mnt, second_installment_due_on, created_at, updated_at)
      VALUES
      ('browser-offering', 1000, 1, 500, 500, '2027-06-01', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_window (id, name, starts_on, ends_on, is_test, test_run_id, created_at, updated_at)
      VALUES ('browser-window', 'Browser test registration window', ${sql(openStart)}, ${sql(openEnd)}, 1, ${sql(testRunId)}, ${sql(now)}, ${sql(now)});
    INSERT INTO registration_window_offering (registration_window_id, activity_offering_id, created_at)
      VALUES ('browser-window', 'browser-offering', ${sql(now)});
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

async function fillIntake(page, childName) {
  await page.goto(`${baseUrl}/staff/registration-intake/`);
  await page.locator("#intake-app").waitFor({ state: "visible" });
  await page.selectOption('select[name="intakeChannel"]', "paper_form");
  await page.fill('input[name="guardianName"]', `Browser guardian ${childName}`);
  await page.selectOption('select[name="guardianRelationship"]', "Ээж");
  await page.fill('input[name="guardianEmail"]', `${childName.toLowerCase()}@example.test`);
  await page.fill('input[name="guardianPhone"]', "99112233");
  await page.fill('input[name="guardianFacebook"]', `Browser guardian ${childName}`);
  await page.fill('textarea[name="guardianAddress"]', "Browser test district");
  await page.fill('input[name="surname"]', "Browser");
  await page.fill('input[name="givenName"]', childName);
  await page.fill('input[name="dateOfBirth"]', "2015-05-10");
  await page.selectOption('select[name="currentGrade"]', "5");
  await page.selectOption('select[name="stage"]', "stage_1");
  await page.selectOption('select[name="classSessionId"]', "browser-class-source");
  await page.selectOption('select[name="paymentPlanCode"]', "two_installment");
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

async function openCredit(page, childId) {
  const row = page.locator(`[data-registration-child="${childId}"]`);
  if (await row.locator('[data-credit-open]').count() === 0) await row.locator('button[data-payment-detail]').click();
  await row.locator('[data-credit-open]').last().waitFor({ state: "visible" });
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
  if (await row.locator('[data-credit-open]').count() === 0) await row.locator('button[data-payment-detail]').click();
  if (await row.locator('[data-child-credit-form="apply"]:visible').count() === 0) await row.locator('[data-credit-open]').last().click();
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
  if (await row.locator('[data-credit-open]').count() === 0) await row.locator('button[data-payment-detail]').click();
  if (await row.locator('[data-credit-subpanel-name="correct"]').count() === 0) await row.locator('[data-credit-open]').last().click();
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

try {
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "local migrations");
  execute(fixtureSql());
  worker = spawn(process.execPath, [wranglerCli, "dev", "--env", "staging", "--local", "--persist-to", persistDir,
    "--ip", "127.0.0.1", "--port", String(port), "--test-scheduled", "--var", `APP_ORIGIN:${baseUrl}`], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });
  await waitForWorker();

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.addCookies([{ name: "naran_staff_session", value: rawSessionToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  page = await context.newPage();

  const childId = await fillIntake(page, "CreditBrowser");
  assert.ok(childId, "staff intake returns a normal registration anchor");
  const freshRow = page.locator(`[data-registration-child="${childId}"]`);
  await freshRow.waitFor({ state: "visible" });
  const openControl = freshRow.locator('button[data-payment-detail][aria-expanded="true"]');
  if (await openControl.count()) await openControl.click();
  const summary = freshRow.locator('[data-payment-detail][role="button"]');
  await summary.click();
  await freshRow.locator('[data-credit-open]').waitFor({ state: "visible" });
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
  assert.ok(actionOrder.indexOf("Мэдээлэл харах") < actionOrder.indexOf("Кредит")
    && actionOrder.indexOf("Кредит") < actionOrder.indexOf("Анги шилжүүлэх")
    && actionOrder.indexOf("Анги шилжүүлэх") < actionOrder.indexOf("Анги нэмэх"), "outer actions use the staff workflow order");
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
  await expiringPreview.locator('button[type="submit"]').click();
  await expiringPreview.locator('input[name="parentAcknowledged"]').check();
  await expiringPreview.locator('input[name="childAcknowledged"]').check();
  await expiringPreview.locator('[data-additional-class-create]').click();
  const expiringTarget = await dbJson(`SELECT target_registration_draft_child_id AS targetChildId FROM additional_class_admission
    WHERE source_registration_draft_child_id = ${sql(childId)} AND status = 'pending_confirmation' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(expiringTarget.length, 1, "a later pending additional target is created through the rendered staff flow");
  execute(`UPDATE registration_draft SET status = 'expired' WHERE id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ${sql(expiringTarget[0].targetChildId)});`);
  const sourceCreditAfterExpiry = await dbJson(`SELECT COALESCE(SUM(amount_mnt), 0) AS netAmount FROM child_credit_entry
    WHERE canonical_student_id = ${sql(promoted[0].canonicalStudentId)}`);
  assert.equal(Number(sourceCreditAfterExpiry[0].netAmount), 50,
    "expiry of a pending added class preserves the source child's unused credit");
  await page.goto(`${baseUrl}/staff/payments/?registration=${encodeURIComponent(childId)}`);
  await page.locator(`[data-registration-child="${childId}"]`).getByText("Кредит: 50 ₮").waitFor({ state: "visible" });

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
