import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkWeeklyAttendance({ context, baseUrl, date, execute, screenshotDir, engine }) {
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/')) requests.push({ url: request.url(), method: request.method() }); });
  const read = async suffix => {
    const response = await context.request.get(`${baseUrl}/api/staff/attendance?${suffix}`);
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  for (const [day, start, end] of [['2027-01-01','2026-12-28','2027-01-03'], ['2027-01-03','2026-12-28','2027-01-03'], ['2027-01-04','2027-01-04','2027-01-10']]) {
    const week = await read(`week=${day}`); assert.equal(week.weekStart, start); assert.equal(week.weekEnd, end);
  }
  const initialWeek = await read(`week=${date}`);
  execute(`INSERT INTO course_makeup_special_occurrence (id,curriculum_lesson_id,local_date,start_time,end_time,capacity,status,created_by_staff_account_id,is_test,test_run_id,created_at,updated_at)
    VALUES ('weekly-extra','lesson','${initialWeek.weekEnd}','18:00','19:20',10,'active','attendance-browser-staff',1,'attendance-browser',datetime('now'),datetime('now'));`);
  const original = await read(`date=${date}&occurrence=attendance-slot`);
  const selected = await read(`date=${date}&occurrence=attendance-slot&rosterOnly=1`);
  assert.deepEqual(selected.selected, original.selected, 'week roster exactly matches original Attendance including transfer identities');
  const summary = await read(`week=${date}`);
  for (const item of summary.occurrences) {
    assert.equal(item.roster, undefined, 'week response contains summaries only');
    const roster = await read(`date=${item.localDate}&occurrence=${encodeURIComponent(item.slotId)}&rosterOnly=1`);
    assert.equal(item.rosterCount, roster.selected.rosterCount, 'count uses authoritative roster eligibility');
  }
  assert.deepEqual(summary.occurrences.map(x => `${x.localDate}|${x.startTime}|${x.slotId}`), summary.occurrences.map(x => `${x.localDate}|${x.startTime}|${x.slotId}`).sort());
  await page.goto(`${baseUrl}/staff/makeups/`);
  await page.waitForFunction(() => document.querySelector('[data-week-range]')?.textContent.includes(' – '));
  assert.equal(await page.locator('#weekly-attendance').getAttribute('open'), '');
  assert.equal(await page.locator('[data-week-class][open]').count(), 0);
  assert.equal(requests.filter(x => x.url.includes('rosterOnly')).length, 0, 'no roster preload');
  assert.equal(requests.filter(x => x.url.includes('/api/staff/payments')).length, 0, 'no financial fetch');
  const initialRequests = requests.filter(x => x.method === 'GET').length;
  assert.equal(initialRequests, 3, 'initial page = session + week + existing makeups');
  if (!(await page.locator('[data-week-range]').innerText()).startsWith(summary.weekStart)) {
    await page.locator('[data-week-step="-7"]').click();
    await page.locator(`[data-week-class="attendance-slot"]`).waitFor();
  }
  const group = page.locator('[data-week-class="attendance-slot"]');
  const beforeOpen = requests.length;
  await group.locator('summary').first().click();
  await group.locator('[data-attendance-row="ordinary-enrollment"]').waitFor();
  assert.equal(requests.length - beforeOpen, 1, 'one selected roster request');
  assert.equal(await group.locator('[data-attendance-card-toggle]').count(), 0, 'student names are plain text');
  assert.equal(await group.locator('[data-attendance-row="transfer-target:enrollment"]').count(), 1);
  const rows = group.locator('[data-attendance-row]');
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(n => n.dataset.attendanceRow)), selected.selected.roster.map(r => r.enrollmentId));
  const present = group.locator('[data-attendance-row="ordinary-enrollment"] [data-attendance-control="present"]');
  const expected = !await present.isChecked();
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route('**/api/staff/attendance', async route => { if (route.request().method() === 'POST') { await delayed; } await route.continue(); });
  const started = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/staff/attendance'));
  await present.click(); await started;
  await group.locator('summary').first().click();
  await page.locator('[data-week-step="7"]').click();
  await page.locator('[data-section="open"] > summary').click();
  assert.equal(await group.getAttribute('open'), '', 'pending class cannot be collapsed');
  assert.equal(await page.locator('#weekly-attendance').getAttribute('open'), '', 'pending branch remains visible');
  assert.equal(await page.locator('[data-section][open]').count(), 1);
  release();
  await group.getByText('Хадгаллаа', { exact: true }).waitFor();
  await page.unroute('**/api/staff/attendance');
  await group.locator('summary').first().click();
  await group.locator('summary').first().click();
  await present.waitFor();
  assert.equal(await present.isChecked(), expected, 'reopened roster reflects durable save');
  // Definite rejection remains visible, with no optimistic false success.
  await page.route('**/api/staff/attendance', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Дахин шалгана уу.' } }) }));
  await present.click();
  await group.getByText('Дахин шалгана уу.', { exact: true }).waitFor();
  assert.equal(await present.isChecked(), expected);
  await page.locator('[data-week-step="7"]').click();
  assert.equal(await group.getAttribute('open'), '', 'unresolved error is not hidden by week navigation');
  await page.unroute('**/api/staff/attendance');
  await group.locator('[data-roster-reload]').click();
  await group.locator('.staff-attendance-row-error').waitFor({ state: 'detached' });
  // A committed response lost in transit is reconciled by the shared controller.
  await page.route('**/api/staff/attendance', async route => { await route.fetch(); await route.abort('connectionfailed'); });
  await present.click();
  await group.getByText('Хадгалалт баталгаажлаа', { exact: true }).waitFor();
  await page.unroute('**/api/staff/attendance');
  assert.equal(await present.isChecked(), !expected);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => window.scrollY === 0);
  await page.screenshot({ path: path.join(screenshotDir, `weekly-${engine}-desktop.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => window.scrollY === 0);
  await page.screenshot({ path: path.join(screenshotDir, `weekly-${engine}-mobile.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[data-week-class="weekly-extra"] > summary').click();
  assert.equal(await page.locator('[data-week-class][open]').count(), 1);
  assert.equal(await group.getAttribute('open'), null);
  await page.locator('[data-section="open"] > summary').click();
  assert.equal(await page.locator('#weekly-attendance').getAttribute('open'), null);
  assert.equal(await page.locator('[data-week-class][open]').count(), 0);
  await page.locator('[data-section="scheduled"] > summary').click();
  assert.equal(await page.locator('[data-section][open]').count(), 1);
  await page.locator('#weekly-attendance > summary').click();
  await Promise.all([
    page.waitForResponse(r => r.url().includes('week=') && r.ok()),
    page.locator('[data-week-step="7"]').click(),
  ]);
  assert.equal(await page.locator('[data-week-class][open]').count(), 0);
  assert.equal(requests.filter(x => x.url.includes('/api/staff/payments')).length, 0);
  // UI capability isolation, retaining real server endpoints and rosters.
  await page.route('**/api/staff/session', async route => { const r = await route.fetch(); const body = await r.json(); await route.fulfill({ response: r, json: { ...body, capabilities: ['attendance.view', 'attendance.manage'] } }); });
  const countBefore = requests.filter(x => x.url.includes('/api/staff/makeups')).length;
  await page.reload(); await page.waitForFunction(() => document.querySelector('[data-week-range]')?.textContent.includes(' – '));
  assert.equal(await page.locator('#makeup-groups [data-section]').count(), 0);
  assert.equal(requests.filter(x => x.url.includes('/api/staff/makeups')).length, countBefore);
  await page.unroute('**/api/staff/session');
  execute("UPDATE staff_account_role SET role_code='accountant' WHERE staff_account_id='attendance-browser-staff'");
  assert.equal((await context.request.get(`${baseUrl}/api/staff/attendance?week=${date}`)).status(), 403, 'server rejects payment-only account');
  assert.equal((await context.request.get(`${baseUrl}/api/staff/attendance?date=${date}&occurrence=attendance-slot&rosterOnly=1`)).status(), 403);
  execute("UPDATE staff_account_role SET role_code='teacher' WHERE staff_account_id='attendance-browser-staff'");
  assert.deepEqual(errors, []);
  console.log(`ok ${engine} weekly attendance: initial ${initialRequests} API GETs, class open 1 GET, no Payments requests; boundaries, roster, navigation and saves`);
  await page.close();
}
