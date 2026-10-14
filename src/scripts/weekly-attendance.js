import { escape } from './staff-setup.js';
import { createAttendanceController } from './attendance-controller.js';

export function schoolWeek(date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
}

export function createWeeklyAttendance(root, capabilities) {
  let week = schoolWeek();
  let version = 0;
  let active = null;
  let loading = false;
  const controllers = new Map();
  const weeks = new Map();
  const weekLoads = new Map();
  const freshnessMs = 30000;
  let generation = 0;
  function invalidate() {
    generation++;
    weeks.clear();
    for (const entry of controllers.values()) entry.loadedAt = 0;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) invalidate(); });
  root.innerHTML = `<div class="staff-week-navigation"><button type="button" data-week-step="-7" aria-label="Өмнөх долоо хоног" title="Өмнөх долоо хоног">←</button><strong data-week-range></strong><button type="button" data-week-step="7" aria-label="Дараах долоо хоног" title="Дараах долоо хоног">→</button></div><p data-week-message role="status" hidden></p><div data-week-classes></div>`;
  const q = selector => root.querySelector(selector);
  const message = text => { q('[data-week-message]').textContent = text; q('[data-week-message]').hidden = !text; };
  function canLeave() {
    const controller = controllers.get(active)?.controller;
    if (controller && !controller.canLeave()) {
      message('Ирцийн хадгалалт эсвэл алдааг шалгасны дараа үргэлжлүүлнэ үү.');
      return false;
    }
    message('');
    return true;
  }
  function closeBranch() {
    for (const node of root.querySelectorAll('[data-week-class]')) node.open = false;
    active = null;
  }
  async function loadWeek(next = week) {
    if (!canLeave()) return;
    week = next;
    const requestVersion = ++version;
    loading = true;
    closeBranch();
    q('[data-week-classes]').innerHTML = '<p role="status">Ачаалж байна…</p>';
    try {
      const key = week;
      let cached = weeks.get(key);
      if (!cached || Date.now() - cached.loadedAt >= freshnessMs) {
        let request = weekLoads.get(key);
        if (!request) {
          const epoch = generation;
          request = (async () => {
            const response = await fetch(`/api/staff/attendance?week=${encodeURIComponent(key)}`, { credentials: 'same-origin' });
            if (!response.ok) throw new Error('Долоо хоногийн хуваарийг ачаалж чадсангүй.');
            const data = await response.json();
            if (!Array.isArray(data.occurrences) || data.occurrences.some(entry => !Number.isInteger(entry.rosterCount) || entry.rosterCount < 0)) {
              throw new Error('Сурагчдын тоог шалгаж чадсангүй. Дахин ачаална уу.');
            }
            const result = { data, loadedAt: Date.now() };
            if (generation === epoch) {
              weeks.delete(key); weeks.set(key, result);
              while (weeks.size > 3) weeks.delete(weeks.keys().next().value);
            }
            return result;
          })().finally(() => weekLoads.delete(key));
          weekLoads.set(key, request);
        }
        cached = await request;
      }
      const data = cached.data;
      if (requestVersion !== version) return;
      week = data.weekStart;
      q('[data-week-range]').textContent = `${data.weekStart} – ${data.weekEnd}`;
      const occupied = data.occurrences.filter(entry => entry.rosterCount > 0);
      q('[data-week-classes]').innerHTML = occupied.length ? occupied.map(entry =>
        `<details class="staff-makeup-group" data-week-class="${escape(entry.slotId)}" data-local-date="${escape(entry.localDate)}"><summary class="staff-makeup-group-heading"><strong>${escape(entry.localDate)} · ${escape(entry.weekday)} · ${escape(entry.startTime)}–${escape(entry.endTime)} · ${escape(entry.programLabel)}</strong><span>${entry.rosterCount} сурагч</span></summary><div class="staff-makeup-group-body" data-week-roster></div></details>`
      ).join('') : '<p class="staff-empty">Энэ долоо хоногт сурагчтай хичээл алга.</p>';
    } catch (error) {
      if (requestVersion !== version) return;
      q('[data-week-classes]').innerHTML = '<button type="button" class="text-button" data-week-retry>Дахин ачаалах</button>';
      message(error.message);
    } finally { if (requestVersion === version) loading = false; }
  }
  root.addEventListener('click', async event => {
    const summary = event.target.closest('[data-week-class] > summary');
    if (summary) {
      event.preventDefault();
      if (!canLeave()) return;
      const details = summary.parentElement;
      const key = `${details.dataset.localDate}|${details.dataset.weekClass}`;
      const opening = !details.open;
      closeBranch();
      if (!opening) return;
      active = key; details.open = true;
      let host = details.querySelector('[data-week-roster]');
      let entry = controllers.get(key);
      if (!entry) {
        while (controllers.size >= 8) {
          const oldest = controllers.keys().next().value;
          controllers.get(oldest).controller.dispose(); controllers.delete(oldest);
        }
        host.innerHTML = '<p id="tool-message" role="status" hidden></p><section id="attendance-detail" class="staff-attendance-detail"></section><button type="button" class="text-button" data-roster-reload>Дахин ачаалах</button>';
        const controller = createAttendanceController(host, { compact: true, date: details.dataset.localDate, slotId: details.dataset.weekClass, capabilities,
          onMutation: invalidate, onSettled: () => { entry.loadedAt = Date.now(); if (active === key) message(''); } });
        entry = { controller, host, ready: controller.ready, loadedAt: 0 }; controllers.set(key, entry);
        host.querySelector('#attendance-detail').innerHTML = '<p role="status">Ирц ачаалж байна…</p>';
      } else {
        if (host !== entry.host) { host.replaceWith(entry.host); host = entry.host; }
        controllers.delete(key); controllers.set(key, entry);
        if (!entry.ready && Date.now() - entry.loadedAt >= freshnessMs) entry.ready = entry.controller.reload();
      }
      const epoch = generation;
      try { if (entry.ready) { await entry.ready; entry.loadedAt = epoch === generation ? Date.now() : 0; } }
      catch { if (host.isConnected) host.querySelector('#tool-message').textContent = 'Ирцийг ачаалж чадсангүй. Дахин ачаална уу.'; if (host.isConnected) host.querySelector('#tool-message').hidden = false; }
      finally { entry.ready = null; }
      return;
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-roster-reload')) {
      const entry = controllers.get(active);
      if (!entry || entry.ready) return;
      const epoch = generation;
      entry.ready = entry.controller.reload();
      try { await entry.ready; entry.loadedAt = epoch === generation ? Date.now() : 0; } catch { entry.loadedAt = 0; message('Ирцийг ачаалж чадсангүй. Дахин оролдоно уу.'); }
      finally { entry.ready = null; }
    }
    if (button.hasAttribute('data-week-retry')) void loadWeek();
    if (button.dataset.weekStep && !loading && canLeave()) {
      const date = new Date(`${week}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + Number(button.dataset.weekStep));
      void loadWeek(date.toISOString().slice(0, 10));
    }
  });
  return { ready: loadWeek(), canLeave, closeBranch, invalidate,
    refreshIfStale() { const cached = weeks.get(week); if (!loading && (!cached || Date.now() - cached.loadedAt >= freshnessMs)) void loadWeek(); } };
}
