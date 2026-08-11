/**
 * Civil-date schedule planning for Asia/Ulaanbaatar. Teaching dates and times
 * remain separate local values: UTC is used only for calendar arithmetic, not
 * for interpreting a teaching instant.
 */

export type LocalDate = string;
export type LocalTime = string;
export type CalendarSlotStatus = "scheduled" | "no_class" | "cancelled";
export type CalendarSlotSource = "generated" | "manual_extra" | "manual_restore";
export type CalendarOverrideBehavior = "exclude" | "restore";

export interface ProgramLesson {
  id: string;
  sequenceNumber: number;
  title: string;
}

export interface AcademicYearBreak {
  id: string;
  label: string;
  startsOn: LocalDate;
  endsOn: LocalDate;
  excludesHabitualSlots: boolean;
}

export interface CalendarOverride {
  id: string;
  localDate: LocalDate;
  behavior: CalendarOverrideBehavior;
  reasonLabel?: string;
}

export interface ExtraTeachingSlot {
  id: string;
  localDate: LocalDate;
  startTime: LocalTime;
  endTime: LocalTime;
  reasonLabel?: string;
}

export interface CalendarSlot {
  id: string;
  localDate: LocalDate;
  startTime: LocalTime;
  endTime: LocalTime;
  slotSource: CalendarSlotSource;
  status: CalendarSlotStatus;
  lesson: ProgramLesson | null;
  cancelledLessonSequence: number | null;
  cancelledLessonTitle: string | null;
  reasonLabel: string | null;
}

export interface ScheduleGenerationInput {
  lessons: readonly ProgramLesson[];
  firstCandidateDate: LocalDate;
  habitualWeekday: string;
  startTime: LocalTime;
  endTime: LocalTime;
  breaks?: readonly AcademicYearBreak[];
  overrides?: readonly CalendarOverride[];
  extraSlots?: readonly ExtraTeachingSlot[];
}

export interface ScheduleReflowInput extends ScheduleGenerationInput {
  existingSlots: readonly CalendarSlot[];
  lockedThroughSequence: number;
  cancelSlotId: string;
  replacementSlots?: readonly ExtraTeachingSlot[];
}

export interface ScheduleReflowResult {
  slots: CalendarSlot[];
  cancelledSlot: CalendarSlot;
  nextLessonSlot: CalendarSlot | null;
  changedFutureLessonAssignments: number;
  newFinalLessonDate: LocalDate;
}

const millisecondsPerDay = 86_400_000;
const weekdayByName: Record<string, number> = {
  sunday: 0,
  "ням": 0,
  monday: 1,
  "даваа": 1,
  tuesday: 2,
  "мягмар": 2,
  wednesday: 3,
  "лхагва": 3,
  thursday: 4,
  "пүрэв": 4,
  friday: 5,
  "баасан": 5,
  saturday: 6,
  "бямба": 6,
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid calendar plan: ${message}`);
}

function dateParts(localDate: LocalDate): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  invariant(match, `invalid local date ${localDate}`);
  const [, year, month, day] = match;
  const parsed: [number, number, number] = [Number(year), Number(month), Number(day)];
  const probe = new Date(Date.UTC(parsed[0], parsed[1] - 1, parsed[2]));
  invariant(
    probe.getUTCFullYear() === parsed[0]
      && probe.getUTCMonth() === parsed[1] - 1
      && probe.getUTCDate() === parsed[2],
    `invalid local date ${localDate}`,
  );
  return parsed;
}

function dateOrdinal(localDate: LocalDate): number {
  const [year, month, day] = dateParts(localDate);
  return Date.UTC(year, month - 1, day) / millisecondsPerDay;
}

function dateFromOrdinal(ordinal: number): LocalDate {
  const value = new Date(ordinal * millisecondsPerDay);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function addDays(localDate: LocalDate, days: number): LocalDate {
  return dateFromOrdinal(dateOrdinal(localDate) + days);
}

function dayOfWeek(localDate: LocalDate): number {
  const [year, month, day] = dateParts(localDate);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function weekdayIndex(weekday: string): number {
  const normalized = weekday.trim().toLocaleLowerCase("mn-MN");
  const value = weekdayByName[normalized];
  invariant(value !== undefined, `unrecognized habitual weekday ${weekday}`);
  return value;
}

function nextHabitualDate(fromInclusive: LocalDate, weekday: string): LocalDate {
  const offset = (weekdayIndex(weekday) - dayOfWeek(fromInclusive) + 7) % 7;
  return addDays(fromInclusive, offset);
}

function strictNextHabitualDate(after: LocalDate, weekday: string): LocalDate {
  return nextHabitualDate(addDays(after, 1), weekday);
}

function compareSlots(left: CalendarSlot, right: CalendarSlot): number {
  return left.localDate.localeCompare(right.localDate)
    || left.startTime.localeCompare(right.startTime)
    || left.endTime.localeCompare(right.endTime)
    || left.id.localeCompare(right.id);
}

function isInBreak(localDate: LocalDate, periods: readonly AcademicYearBreak[]): AcademicYearBreak | undefined {
  return periods.find((period) => period.excludesHabitualSlots
    && period.startsOn <= localDate
    && localDate <= period.endsOn);
}

function normalizedLessons(lessons: readonly ProgramLesson[]): ProgramLesson[] {
  invariant(lessons.length > 0, "a program needs at least one lesson");
  const sorted = [...lessons].sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  sorted.forEach((lesson, index) => {
    invariant(lesson.id.trim().length > 0, "lesson ID is required");
    invariant(lesson.title.trim().length > 0, "lesson title is required");
    invariant(lesson.sequenceNumber === index + 1, "lesson sequence must be contiguous and start at 1");
  });
  return sorted;
}

function validateTime(value: LocalTime, field: string): void {
  invariant(/^\d{2}:\d{2}$/.test(value), `${field} must be HH:MM`);
}

function assertUniqueSlotTimes(slots: readonly CalendarSlot[]): void {
  const keys = new Set<string>();
  for (const slot of slots) {
    const key = `${slot.localDate}|${slot.startTime}|${slot.endTime}`;
    invariant(!keys.has(key), `duplicate teaching slot ${key}`);
    keys.add(key);
  }
}

function assertUniqueSlotIds(slots: readonly CalendarSlot[]): void {
  const ids = new Set<string>();
  for (const slot of slots) {
    invariant(!ids.has(slot.id), `duplicate calendar slot ID ${slot.id}`);
    ids.add(slot.id);
  }
}

function makeHabitualSlot(
  localDate: LocalDate,
  input: Pick<ScheduleGenerationInput, "startTime" | "endTime" | "breaks" | "overrides">,
): CalendarSlot {
  const override = (input.overrides ?? []).find((candidate) => candidate.localDate === localDate);
  const period = isInBreak(localDate, input.breaks ?? []);
  const restored = override?.behavior === "restore";
  const excluded = override?.behavior === "exclude" || (Boolean(period) && !restored);
  const reasonLabel = override?.reasonLabel ?? period?.label ?? null;

  return {
    id: `habitual:${localDate}:${input.startTime}`,
    localDate,
    startTime: input.startTime,
    endTime: input.endTime,
    slotSource: restored ? "manual_restore" : "generated",
    status: excluded ? "no_class" : "scheduled",
    lesson: null,
    cancelledLessonSequence: null,
    cancelledLessonTitle: null,
    reasonLabel,
  };
}

function validatePlanningInput(input: ScheduleGenerationInput): void {
  for (const period of input.breaks ?? []) {
    dateParts(period.startsOn);
    dateParts(period.endsOn);
    invariant(period.endsOn >= period.startsOn, `break ${period.id} ends before it starts`);
    invariant(period.label.trim().length > 0, `break ${period.id} needs a label`);
  }
  const overrideDates = new Set<string>();
  for (const override of input.overrides ?? []) {
    dateParts(override.localDate);
    invariant(!overrideDates.has(override.localDate), `duplicate class override on ${override.localDate}`);
    overrideDates.add(override.localDate);
  }
}

function makeExtraSlot(slot: ExtraTeachingSlot): CalendarSlot {
  dateParts(slot.localDate);
  validateTime(slot.startTime, "extra slot start time");
  validateTime(slot.endTime, "extra slot end time");
  invariant(slot.id.trim().length > 0, "extra slot ID is required");
  return {
    id: slot.id,
    localDate: slot.localDate,
    startTime: slot.startTime,
    endTime: slot.endTime,
    slotSource: "manual_extra",
    status: "scheduled",
    lesson: null,
    cancelledLessonSequence: null,
    cancelledLessonTitle: null,
    reasonLabel: slot.reasonLabel ?? null,
  };
}

function assignLessons(slots: CalendarSlot[], lessons: readonly ProgramLesson[]): CalendarSlot[] {
  const ordered = [...slots].sort(compareSlots);
  const active = ordered.filter((slot) => slot.status === "scheduled");
  invariant(active.length === lessons.length, "active teaching slots must exactly cover every program lesson");
  const assigned = new Map<string, ProgramLesson>();
  active.forEach((slot, index) => assigned.set(slot.id, lessons[index]));
  return ordered.map((slot) => slot.status === "scheduled"
    ? { ...slot, lesson: assigned.get(slot.id) ?? null }
    : { ...slot });
}

/**
 * Generates planning candidates until the program has enough active slots.
 * The returned explicit rows, not this weekly rule, are operational truth once
 * published.
 */
export function generateCalendarSchedule(input: ScheduleGenerationInput): CalendarSlot[] {
  const lessons = normalizedLessons(input.lessons);
  dateParts(input.firstCandidateDate);
  validateTime(input.startTime, "habitual start time");
  validateTime(input.endTime, "habitual end time");
  validatePlanningInput(input);
  const extras = [...(input.extraSlots ?? [])].map(makeExtraSlot).sort(compareSlots);
  const entries: CalendarSlot[] = [];
  let extraIndex = 0;
  let candidateDate = nextHabitualDate(input.firstCandidateDate, input.habitualWeekday);

  while (entries.filter((slot) => slot.status === "scheduled").length < lessons.length) {
    while (extraIndex < extras.length && extras[extraIndex].localDate <= candidateDate) {
      invariant(extras[extraIndex].localDate >= input.firstCandidateDate, "extra slots must not precede the first candidate date");
      entries.push(extras[extraIndex]);
      extraIndex += 1;
    }
    entries.push(makeHabitualSlot(candidateDate, input));
    assertUniqueSlotTimes(entries);
    candidateDate = addDays(candidateDate, 7);
  }

  const chronological = [...entries].sort(compareSlots);
  const scheduled = chronological.filter((slot) => slot.status === "scheduled");
  const finalScheduled = scheduled[lessons.length - 1];
  const neededScheduledIds = new Set(scheduled.slice(0, lessons.length).map((slot) => slot.id));
  const retained = chronological.filter((slot) => {
    if (slot.status === "scheduled") return neededScheduledIds.has(slot.id);
    return slot.localDate <= finalScheduled.localDate;
  });
  assertUniqueSlotIds(retained);
  assertUniqueSlotTimes(retained);
  return assignLessons(retained, lessons);
}

function cloneSlot(slot: CalendarSlot): CalendarSlot {
  return { ...slot, lesson: slot.lesson ? { ...slot.lesson } : null };
}

function validateExistingSchedule(slots: readonly CalendarSlot[], lessons: readonly ProgramLesson[], lockedThroughSequence: number): void {
  invariant(lockedThroughSequence >= 0 && Number.isInteger(lockedThroughSequence), "locked sequence must be a non-negative integer");
  assertUniqueSlotIds(slots);
  assertUniqueSlotTimes(slots);
  const active = slots.filter((slot) => slot.status === "scheduled");
  invariant(active.length === lessons.length, "existing schedule must assign every program lesson once");
  const lessonIds = new Set(lessons.map((lesson) => lesson.id));
  const seen = new Set<string>();
  for (const slot of active) {
    invariant(slot.lesson && lessonIds.has(slot.lesson.id), "scheduled slot has an invalid lesson");
    invariant(!seen.has(slot.lesson.id), "lesson is assigned more than once");
    seen.add(slot.lesson.id);
  }
  for (let sequence = 1; sequence <= lockedThroughSequence; sequence += 1) {
    const lock = active.find((slot) => slot.lesson?.sequenceNumber === sequence);
    invariant(lock, `locked lesson ${sequence} is not assigned`);
  }
}

function changedLessonCount(
  before: readonly CalendarSlot[],
  after: readonly CalendarSlot[],
  lockedThroughSequence: number,
  lessons: readonly ProgramLesson[],
): number {
  return lessons.filter((lesson) => lesson.sequenceNumber > lockedThroughSequence).filter((lesson) => {
    const oldSlot = before.find((slot) => slot.status === "scheduled" && slot.lesson?.id === lesson.id);
    const newSlot = after.find((slot) => slot.status === "scheduled" && slot.lesson?.id === lesson.id);
    return oldSlot?.id !== newSlot?.id;
  }).length;
}

/**
 * Creates the content for a new calendar revision after a future cancellation.
 * A lock is a manually confirmed delivered prefix; this service never infers
 * delivery from wall-clock time or rewrites that prefix.
 */
export function reflowCancelledFutureSchedule(input: ScheduleReflowInput): ScheduleReflowResult {
  const lessons = normalizedLessons(input.lessons);
  validatePlanningInput(input);
  const original = input.existingSlots.map(cloneSlot);
  validateExistingSchedule(original, lessons, input.lockedThroughSequence);
  const target = original.find((slot) => slot.id === input.cancelSlotId);
  invariant(target, `cancelled slot ${input.cancelSlotId} does not exist`);
  invariant(target.status === "scheduled" && target.lesson, "only an active scheduled slot can be cancelled");
  invariant(target.lesson.sequenceNumber > input.lockedThroughSequence, "locked lessons cannot be cancelled or reflowed");

  const cancelledSlot: CalendarSlot = {
    ...target,
    status: "cancelled",
    lesson: null,
    cancelledLessonSequence: target.lesson.sequenceNumber,
    cancelledLessonTitle: target.lesson.title,
  };
  let revised = original.map((slot) => slot.id === target.id ? cancelledSlot : cloneSlot(slot));
  const replacements = (input.replacementSlots ?? []).map(makeExtraSlot);
  assertUniqueSlotIds([...revised, ...replacements]);
  assertUniqueSlotTimes([...revised, ...replacements]);
  revised = [...revised, ...replacements];

  let activeCount = revised.filter((slot) => slot.status === "scheduled").length;
  invariant(activeCount <= lessons.length, "replacement slots exceed remaining program lessons");
  let tailDate = revised.reduce((latest, slot) => slot.localDate > latest ? slot.localDate : latest, input.firstCandidateDate);
  while (activeCount < lessons.length) {
    tailDate = strictNextHabitualDate(tailDate, input.habitualWeekday);
    const tail = makeHabitualSlot(tailDate, input);
    revised.push(tail);
    if (tail.status === "scheduled") activeCount += 1;
  }
  assertUniqueSlotIds(revised);
  assertUniqueSlotTimes(revised);

  const assigned = assignLessons(revised, lessons);
  for (const oldSlot of original) {
    if (oldSlot.status !== "scheduled" || !oldSlot.lesson || oldSlot.lesson.sequenceNumber > input.lockedThroughSequence) continue;
    const revisedSlot = assigned.find((slot) => slot.id === oldSlot.id);
    invariant(revisedSlot?.lesson?.id === oldSlot.lesson.id, "locked lesson assignment changed");
  }
  const nextLessonSlot = assigned
    .filter((slot) => slot.status === "scheduled" && (slot.lesson?.sequenceNumber ?? 0) > input.lockedThroughSequence)
    .sort(compareSlots)[0] ?? null;
  const finalLessonSlot = assigned.find((slot) => slot.status === "scheduled" && slot.lesson?.sequenceNumber === lessons.length);
  invariant(finalLessonSlot, "final lesson is missing after reflow");

  return {
    slots: assigned,
    cancelledSlot: assigned.find((slot) => slot.id === cancelledSlot.id) ?? cancelledSlot,
    nextLessonSlot,
    changedFutureLessonAssignments: changedLessonCount(original, assigned, input.lockedThroughSequence, lessons),
    newFinalLessonDate: finalLessonSlot.localDate,
  };
}
