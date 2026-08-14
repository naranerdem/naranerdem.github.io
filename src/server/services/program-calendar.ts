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
export type MeetingRecurrenceKind = "weekly" | "weekdays" | "daily";

export class SchedulePlanningError extends Error {
  constructor(public readonly code: "invalid" | "insufficient_slots", message: string) {
    super(`Invalid calendar plan: ${message}`);
    this.name = "SchedulePlanningError";
  }
}

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
  /** Whether routine candidate dates are omitted when a calendar is generated. */
  excludeFromGeneration?: boolean;
  /** Whether final teaching slots inside this period receive a teacher warning. */
  warnOnOverlap?: boolean;
  /** Compatibility data retained for records created before migration 0015. */
  excludesHabitualSlots?: boolean;
  generationBehavior?: SchoolCalendarGenerationBehavior;
}

export type SchoolCalendarGenerationBehavior = "exclude_by_default" | "warn_only";

export interface OfferingBreak {
  id: string;
  label: string;
  startsOn: LocalDate;
  endsOn: LocalDate;
}

export interface CalendarWarning {
  kind: "school_period_overlap" | "planned_period_overrun";
  label: string;
  lessonCount?: number;
  finalLessonDate?: LocalDate;
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
  recurrenceKind?: MeetingRecurrenceKind;
  habitualWeekday?: string;
  /** A true hard planning limit. Ordinary Offering periods do not use this. */
  lastCandidateDate?: LocalDate | null;
  /** An advertised/planned end date that may be exceeded with a warning. */
  plannedEndDate?: LocalDate | null;
  startTime: LocalTime;
  endTime: LocalTime;
  /** School periods guide annual draft generation and warn on final slots. */
  schoolCalendarPeriods?: readonly AcademicYearBreak[];
  /** A Naran Erdem no-class period shared by every class in one Offering. */
  offeringBreaks?: readonly OfferingBreak[];
  /** Compatibility input for existing callers; use schoolCalendarPeriods. */
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
  warnings: CalendarWarning[];
}

export interface ScheduleGenerationResult {
  slots: CalendarSlot[];
  warnings: CalendarWarning[];
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
  if (!condition) throw new SchedulePlanningError("invalid", message);
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

function nextWeekdayDate(fromInclusive: LocalDate): LocalDate {
  let candidate = fromInclusive;
  while ([0, 6].includes(dayOfWeek(candidate))) candidate = addDays(candidate, 1);
  return candidate;
}

function firstRuleDate(input: ScheduleGenerationInput): LocalDate {
  const recurrence = input.recurrenceKind ?? "weekly";
  if (recurrence === "weekly") {
    invariant(Boolean(input.habitualWeekday), "a weekly rule needs a weekday");
    return nextHabitualDate(input.firstCandidateDate, input.habitualWeekday as string);
  }
  if (recurrence === "weekdays") return nextWeekdayDate(input.firstCandidateDate);
  return input.firstCandidateDate;
}

function nextRuleDate(after: LocalDate, input: ScheduleGenerationInput): LocalDate {
  const recurrence = input.recurrenceKind ?? "weekly";
  if (recurrence === "weekly") {
    invariant(Boolean(input.habitualWeekday), "a weekly rule needs a weekday");
    return strictNextHabitualDate(after, input.habitualWeekday as string);
  }
  if (recurrence === "weekdays") return nextWeekdayDate(addDays(after, 1));
  return addDays(after, 1);
}

function compareSlots(left: CalendarSlot, right: CalendarSlot): number {
  return left.localDate.localeCompare(right.localDate)
    || left.startTime.localeCompare(right.startTime)
    || left.endTime.localeCompare(right.endTime)
    || left.id.localeCompare(right.id);
}

function excludesFromGeneration(period: AcademicYearBreak): boolean {
  if (typeof period.excludeFromGeneration === "boolean") return period.excludeFromGeneration;
  return period.generationBehavior
    ? period.generationBehavior === "exclude_by_default"
    : Boolean(period.excludesHabitualSlots);
}

function warnsOnOverlap(period: AcademicYearBreak): boolean {
  if (typeof period.warnOnOverlap === "boolean") return period.warnOnOverlap;
  // All pre-0015 behavior warned when a lesson overlapped a stored period.
  return true;
}

function isInSchoolExclusion(localDate: LocalDate, periods: readonly AcademicYearBreak[]): AcademicYearBreak | undefined {
  return periods.find((period) => excludesFromGeneration(period)
    && period.startsOn <= localDate
    && localDate <= period.endsOn);
}

function isInOfferingBreak(localDate: LocalDate, periods: readonly OfferingBreak[]): OfferingBreak | undefined {
  return periods.find((period) => period.startsOn <= localDate && localDate <= period.endsOn);
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
  invariant(/^([01]\d|2[0-3]):[0-5]\d$/.test(value), `${field} must be HH:MM`);
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
  input: Pick<ScheduleGenerationInput, "startTime" | "endTime" | "breaks" | "schoolCalendarPeriods" | "offeringBreaks" | "overrides">,
): CalendarSlot {
  const override = (input.overrides ?? []).find((candidate) => candidate.localDate === localDate);
  const schoolPeriod = isInSchoolExclusion(localDate, input.schoolCalendarPeriods ?? input.breaks ?? []);
  const offeringPeriod = isInOfferingBreak(localDate, input.offeringBreaks ?? []);
  // A class can restore a school-guidance date, but an Offering break applies
  // to every one of its classes and remains a no-class date.
  const restored = override?.behavior === "restore" && !offeringPeriod;
  const excluded = override?.behavior === "exclude" || (Boolean(schoolPeriod) && !restored) || Boolean(offeringPeriod);
  const reasonLabel = override?.reasonLabel ?? offeringPeriod?.label ?? schoolPeriod?.label ?? null;

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
  dateParts(input.firstCandidateDate);
  if (input.lastCandidateDate) {
    dateParts(input.lastCandidateDate);
    invariant(input.lastCandidateDate >= input.firstCandidateDate, "the class period ends before it starts");
  }
  if (input.plannedEndDate) {
    dateParts(input.plannedEndDate);
    invariant(input.plannedEndDate >= input.firstCandidateDate, "the planned class period ends before it starts");
  }
  invariant(["weekly", "weekdays", "daily"].includes(input.recurrenceKind ?? "weekly"), "unsupported meeting recurrence");
  for (const period of input.breaks ?? []) {
    dateParts(period.startsOn);
    dateParts(period.endsOn);
    invariant(period.endsOn >= period.startsOn, `break ${period.id} ends before it starts`);
    invariant(period.label.trim().length > 0, `break ${period.id} needs a label`);
  }
  for (const period of input.schoolCalendarPeriods ?? []) {
    dateParts(period.startsOn);
    dateParts(period.endsOn);
    invariant(period.endsOn >= period.startsOn, `school period ${period.id} ends before it starts`);
    invariant(period.label.trim().length > 0, `school period ${period.id} needs a label`);
    invariant(typeof period.excludeFromGeneration !== "undefined" || typeof period.excludesHabitualSlots !== "undefined" || Boolean(period.generationBehavior), `school period ${period.id} needs generation guidance`);
    invariant(typeof period.warnOnOverlap !== "undefined" || Boolean(period.generationBehavior) || typeof period.excludesHabitualSlots !== "undefined", `school period ${period.id} needs warning guidance`);
  }
  for (const period of input.offeringBreaks ?? []) {
    dateParts(period.startsOn);
    dateParts(period.endsOn);
    invariant(period.endsOn >= period.startsOn, `offering break ${period.id} ends before it starts`);
    invariant(period.label.trim().length > 0, `offering break ${period.id} needs a label`);
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
  invariant(slot.endTime > slot.startTime, "extra slot must end after it starts");
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
  return generateCalendarPlan(input).slots;
}

export function calendarWarnings(
  slots: readonly CalendarSlot[],
  input: Pick<ScheduleGenerationInput, "schoolCalendarPeriods" | "breaks" | "plannedEndDate">,
): CalendarWarning[] {
  const warnings: CalendarWarning[] = [];
  const scheduled = slots.filter((slot) => slot.status === "scheduled");
  for (const period of input.schoolCalendarPeriods ?? input.breaks ?? []) {
    if (!warnsOnOverlap(period)) continue;
    const lessonCount = scheduled.filter((slot) => period.startsOn <= slot.localDate && slot.localDate <= period.endsOn).length;
    if (lessonCount) warnings.push({ kind: "school_period_overlap", label: period.label, lessonCount });
  }
  const finalLessonDate = scheduled.at(-1)?.localDate;
  if (input.plannedEndDate && finalLessonDate && finalLessonDate > input.plannedEndDate) {
    warnings.push({ kind: "planned_period_overrun", label: "planned_period", finalLessonDate });
  }
  return warnings;
}

/**
 * Generates planning candidates until the program has enough active slots.
 * `plannedEndDate` is deliberately soft: an explicit warning records an
 * overrun rather than deleting or blocking valid lesson dates.
 */
export function generateCalendarPlan(input: ScheduleGenerationInput): ScheduleGenerationResult {
  const lessons = normalizedLessons(input.lessons);
  dateParts(input.firstCandidateDate);
  validateTime(input.startTime, "habitual start time");
  validateTime(input.endTime, "habitual end time");
  invariant(input.endTime > input.startTime, "habitual meeting must end after it starts");
  validatePlanningInput(input);
  const extras = [...(input.extraSlots ?? [])].map(makeExtraSlot).sort(compareSlots);
  for (const extra of extras) {
    invariant(extra.localDate >= input.firstCandidateDate, "extra slots must not precede the first candidate date");
    invariant(!input.lastCandidateDate || extra.localDate <= input.lastCandidateDate, "extra slots must remain inside the class period");
  }
  const entries: CalendarSlot[] = [];
  let extraIndex = 0;
  let candidateDate = firstRuleDate(input);

  while (entries.filter((slot) => slot.status === "scheduled").length < lessons.length) {
    while (extraIndex < extras.length && extras[extraIndex].localDate <= candidateDate) {
      entries.push(extras[extraIndex]);
      extraIndex += 1;
    }
    if (input.lastCandidateDate && candidateDate > input.lastCandidateDate) {
      if (entries.filter((slot) => slot.status === "scheduled").length < lessons.length) {
        throw new SchedulePlanningError("insufficient_slots", "the program does not fit the configured class period");
      }
      break;
    }
    entries.push(makeHabitualSlot(candidateDate, input));
    assertUniqueSlotTimes(entries);
    candidateDate = nextRuleDate(candidateDate, input);
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
  const slots = assignLessons(retained, lessons);
  return { slots, warnings: calendarWarnings(slots, input) };
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
 * The protected prefix is supplied by the caller. It combines any stored
 * historical protection with past published dates; it is not a claim that a
 * lesson was attended or delivered.
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
  for (const replacement of replacements) {
    invariant(replacement.localDate >= input.firstCandidateDate, "replacement slots must not precede the class period");
    invariant(!input.lastCandidateDate || replacement.localDate <= input.lastCandidateDate, "replacement slots must remain inside the class period");
  }
  assertUniqueSlotIds([...revised, ...replacements]);
  assertUniqueSlotTimes([...revised, ...replacements]);
  revised = [...revised, ...replacements];

  let activeCount = revised.filter((slot) => slot.status === "scheduled").length;
  invariant(activeCount <= lessons.length, "replacement slots exceed remaining program lessons");
  let tailDate = revised.reduce((latest, slot) => slot.localDate > latest ? slot.localDate : latest, input.firstCandidateDate);
  while (activeCount < lessons.length) {
    tailDate = nextRuleDate(tailDate, input);
    if (input.lastCandidateDate && tailDate > input.lastCandidateDate) {
      throw new SchedulePlanningError("insufficient_slots", "the program no longer fits the configured class period");
    }
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
    warnings: calendarWarnings(assigned, input),
  };
}
