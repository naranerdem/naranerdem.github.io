import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-calendar-domain-"));
const bundlePath = path.join(tempDir, "program-calendar.mjs");
const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");

function bundle() {
  const result = spawnSync(esbuild, [
    "src/server/services/program-calendar.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--outfile=${bundlePath}`,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`esbuild failed\n${result.stdout}\n${result.stderr}`);
}

function lessons(count, prefix = "lesson") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index + 1).padStart(2, "0")}`,
    sequenceNumber: index + 1,
    title: `Туршилтын хичээл ${String(index + 1).padStart(2, "0")}`,
  }));
}

function active(slots) {
  return slots.filter((slot) => slot.status === "scheduled");
}

function byLesson(slots, sequenceNumber) {
  const slot = active(slots).find((candidate) => candidate.lesson?.sequenceNumber === sequenceNumber);
  assert.ok(slot, `lesson ${sequenceNumber} has a slot`);
  return slot;
}

function assertCompleteProgram(slots, count) {
  const teachingSlots = active(slots);
  assert.equal(teachingSlots.length, count, "every lesson has exactly one active slot");
  assert.deepEqual(
    teachingSlots.map((slot) => slot.lesson.sequenceNumber),
    Array.from({ length: count }, (_, index) => index + 1),
    "lessons remain in explicit sequence order",
  );
  assert.equal(new Set(teachingSlots.map((slot) => slot.lesson.id)).size, count, "no lesson is duplicated");
  assert.equal(
    new Set(teachingSlots.map((slot) => `${slot.localDate}|${slot.startTime}|${slot.endTime}`)).size,
    count,
    "no active teaching slot is duplicated",
  );
}

try {
  bundle();
  const { generateCalendarSchedule, reflowCancelledFutureSchedule } = await import(pathToFileURL(bundlePath).href);

  const sharedProgram = lessons(6, "stage-2");
  const sunday = generateCalendarSchedule({
    lessons: sharedProgram,
    firstCandidateDate: "2026-10-04",
    habitualWeekday: "Ням",
    startTime: "10:00",
    endTime: "11:20",
  });
  const tuesday = generateCalendarSchedule({
    lessons: sharedProgram,
    firstCandidateDate: "2026-10-06",
    habitualWeekday: "Мягмар",
    startTime: "16:00",
    endTime: "17:20",
  });
  assert.equal(byLesson(sunday, 3).localDate, "2026-10-18");
  assert.equal(byLesson(tuesday, 3).localDate, "2026-10-20");
  assert.equal(byLesson(sunday, 3).lesson.id, byLesson(tuesday, 3).lesson.id, "cohorts share program identity, not dates");

  const baseline = generateCalendarSchedule({
    lessons: lessons(30, "holiday"),
    firstCandidateDate: "2026-10-04",
    habitualWeekday: "sunday",
    startTime: "10:00",
    endTime: "11:20",
  });
  const holidays = generateCalendarSchedule({
    lessons: lessons(30, "holiday"),
    firstCandidateDate: "2026-10-04",
    habitualWeekday: "sunday",
    startTime: "10:00",
    endTime: "11:20",
    breaks: [{
      id: "short-break",
      label: "Туршилтын завсарлага",
      startsOn: "2026-10-18",
      endsOn: "2026-11-01",
      excludesHabitualSlots: true,
    }],
  });
  assertCompleteProgram(holidays, 30);
  assert.equal(holidays.filter((slot) => slot.status === "no_class").length, 3, "three habitual dates are explicit no-class rows");
  assert.equal(byLesson(holidays, 30).localDate, "2027-05-16");
  assert.notEqual(byLesson(baseline, 30).localDate, byLesson(holidays, 30).localDate, "holidays extend the tail instead of dropping lessons");

  const restored = generateCalendarSchedule({
    lessons: lessons(5, "restore"),
    firstCandidateDate: "2026-10-04",
    habitualWeekday: "Ням",
    startTime: "10:00",
    endTime: "11:20",
    breaks: [{
      id: "winter",
      label: "Туршилтын өвлийн завсарлага",
      startsOn: "2026-10-18",
      endsOn: "2026-10-18",
      excludesHabitualSlots: true,
    }],
    overrides: [
      { id: "restore-break", localDate: "2026-10-18", behavior: "restore", reasonLabel: "Нөхөх хичээл" },
      { id: "class-exclusion", localDate: "2026-10-25", behavior: "exclude", reasonLabel: "Багшийн ажилтай өдөр" },
    ],
  });
  const restoredSlot = restored.find((slot) => slot.localDate === "2026-10-18");
  assert.equal(restoredSlot?.status, "scheduled", "class override restores a global-break date");
  assert.equal(restoredSlot?.slotSource, "manual_restore");
  assert.equal(restored.find((slot) => slot.localDate === "2026-10-25")?.status, "no_class", "class exclusion removes an ordinary candidate");

  const withExtra = generateCalendarSchedule({
    lessons: lessons(5, "extra"),
    firstCandidateDate: "2026-10-04",
    habitualWeekday: "Ням",
    startTime: "10:00",
    endTime: "11:20",
    extraSlots: [{ id: "wed-extra", localDate: "2026-10-14", startTime: "17:00", endTime: "18:20", reasonLabel: "Нэмэлт хичээл" }],
  });
  assert.equal(byLesson(withExtra, 3).id, "wed-extra", "an extra slot absorbs the next lesson chronologically");
  assert.equal(byLesson(withExtra, 4).localDate, "2026-10-18");

  const original = generateCalendarSchedule({
    lessons: lessons(10, "reflow"),
    firstCandidateDate: "2026-10-04",
    habitualWeekday: "Ням",
    startTime: "10:00",
    endTime: "11:20",
  });
  const cancelledNoReplacement = reflowCancelledFutureSchedule({
    lessons: lessons(10, "reflow"),
    firstCandidateDate: "2026-10-04",
    habitualWeekday: "Ням",
    startTime: "10:00",
    endTime: "11:20",
    existingSlots: original,
    lockedThroughSequence: 6,
    cancelSlotId: byLesson(original, 7).id,
  });
  assertCompleteProgram(cancelledNoReplacement.slots, 10);
  assert.equal(cancelledNoReplacement.cancelledSlot.status, "cancelled");
  assert.equal(cancelledNoReplacement.cancelledSlot.cancelledLessonSequence, 7);
  assert.equal(cancelledNoReplacement.cancelledSlot.cancelledLessonTitle, "Туршилтын хичээл 07");
  assert.equal(byLesson(cancelledNoReplacement.slots, 7).localDate, "2026-11-22");
  assert.equal(byLesson(cancelledNoReplacement.slots, 10).localDate, "2026-12-13");
  assert.equal(cancelledNoReplacement.changedFutureLessonAssignments, 4);
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    assert.equal(byLesson(cancelledNoReplacement.slots, sequence).id, byLesson(original, sequence).id, "locked history stays unchanged");
  }

  const cancelledWithReplacement = reflowCancelledFutureSchedule({
    lessons: lessons(10, "reflow"),
    firstCandidateDate: "2026-10-04",
    habitualWeekday: "Ням",
    startTime: "10:00",
    endTime: "11:20",
    existingSlots: original,
    lockedThroughSequence: 6,
    cancelSlotId: byLesson(original, 7).id,
    replacementSlots: [{ id: "replacement-wed", localDate: "2026-11-18", startTime: "17:00", endTime: "18:20", reasonLabel: "Нөхөх хичээл" }],
  });
  assertCompleteProgram(cancelledWithReplacement.slots, 10);
  assert.equal(byLesson(cancelledWithReplacement.slots, 7).id, "replacement-wed");
  assert.equal(byLesson(cancelledWithReplacement.slots, 8).id, byLesson(original, 8).id, "later lessons remain assigned when a timely replacement exists");
  assert.equal(byLesson(cancelledWithReplacement.slots, 10).localDate, byLesson(original, 10).localDate);
  assert.equal(cancelledWithReplacement.changedFutureLessonAssignments, 1);

  console.log("ok calendar domain generation and reflow tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
