import assert from 'node:assert/strict';
import { createAttendanceCardCache, CARD_FRESH_MS, CARD_CACHE_LIMIT } from '../src/scripts/attendance-card-cache.js';

class Node {
  isConnected = false;
  dataset = {};
  listeners = {};
  children = [];
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelectorAll() { return []; }
  remove() { this.isConnected = false; }
  replaceChildren(...children) { this.children.forEach(node => { node.isConnected = false; }); this.children = children; children.forEach(node => { node.isConnected = this.isConnected; }); }
}
globalThis.document = { createElement: () => new Node() };
let time = 1_000_000;
let calls = 0;
let validations = 0;
let release;
let failing = false;
const callbacks = new Map();
const cache = createAttendanceCardCache({ now: () => time, mount: async (node, input) => {
  calls++;
  callbacks.set(input.enrollmentId, input);
  if (release) await release.promise;
  if (failing) throw new Error('disposable failure');
  input.onLoaded({ revalidation: true });
  return { revalidate: async () => { validations++; input.onLoaded({ revalidation: true }); }, dispose: () => node.remove() };
} });
const host = new Node(); host.isConnected = true;
let resolve;
release = { promise: new Promise(done => { resolve = done; }) };
const first = cache.open(host, { enrollmentId: 'legacy:enrollment' });
const second = cache.open(host, { enrollmentId: 'legacy:enrollment' });
assert.equal(calls, 1, 'concurrent opens share one request');
resolve(); await Promise.all([first, second]); release = null;
const originalNode = host.children[0];
host.replaceChildren();
await cache.open(host, { enrollmentId: 'legacy:enrollment' });
assert.equal(host.children[0], originalNode, 'reopening retains the controller and DOM');
assert.equal(calls, 1);
originalNode.listeners.input({ target: originalNode });
assert.equal(cache.hasDrafts(), true);
time += CARD_FRESH_MS;
await cache.open(host, { enrollmentId: 'legacy:enrollment' });
assert.equal(validations, 1, 'stale data revalidates once');
assert.equal(cache.hasDrafts(), true, 'revalidation does not discard a draft');
host.replaceChildren();
await cache.open(host, { enrollmentId: 'other' });
callbacks.get('other').onLoaded({ revalidation: false });
await cache.open(host, { enrollmentId: 'legacy:enrollment' });
assert.equal(validations, 2, 'a successful edit invalidates other cached cards');
callbacks.get('legacy:enrollment').onLoaded({ revalidation: false });
assert.equal(cache.hasDrafts(), false, 'confirmed save clears the saved draft marker');
callbacks.get('legacy:enrollment').onAccessDenied();
assert.equal(host.children[0].isConnected, false, 'authorization failure removes cached data');
failing = true;
await assert.rejects(cache.open(host, { enrollmentId: 'retry' }), /disposable failure/);
failing = false;
await cache.open(host, { enrollmentId: 'retry' });
assert.ok(host.children.length, 'failed loads remain retryable');
cache.clear(); host.replaceChildren();
for (let i = 0; i < CARD_CACHE_LIMIT; i++) {
  await cache.open(host, { enrollmentId: String(i) });
  host.children[0].listeners.input({ target: host.children[0] });
  host.replaceChildren();
}
await assert.rejects(cache.open(host, { enrollmentId: 'overflow' }), /засварыг/, 'bounded cache never evicts unsaved drafts');
cache.clear();
const detached = new Node();
await cache.open(detached, { enrollmentId: 'detached' });
assert.equal(detached.children.length, 0, 'late response cannot mount in a detached occurrence');
console.log('ok bounded attendance card cache: dedup, reopen, freshness, edits, authorization, retry, drafts, detached response');
