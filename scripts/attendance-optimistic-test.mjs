import assert from "node:assert/strict";
import { createOptimisticRosterMutator, markedRosterCount } from "../src/scripts/attendance-optimistic.js";

const roster = [
  { enrollmentId: "one", attendanceStatus: null, hasAbsenceNotice: false },
  { enrollmentId: "two", attendanceStatus: "present", hasAbsenceNotice: false },
];
const updates = [];
const errors = [];
const mutator = createOptimisticRosterMutator({
  onChange(entry) { updates.push({ id: entry.enrollmentId, status: entry.attendanceStatus, notice: entry.hasAbsenceNotice }); },
  onError(entry, error) { errors.push({ id: entry.enrollmentId, message: error.message }); },
});

let resolvePresent;
const presentRequest = new Promise((resolve) => { resolvePresent = resolve; });
const present = mutator.mutate(roster[0], { attendanceStatus: "present" }, () => presentRequest);
assert.equal(roster[0].attendanceStatus, "present", "status changes before the request completes");
assert.equal(markedRosterCount(roster), 2, "marked count updates optimistically");
assert.equal(mutator.isPending("one"), true, "only the changed row is pending");
assert.equal(await mutator.mutate(roster[0], { attendanceStatus: "late" }, async () => {}), false, "rapid competing taps are ignored while the row is pending");
resolvePresent();
assert.equal(await present, true);
assert.equal(mutator.isPending("one"), false, "row becomes available after the request");

const failed = await mutator.mutate(roster[0], { attendanceStatus: null }, async () => { throw new Error("network failed"); });
assert.equal(failed, false, "failed requests report failure without retaining false success");
assert.equal(roster[0].attendanceStatus, "present", "failed status changes roll back");
assert.equal(markedRosterCount(roster), 2, "failed changes restore the marked count");
assert.deepEqual(errors, [{ id: "one", message: "network failed" }]);

await mutator.mutate(roster[0], { hasAbsenceNotice: true }, async () => {});
assert.equal(roster[0].hasAbsenceNotice, true, "prior-notice state can update independently");
assert.ok(updates.length >= 5, "each optimistic, rollback, and settled state notifies the view");

console.log("ok optimistic attendance roster updates, rollback, counting, and row locking");
