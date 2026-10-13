import { mountAttendanceStudentCard } from './staff-payments-page.js';

export const CARD_FRESH_MS = 120_000;
export const CARD_CACHE_LIMIT = 6;

// Only page-session memory. Keeping the actual controller and DOM preserves
// drafts, tabs and in-flight work when Attendance replaces its row markup.
export function createAttendanceCardCache({ mount = mountAttendanceStudentCard, now = Date.now } = {}) {
  const entries = new Map();
  function invalidate(except) {
    for (const entry of entries.values()) if (entry !== except) entry.checkedAt = 0;
  }
  function clear() {
    for (const entry of entries.values()) { entry.controller?.dispose(); entry.node.remove(); }
    entries.clear();
  }
  async function open(host, input) {
    const key = input.enrollmentId;
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= CARD_CACHE_LIMIT) {
        const victim = [...entries.values()].find(item => !item.dirty && !item.loading && !item.node.isConnected);
        if (!victim) throw new Error('Нээлттэй картуудын засварыг хадгалах эсвэл болих үйлдлээр дуусгана уу.');
        victim.controller?.dispose(); entries.delete(victim.key);
      }
      entry = { key, node: document.createElement('div'), checkedAt: 0, loading: null, controller: null, dirty: false };
      entries.set(key, entry);
      const trackDraft = event => { entry.dirty = true; event.target.dataset.cardDraftEdited = 'true'; };
      entry.node.addEventListener('input', trackDraft);
      entry.node.addEventListener('change', trackDraft);
      entry.node.addEventListener('click', event => {
        const button = event.target.closest?.('button');
        if (button && Object.keys(button.dataset).some(key => key.endsWith('Cancel'))) {
          queueMicrotask(() => { if (!entry.node.querySelectorAll('[data-card-draft-edited]').length) entry.dirty = false; });
        }
      });
    }
    // Touch for bounded least-recently-used eviction, without dropping drafts.
    entries.delete(key); entries.set(key, entry);
    if (!entry.loading && (!entry.controller || now() - entry.checkedAt >= CARD_FRESH_MS)) {
      const revalidating = Boolean(entry.controller);
      const work = entry.controller
        ? entry.controller.revalidate()
        : mount(entry.node, { ...input, onAccessDenied: clear, onLoaded: ({ revalidation } = {}) => {
          if (entry.controller) invalidate(entry);
          if (entry.controller && !revalidation) {
            entry.dirty = false;
            entry.node.querySelectorAll('[data-card-draft-edited]').forEach(node => { delete node.dataset.cardDraftEdited; });
          }
          entry.checkedAt = now();
        } });
      entry.loading = Promise.resolve(work).then(controller => {
        if (!revalidating) entry.controller = controller;
        if (controller !== false) entry.checkedAt = now();
      }).catch(error => {
        entry.checkedAt = 0;
        if (!entry.controller) entries.delete(key);
        throw error;
      }).finally(() => { entry.loading = null; });
    }
    if (entry.loading) await entry.loading;
    // A later toggle can detach this host. Never mount under a different row.
    if (host.isConnected && entries.get(key) === entry) host.replaceChildren(entry.node);
  }
  return { open, invalidate, clear, hasDrafts: () => [...entries.values()].some(entry => entry.dirty) };
}
