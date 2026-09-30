import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve("dist");
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const catalog = { academicYears: [{ id: "year", label: "Test", classSessions: [{ id: "class", stageCode: "stage_1", weekday: "Saturday", startTime: "10:00", endTime: "11:20", availability: "available", remainingSeats: 8, paymentOptions: [{ code: "single", totalAmountMnt: 100000, initialAmountMnt: 100000 }] }] }] };

function listen() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://local.test").pathname;
    const requested = pathname === "/" ? "/index.html" : pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const file = resolve(root, `.${normalize(requested)}`);
    if (!file.startsWith(`${root}/`) || !existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  return new Promise((ready) => server.listen(0, "127.0.0.1", () => ready(server)));
}

const server = await listen();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.turnstile = { render(_element, options) { queueMicrotask(() => options.callback("edge-test-token")); return "edge-test"; }, reset() {} };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/registration/bootstrap", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ config: { environment: "staging", writeEnabled: true, turnstileSiteKey: "edge-test", authEmailEnabled: false, publicRegistrationPaused: false, protectionUnavailable: false, stagingNotice: "" }, catalog, courseRules: [] }) }));
  await page.route("**/api/registration/status", (route) => route.fulfill({ status: 404 }));
  await page.route("**/api/registration/submit", (route) => route.fulfill({ status: 429, contentType: "text/html", body: "<h1>Rate limited</h1>" }));
  await page.goto(`${baseUrl}/register/?new=1`);
  await page.locator("#registration-form").waitFor({ state: "visible" });
  await page.locator("#guardian-name").fill("Parent");
  await page.locator("#guardian-relationship").selectOption({ index: 1 });
  await page.locator("#guardian-email").fill("parent@example.test");
  await page.locator("#guardian-phone").fill("99112233");
  await page.locator("#guardian-facebook").fill("parent.account");
  await page.locator("#guardian-address").fill("Ulaanbaatar");
  await page.locator("[data-child-surname]").fill("Test");
  await page.locator("[data-child-name]").fill("Child");
  await page.locator("[data-child-grade]").selectOption("4");
  await page.locator("[data-child-gender]").selectOption({ index: 1 });
  await page.locator("[data-child-dob]").fill("2016-09-01");
  await page.locator("[data-child-stage]").selectOption("stage_1");
  await page.locator("[data-child-class]").check();
  await page.locator("#registration-form button[type=submit]").click();
  await page.locator("#guardian-rules-dialog").waitFor({ state: "visible" });
  await page.locator("#acknowledge-guardian").click();
  await page.locator("#student-rules-dialog").waitFor({ state: "visible" });
  await page.locator("#acknowledge-student").click();
  await page.locator("#review-panel").waitFor({ state: "visible" });
  await page.locator("#submit-registration").click();
  await page.getByText(/10 секунд хүлээгээд дахин оролдоно уу/).waitFor({ state: "visible" });
  assert.equal(await page.locator("#registration-form").isVisible(), true, "a non-JSON edge 429 returns the parent to the form");
  assert.equal(await page.locator("#guardian-name").inputValue(), "Parent", "the edge block preserves guardian input");
  assert.equal(await page.locator("[data-child-name]").inputValue(), "Child", "the edge block preserves child input");
  assert.equal(await page.locator("[data-child-class]").isChecked(), true, "the edge block preserves the selected class");
  assert.deepEqual(pageErrors, [], "the edge-response path produces no browser exception");
  await context.close();
  console.log("ok edge protection browser block handling");
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await new Promise((closed) => server.close(closed));
}
