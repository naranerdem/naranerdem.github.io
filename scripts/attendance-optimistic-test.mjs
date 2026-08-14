import assert from "node:assert/strict";
import {
  attendanceCheckboxState,
  attendanceProgressCount,
  attendanceStatusAfterToggle,
  createOptimisticRosterMutator,
  effectiveAttendanceStatus,
  markedRosterCount,
} from "../src/scripts/attendance-optimistic.js";

const roster = [
  { enrollmentId: "one", recordedAttendanceStatus: null, hasAbsenceNotice: false },
  { enrollmentId: "two", recordedAttendanceStatus: "present", hasAbsenceNotice: false },
];
const updates = [];
const errors = [];
const mutator = createOptimisticRosterMutator({
  onChange(entry) { updates.push({ id: entry.enrollmentId, status: entry.recordedAttendanceStatus, notice: entry.hasAbsenceNotice }); },
  onError(entry, error) { errors.push({ id: entry.enrollmentId, message: error.message }); },
});

let resolvePresent;
const presentRequest = new Promise((resolve) => { resolvePresent = resolve; });
const present = mutator.mutate(roster[0], { recordedAttendanceStatus: "present" }, () => presentRequest);
assert.equal(roster[0].recordedAttendanceStatus, "present", "status changes before the request completes");
assert.equal(markedRosterCount(roster), 2, "marked count updates optimistically");
assert.equal(mutator.isPending("one"), true, "only the changed row is pending");
assert.equal(await mutator.mutate(roster[0], { recordedAttendanceStatus: "late" }, async () => {}), false, "rapid competing taps are ignored while the row is pending");
resolvePresent();
assert.equal(await present, true);
assert.equal(mutator.isPending("one"), false, "row becomes available after the request");

const failed = await mutator.mutate(roster[0], { recordedAttendanceStatus: null }, async () => { throw new Error("network failed"); });
assert.equal(failed, false, "failed requests report failure without retaining false success");
assert.equal(roster[0].recordedAttendanceStatus, "present", "failed status changes roll back");
assert.equal(markedRosterCount(roster), 2, "failed changes restore the marked count");
assert.deepEqual(errors, [{ id: "one", message: "network failed" }]);

await mutator.mutate(roster[0], { hasAbsenceNotice: true }, async () => {});
assert.equal(roster[0].hasAbsenceNotice, true, "prior-notice state can update independently");
assert.ok(updates.length >= 5, "each optimistic, rollback, and settled state notifies the view");

assert.deepEqual(attendanceCheckboxState("late"), { present: true, late: true }, "late visibly implies present");
assert.equal(attendanceStatusAfterToggle("late", "late", false), "present", "unchecking late returns to present");
assert.equal(attendanceStatusAfterToggle("late", "present", false), null, "unchecking present removes present and late");
assert.equal(attendanceStatusAfterToggle(null, "late", true), "late", "checking late records late");
assert.equal(effectiveAttendanceStatus(null, false), null, "unchecked future or in-progress attendance is not absent");
assert.equal(effectiveAttendanceStatus(null, true), "absent", "unchecked attendance is effectively absent after class ends");
assert.equal(effectiveAttendanceStatus("present", true), "present", "a later present correction replaces derived absence");
assert.equal(attendanceProgressCount([{ recordedAttendanceStatus: null }], false), 0);
assert.equal(attendanceProgressCount([{ recordedAttendanceStatus: null }], true), 1, "ended occurrence is conceptually complete without writing absent rows");

console.log("ok optimistic attendance checklist, effective status, rollback, counting, and row locking");
