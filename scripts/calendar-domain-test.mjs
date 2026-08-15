import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { operationalDefaults } from "../src/config/operational-defaults.mjs";

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
  const { generateCalendarPlan, generateCalendarSchedule, reflowCancelledFutureSchedule } = await import(pathToFileURL(bundlePath).href);

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

  const intensiveLessons = lessons(12, "summer");
  const weekdays = generateCalendarSchedule({
    lessons: intensiveLessons,
    recurrenceKind: "weekdays",
    firstCandidateDate: "2027-06-01",
    lastCandidateDate: "2027-06-16",
    startTime: "10:00",
    endTime: "11:30",
  });
  assertCompleteProgram(weekdays, 12);
  assert.equal(byLesson(weekdays, 1).localDate, "2027-06-01");
  assert.equal(byLesson(weekdays, 12).localDate, "2027-06-16");
  assert.ok(active(weekdays).every((slot) => !["2027-06-05", "2027-06-06", "2027-06-12", "2027-06-13"].includes(slot.localDate)), "weekday recurrence excludes Mongolia-local weekends");
  assert.throws(() => generateCalendarSchedule({
    lessons: intensiveLessons,
    recurrenceKind: "weekdays",
    firstCandidateDate: "2027-06-01",
    lastCandidateDate: "2027-06-14",
    startTime: "10:00",
    endTime: "11:30",
  }), (error) => error.code === "insufficient_slots", "a hard summer period reports that the program does not fit");
  const daily = generateCalendarSchedule({
    lessons: intensiveLessons,
    recurrenceKind: "daily",
    firstCandidateDate: "2027-06-15",
    lastCandidateDate: "2027-06-26",
    startTime: "13:00",
    endTime: "14:30",
  });
  assert.deepEqual(active(daily).map((slot) => slot.localDate), Array.from({ length: 12 }, (_, index) => `2027-06-${String(index + 15).padStart(2, "0")}`), "daily recurrence preserves local civil dates without a UTC shift");

  for (const { excludeFromGeneration, warnOnOverlap } of [
    { excludeFromGeneration: true, warnOnOverlap: true },
    { excludeFromGeneration: true, warnOnOverlap: false },
    { excludeFromGeneration: false, warnOnOverlap: true },
    { excludeFromGeneration: false, warnOnOverlap: false },
  ]) {
    const period = { id: "winter", label: "Өвлийн амралт", startsOn: "2026-10-18", endsOn: "2026-10-18", excludeFromGeneration, warnOnOverlap };
    const input = { lessons: lessons(5, `school-${excludeFromGeneration}-${warnOnOverlap}`), recurrenceKind: "weekly", firstCandidateDate: "2026-10-04", habitualWeekday: "Ням", startTime: "10:00", endTime: "11:20", schoolCalendarPeriods: [period] };
    const initial = generateCalendarPlan(input);
    assert.equal(initial.slots.find((slot) => slot.localDate === "2026-10-18")?.status, excludeFromGeneration ? "no_class" : "scheduled", `initial generation follows only the exclusion flag (${excludeFromGeneration}/${warnOnOverlap})`);
    const finalPlan = generateCalendarPlan(excludeFromGeneration ? { ...input, overrides: [{ id: "restore", localDate: "2026-10-18", behavior: "restore" }] } : input);
    assert.equal(finalPlan.slots.find((slot) => slot.localDate === "2026-10-18")?.status, "scheduled", "a class may teach on a school-calendar date without changing the period");
    assert.equal(finalPlan.warnings.some((warning) => warning.label === "Өвлийн амралт"), warnOnOverlap, `final overlap warning follows only its own flag (${excludeFromGeneration}/${warnOnOverlap})`);
  }

  const realOperationalPeriods = operationalDefaults.schoolCalendarPeriods.map((period) => ({
    ...period, id: period.key, excludesHabitualSlots: true,
  }));
  const saturdayOperationalPlan = generateCalendarPlan({
    lessons: lessons(8, "real-autumn"), recurrenceKind: "weekly", firstCandidateDate: "2026-10-24", habitualWeekday: "Бямба", startTime: "10:00", endTime: "11:20",
    schoolCalendarPeriods: realOperationalPeriods,
  });
  assert.equal(saturdayOperationalPlan.slots.find((slot) => slot.localDate === "2026-10-24")?.status, "scheduled", "the autumn boundary leaves the preceding Saturday intact");
  assert.equal(saturdayOperationalPlan.slots.find((slot) => slot.localDate === "2026-10-31")?.status, "no_class", "the inclusive autumn boundary skips the first Saturday");
  assert.equal(saturdayOperationalPlan.slots.find((slot) => slot.localDate === "2026-11-07")?.status, "no_class", "the inclusive autumn boundary skips the final Saturday");
  assert.equal(saturdayOperationalPlan.slots.find((slot) => slot.localDate === "2026-11-14")?.status, "scheduled", "the Saturday after autumn guidance remains active");
  const decemberPlan = generateCalendarPlan({
    lessons: lessons(3, "real-winter"), recurrenceKind: "weekly", firstCandidateDate: "2026-12-21", habitualWeekday: "Даваа", startTime: "10:00", endTime: "11:20",
    schoolCalendarPeriods: realOperationalPeriods,
  });
  assert.equal(decemberPlan.slots.find((slot) => slot.localDate === "2026-12-21")?.status, "scheduled", "December 21 remains a teaching date before winter guidance begins");
  assert.equal(decemberPlan.slots.find((slot) => slot.localDate === "2026-12-28")?.status, "no_class", "winter guidance begins on December 26 and includes its boundary weekend");
  const republicPlan = generateCalendarPlan({
    lessons: lessons(3, "republic-day"), recurrenceKind: "weekly", firstCandidateDate: "2026-11-19", habitualWeekday: "Пүрэв", startTime: "10:00", endTime: "11:20",
    schoolCalendarPeriods: realOperationalPeriods,
  });
  assert.equal(republicPlan.slots.find((slot) => slot.localDate === "2026-11-26")?.status, "no_class", "Republic Day is an initial one-day exclusion");
  const restoredRepublicPlan = generateCalendarPlan({
    lessons: lessons(3, "republic-day-restore"), recurrenceKind: "weekly", firstCandidateDate: "2026-11-19", habitualWeekday: "Пүрэв", startTime: "10:00", endTime: "11:20",
    schoolCalendarPeriods: realOperationalPeriods, overrides: [{ id: "restore-republic", localDate: "2026-11-26", behavior: "restore" }],
  });
  assert.equal(restoredRepublicPlan.slots.find((slot) => slot.localDate === "2026-11-26")?.status, "scheduled", "a one-day national holiday is restorable for one class");
  assert.ok(restoredRepublicPlan.warnings.some((warning) => warning.label === "Бүгд Найрамдах Улс тунхагласан өдөр"), "a restored national holiday keeps its warning");

  const summerVacationWarning = generateCalendarPlan({
    lessons: lessons(2, "annual-tail"), recurrenceKind: "weekly", firstCandidateDate: "2027-05-26", habitualWeekday: "Лхагва", startTime: "10:00", endTime: "11:20",
    schoolCalendarPeriods: [{ id: "summer-vacation", label: "Зуны амралт", startsOn: "2027-06-01", endsOn: "2027-08-31", excludeFromGeneration: false, warnOnOverlap: true }],
  });
  assert.equal(byLesson(summerVacationWarning.slots, 2).localDate, "2027-06-02", "warn-only school summer vacation never removes an annual final lesson");
  assert.equal(summerVacationWarning.warnings[0]?.label, "Зуны амралт", "the annual June lesson receives a school-period warning");

  const offeringBreakPlan = generateCalendarPlan({
    lessons: lessons(14, "summer-break"), recurrenceKind: "daily", firstCandidateDate: "2027-06-01", plannedEndDate: "2027-06-14", startTime: "10:00", endTime: "11:30",
    offeringBreaks: [{ id: "course-break", label: "Сургалтын завсарлага", startsOn: "2027-06-07", endsOn: "2027-06-08" }],
  });
  assert.equal(byLesson(offeringBreakPlan.slots, 14).localDate, "2027-06-16", "an Offering break extends a daily summer plan past its soft advertised end");
  assert.equal(offeringBreakPlan.slots.filter((slot) => slot.localDate >= "2027-06-07" && slot.localDate <= "2027-06-08" && slot.status === "scheduled").length, 0, "an Offering break excludes every class candidate");
  assert.deepEqual(offeringBreakPlan.warnings.at(-1), { kind: "planned_period_overrun", label: "planned_period", finalLessonDate: "2027-06-16" }, "the summer overrun is a warning, not a hard failure");
  const secondClassPlan = generateCalendarPlan({
    lessons: lessons(14, "summer-break-b"), recurrenceKind: "daily", firstCandidateDate: "2027-06-01", plannedEndDate: "2027-06-14", startTime: "13:00", endTime: "14:30",
    offeringBreaks: [{ id: "course-break", label: "Сургалтын завсарлага", startsOn: "2027-06-07", endsOn: "2027-06-08" }],
    overrides: [{ id: "class-a-only", localDate: "2027-06-11", behavior: "exclude" }],
  });
  assert.equal(offeringBreakPlan.slots.find((slot) => slot.localDate === "2027-06-11")?.status, "scheduled", "the other class remains scheduled on its ordinary date");
  assert.equal(secondClassPlan.slots.find((slot) => slot.localDate === "2027-06-11")?.status, "no_class", "a class-specific exception changes only that class plan");

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
  assert.ok(holidays.filter((slot) => slot.status === "no_class").every((slot) => slot.lesson === null), "planned no-class dates neither own nor consume a curriculum lesson");
  assert.equal(holidays.find((slot) => slot.status === "scheduled")?.lesson?.sequenceNumber, 1, "the next active date receives Lesson 1 after a no-class date");
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

  assert.throws(() => reflowCancelledFutureSchedule({
    lessons: intensiveLessons,
    recurrenceKind: "daily",
    firstCandidateDate: "2027-06-15",
    lastCandidateDate: "2027-06-26",
    startTime: "13:00",
    endTime: "14:30",
    existingSlots: daily,
    lockedThroughSequence: 4,
    cancelSlotId: byLesson(daily, 5).id,
  }), (error) => error.code === "insufficient_slots", "a summer cancellation cannot silently extend beyond its hard period");

  console.log("ok calendar domain generation and reflow tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
