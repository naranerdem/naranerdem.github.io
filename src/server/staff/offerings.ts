import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { getAnnualCourseStartDefault } from "./annual-course-start-default";
import { annualStartDateForToday, ensureAnnualAcademicYearShell } from "./academic-year-shell";

export const OFFERING_KINDS = ["annual_course", "summer_course", "event"] as const;
export const CHARGE_MODES = ["free", "paid"] as const;
export type OfferingKind = typeof OFFERING_KINDS[number];
export type ChargeMode = typeof CHARGE_MODES[number];

export class OfferingError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "immutable" | "referenced" | "academic_year_unconfigured") {
    super("Offering operation failed.");
    this.name = "OfferingError";
  }
}

interface OfferingRow {
  id: string;
  kind: OfferingKind;
  title: string;
  academicYearId: string | null;
  stageCode: "stage_1" | "stage_2" | "stage_3" | null;
  levelLabel: string | null;
  startsOn: string | null;
  endsOn: string | null;
  curriculumProgramId: string | null;
  useAcademicYearBreaks: number;
  chargeMode: ChargeMode;
  defaultClassDurationMinutes: number | null;
  facebookGroupUrl: string | null;
  note: string | null;
  status: "active" | "archived";
  isTest: number;
  testRunId: string | null;
  updatedAt: string;
}

interface EventOccurrenceRow {
  id: string;
  offeringId: string;
  localDate: string;
  startTime: string;
  endTime: string;
  capacity: number;
  registrationStatus: "closed" | "open" | "cancelled";
  isTest: number;
  testRunId: string | null;
  updatedAt: string;
}

interface ProgramContextRow {
  id: string;
  programFamilyId: string;
  academicYearId: string;
  stageCode: "stage_1" | "stage_2" | "stage_3";
  programKind: "annual_course" | "summer_course";
  status: "draft" | "published" | "superseded" | "archived";
  displayName: string;
  yearLabel: string;
  yearStartsOn: string | null;
  yearEndsOn: string | null;
  isTest: number;
  testRunId: string | null;
}

export interface OfferingSaveInput {
  id?: string;
  expectedUpdatedAt?: string;
  eventExpectedUpdatedAt?: string;
  kind: string;
  title?: string;
  academicYearId?: string | null;
  stageCode?: string | null;
  levelLabel?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  curriculumProgramId?: string | null;
  programFamilyId?: string | null;
  annualStageCode?: string | null;
  useAcademicYearBreaks?: boolean;
  chargeMode?: string;
  facebookGroupUrl?: string | null;
  note?: string | null;
  eventDate?: string | null;
  eventStartTime?: string | null;
  eventEndTime?: string | null;
  eventCapacity?: number;
  eventRegistrationOpen?: boolean;
  defaultClassDurationMinutes?: number;
  initialClasses?: Array<{
    recurrenceKind?: string;
    weeklyWeekday?: string | null;
    startTime?: string;
    capacity?: number;
  }>;
}

function requireManage(actor: StaffPrincipal): void {
  if (!hasStaffCapability(actor, "program.manage") || !hasStaffCapability(actor, "calendar.manage")) {
    throw new OfferingError("forbidden");
  }
}

function id(): string { return crypto.randomUUID(); }
function now(): string { return new Date().toISOString(); }
function text(value: unknown, max = 160): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function optionalText(value: unknown, max = 500): string | null { return text(value, max) || null; }
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validTime(value: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function addMinutes(startTime: string, minutes: number): string {
  const [hours, mins] = startTime.split(":").map(Number);
  const total = hours * 60 + mins + minutes;
  if (total >= 24 * 60) throw new OfferingError("invalid");
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function validUrl(value: string | null): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
function stageLabel(stage: string): string {
  return ({ stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" } as Record<string, string>)[stage] ?? stage;
}
function defaultCharge(kind: OfferingKind): ChargeMode { return kind === "event" ? "free" : "paid"; }
function defaultBreakPolicy(kind: OfferingKind): boolean { return kind === "annual_course"; }
function defaultDuration(kind: OfferingKind, stageCode: string | null): number | null {
  if (kind === "event") return null;
  return kind === "annual_course" && stageCode === "stage_3" ? 105 : 80;
}
function flags(env: WorkerEnv, source?: { isTest: number; testRunId: string | null }) {
  if (source) return { isTest: source.isTest, testRunId: source.testRunId };
  return env.APP_ENV === "staging" ? { isTest: 1, testRunId: "staff-offering" } : { isTest: 0, testRunId: null };
}
function audit(
  env: WorkerEnv,
  actor: StaffPrincipal,
  action: string,
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  provenance: { isTest: number; testRunId: string | null },
  occurredAt: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id(), occurredAt, actor.staffAccountId, action, subjectType, subjectId,
    JSON.stringify(metadata), env.APP_ENV, provenance.isTest, provenance.testRunId, occurredAt,
  );
}

async function offeringById(env: WorkerEnv, offeringId: string): Promise<OfferingRow> {
  const row = await env.DB.prepare(`SELECT id, kind, title, academic_year_id AS academicYearId,
    stage_code AS stageCode, level_label AS levelLabel, starts_on AS startsOn, ends_on AS endsOn,
    curriculum_program_id AS curriculumProgramId, use_academic_year_breaks AS useAcademicYearBreaks,
    charge_mode AS chargeMode, facebook_group_url AS facebookGroupUrl, note, status,
    default_class_duration_minutes AS defaultClassDurationMinutes,
    is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
    FROM activity_offering WHERE id = ?`).bind(offeringId).first<OfferingRow>();
  if (!row) throw new OfferingError("not_found");
  return row;
}

async function programById(env: WorkerEnv, programId: string): Promise<ProgramContextRow> {
  const row = await env.DB.prepare(`SELECT program.id, program.program_family_id AS programFamilyId,
    program.academic_year_id AS academicYearId,
    program.stage_code AS stageCode, program.program_kind AS programKind, program.status,
    program.display_name AS displayName, year.public_label AS yearLabel,
    year.starts_on AS yearStartsOn, year.ends_on AS yearEndsOn,
    program.is_test AS isTest, program.test_run_id AS testRunId
    FROM curriculum_program AS program
    INNER JOIN academic_year AS year ON year.id = program.academic_year_id
    WHERE program.id = ?`).bind(programId).first<ProgramContextRow>();
  if (!row) throw new OfferingError("not_found");
  return row;
}

async function currentProgramForFamily(
  env: WorkerEnv,
  kind: "annual_course" | "summer_course",
  familyId: string,
  annualStageCode?: string | null,
): Promise<ProgramContextRow> {
  if (!familyId) throw new OfferingError("invalid");
  const program = await env.DB.prepare(`SELECT program.id, program.program_family_id AS programFamilyId,
    program.academic_year_id AS academicYearId, program.stage_code AS stageCode,
    program.program_kind AS programKind, program.status, program.display_name AS displayName,
    year.public_label AS yearLabel, year.starts_on AS yearStartsOn, year.ends_on AS yearEndsOn,
    program.is_test AS isTest, program.test_run_id AS testRunId
    FROM curriculum_program_family AS family
    INNER JOIN curriculum_program AS program ON program.id = family.current_published_program_id
    INNER JOIN academic_year AS year ON year.id = program.academic_year_id
    WHERE family.id = ? AND family.kind = ? AND family.status = 'active'
      AND (? IS NULL OR family.annual_stage_code = ?)`).bind(familyId, kind, annualStageCode ?? null, annualStageCode ?? null).first<ProgramContextRow>();
  if (!program || program.status !== "published" || program.programKind !== kind) throw new OfferingError("invalid");
  return program;
}

async function currentAnnualProgramForStage(env: WorkerEnv, stageCode: string): Promise<ProgramContextRow> {
  if (!(["stage_1", "stage_2", "stage_3"] as const).includes(stageCode as "stage_1" | "stage_2" | "stage_3")) throw new OfferingError("invalid");
  const family = await env.DB.prepare(`SELECT id FROM curriculum_program_family
    WHERE kind = 'annual_course' AND annual_stage_code = ? AND status = 'active'`).bind(stageCode).first<{ id: string }>();
  if (!family) throw new OfferingError("invalid");
  return currentProgramForFamily(env, "annual_course", family.id, stageCode);
}

async function academicYearForAnnualOffering(
  env: WorkerEnv,
  startsOn: string,
  provenance: { isTest: number; testRunId: string | null },
): Promise<{ id: string; label: string; endsOn: string; created: boolean }> {
  try {
    const resolved = await ensureAnnualAcademicYearShell(env, startsOn, provenance);
    return { id: resolved.year.id, label: resolved.year.label, endsOn: resolved.year.endsOn, created: resolved.created };
  } catch {
    throw new OfferingError("invalid");
  }
}

async function defaultAnnualStartDate(env: WorkerEnv): Promise<string> {
  const [setting, year] = await Promise.all([
    getAnnualCourseStartDefault(env),
    env.DB.prepare(`SELECT starts_on AS startsOn FROM academic_year
      WHERE starts_on IS NOT NULL AND ends_on IS NOT NULL
      ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ startsOn: string }>(),
  ]);
  const date = year?.startsOn
    ? `${year.startsOn.slice(0, 4)}-${String(setting.month).padStart(2, "0")}-${String(setting.day).padStart(2, "0")}`
    : annualStartDateForToday(setting.month, setting.day);
  if (!validDate(date)) throw new OfferingError("invalid");
  return date;
}

async function eventForOffering(env: WorkerEnv, offeringId: string): Promise<EventOccurrenceRow | null> {
  return env.DB.prepare(`SELECT id, activity_offering_id AS offeringId, local_date AS localDate,
    start_time AS startTime, end_time AS endTime, capacity,
    registration_status AS registrationStatus, is_test AS isTest,
    test_run_id AS testRunId, updated_at AS updatedAt
    FROM offering_event_occurrence WHERE activity_offering_id = ?
    ORDER BY local_date, start_time LIMIT 1`).bind(offeringId).first<EventOccurrenceRow>();
}

async function offeringHasCalendar(env: WorkerEnv, offeringId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT CASE WHEN
    EXISTS (
      SELECT 1 FROM class_session
      INNER JOIN class_calendar ON class_calendar.class_session_id = class_session.id
      INNER JOIN class_calendar_revision ON class_calendar_revision.class_calendar_id = class_calendar.id
      WHERE class_session.activity_offering_id = ?
    )
    THEN 1 ELSE 0 END AS found`).bind(offeringId).first<{ found: number }>();
  return row?.found === 1;
}

async function offeringRegistrationOpen(env: WorkerEnv, offeringId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT CASE WHEN
    EXISTS (SELECT 1 FROM class_session WHERE activity_offering_id = ? AND status IN ('available', 'full'))
    OR EXISTS (SELECT 1 FROM offering_event_occurrence WHERE activity_offering_id = ? AND registration_status = 'open')
    THEN 1 ELSE 0 END AS found`).bind(offeringId, offeringId).first<{ found: number }>();
  return row?.found === 1;
}

async function offeringHasRegistrationReferences(env: WorkerEnv, offeringId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT CASE WHEN
    EXISTS (
      SELECT 1 FROM class_session INNER JOIN enrollment ON enrollment.class_session_id = class_session.id
      WHERE class_session.activity_offering_id = ?
    )
    OR EXISTS (
      SELECT 1 FROM class_session INNER JOIN application_child ON application_child.selected_class_session_id = class_session.id
      WHERE class_session.activity_offering_id = ?
    )
    OR EXISTS (
      SELECT 1 FROM class_session INNER JOIN waitlist_entry ON waitlist_entry.class_session_id = class_session.id
      WHERE class_session.activity_offering_id = ?
    )
    OR EXISTS (
      SELECT 1 FROM class_session INNER JOIN registration_capacity_hold ON registration_capacity_hold.class_session_id = class_session.id
      WHERE class_session.activity_offering_id = ?
    )
    THEN 1 ELSE 0 END AS found`).bind(offeringId, offeringId, offeringId, offeringId).first<{ found: number }>();
  return row?.found === 1;
}

type InitialClass = {
  recurrenceKind: "weekly" | "weekdays" | "daily";
  weeklyWeekday: string | null;
  startTime: string;
  capacity: number;
};

function initialClasses(input: OfferingSaveInput, kind: "annual_course" | "summer_course"): InitialClass[] {
  if (input.initialClasses === undefined) return [];
  if (!Array.isArray(input.initialClasses) || input.initialClasses.length > 12) throw new OfferingError("invalid");
  return input.initialClasses.map((entry) => {
    const recurrenceKind = text(entry?.recurrenceKind, 20) || (kind === "summer_course" ? "daily" : "weekly");
    const weeklyWeekday = recurrenceKind === "weekly" ? text(entry?.weeklyWeekday, 20) : null;
    const startTime = text(entry?.startTime, 5);
    const capacity = Number(entry?.capacity);
    if (!(["weekly", "weekdays", "daily"] as const).includes(recurrenceKind as InitialClass["recurrenceKind"])
      || (recurrenceKind === "weekly" && !["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"].includes(weeklyWeekday ?? ""))
      || !validTime(startTime) || !Number.isInteger(capacity) || capacity < 1 || capacity > 80) {
      throw new OfferingError("invalid");
    }
    return { recurrenceKind: recurrenceKind as InitialClass["recurrenceKind"], weeklyWeekday, startTime, capacity };
  });
}

function classLabel(
  kind: "annual_course" | "summer_course",
  stageCode: string,
  firstDate: string,
  lastDate: string | null,
  recurrenceKind: InitialClass["recurrenceKind"],
  weeklyWeekday: string | null,
  startTime: string,
  endTime: string,
): string {
  if (kind === "summer_course") {
    const short = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
    return `${short(firstDate)}${lastDate ? `–${short(lastDate)}` : ""} · ${startTime}–${endTime}`;
  }
  const weekday = recurrenceKind === "weekly" ? weeklyWeekday : recurrenceKind === "weekdays" ? "Ажлын өдөр" : "Өдөр бүр";
  return `${stageLabel(stageCode)} · ${weekday} ${startTime}–${endTime}`;
}

function initialClassStatements(
  env: WorkerEnv,
  actor: StaffPrincipal,
  offering: { id: string; kind: "annual_course" | "summer_course"; academicYearId: string; stageCode: string; startsOn: string; endsOn: string | null },
  classes: readonly InitialClass[],
  duration: number,
  provenance: { isTest: number; testRunId: string | null },
  time: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const entry of classes) {
    const classId = id();
    const endTime = addMinutes(entry.startTime, duration);
    const lastDate = offering.kind === "summer_course" ? offering.endsOn : null;
    const weekday = entry.recurrenceKind === "weekly"
      ? entry.weeklyWeekday as string
      : `${entry.recurrenceKind === "weekdays" ? "Ажлын өдөр" : "Өдөр бүр"} ${Number(offering.startsOn.slice(5, 7))}/${Number(offering.startsOn.slice(8, 10))}`;
    statements.push(
      env.DB.prepare(`INSERT INTO class_session (id, academic_year_id, stage_code, display_label,
        weekday, start_time, end_time, capacity, status, facebook_group_url,
        is_test_only, is_test, test_run_id, created_at, updated_at, activity_offering_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'closed', NULL, ?, ?, ?, ?, ?, ?)`).bind(
        classId, offering.academicYearId, offering.stageCode,
        classLabel(offering.kind, offering.stageCode, offering.startsOn, lastDate, entry.recurrenceKind, entry.weeklyWeekday, entry.startTime, endTime),
        weekday, entry.startTime, endTime, entry.capacity,
        provenance.isTest, provenance.isTest, provenance.testRunId, time, time, offering.id,
      ),
      env.DB.prepare(`INSERT INTO class_meeting_rule (
        class_session_id, recurrence_kind, first_date, last_date, weekly_weekday,
        start_time, end_time, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        classId, entry.recurrenceKind, offering.startsOn, lastDate, entry.weeklyWeekday,
        entry.startTime, endTime, time, time,
      ),
      audit(env, actor, "class_session_created", "class_session", classId, {
        offeringId: offering.id, recurrenceKind: entry.recurrenceKind, registrationOpen: false,
      }, provenance, time),
    );
  }
  return statements;
}

export async function getOfferingOverview(env: WorkerEnv): Promise<{
  offerings: Array<Record<string, unknown>>;
  eventOccurrences: Array<Record<string, unknown>>;
  offeringBreaks: Array<Record<string, unknown>>;
}> {
  const [offerings, occurrences, offeringBreaks] = await Promise.all([
    env.DB.prepare(`SELECT offering.id, offering.kind, offering.title,
      offering.academic_year_id AS academicYearId, offering.stage_code AS stageCode,
      offering.level_label AS levelLabel, offering.starts_on AS startsOn, offering.ends_on AS endsOn,
      offering.curriculum_program_id AS curriculumProgramId,
      program.display_name AS programName, program.status AS programStatus,
      program.program_kind AS programKind, year.public_label AS academicYearLabel,
      family.id AS programFamilyId, family.display_name AS programFamilyName,
      offering.use_academic_year_breaks AS useAcademicYearBreaks,
      offering.charge_mode AS chargeMode, offering.facebook_group_url AS facebookGroupUrl,
      offering.default_class_duration_minutes AS defaultClassDurationMinutes,
      pricing.one_time_amount_mnt AS oneTimeAmountMnt,
      pricing.two_installment_enabled AS twoInstallmentEnabled,
      pricing.first_installment_amount_mnt AS firstInstallmentAmountMnt,
      pricing.second_installment_amount_mnt AS secondInstallmentAmountMnt,
      pricing.second_installment_due_on AS secondInstallmentDueOn,
      pricing.updated_at AS pricingUpdatedAt,
      offering.note, offering.status, offering.is_test AS isTest,
      offering.test_run_id AS testRunId, offering.updated_at AS updatedAt
      FROM activity_offering AS offering
      LEFT JOIN curriculum_program AS program ON program.id = offering.curriculum_program_id
      LEFT JOIN curriculum_program_family AS family ON family.id = program.program_family_id
      LEFT JOIN academic_year AS year ON year.id = offering.academic_year_id
      LEFT JOIN offering_course_pricing AS pricing ON pricing.activity_offering_id = offering.id
      WHERE offering.status = 'active'
      ORDER BY offering.starts_on DESC, offering.kind, offering.title`).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id, activity_offering_id AS offeringId, local_date AS localDate,
      start_time AS startTime, end_time AS endTime, capacity,
      registration_status AS registrationStatus, is_test AS isTest,
      test_run_id AS testRunId, updated_at AS updatedAt
      FROM offering_event_occurrence ORDER BY local_date, start_time`).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id, activity_offering_id AS offeringId, label,
      starts_on AS startsOn, ends_on AS endsOn, note, is_test AS isTest,
      test_run_id AS testRunId, updated_at AS updatedAt
      FROM activity_offering_break ORDER BY activity_offering_id, starts_on, ends_on`).all<Record<string, unknown>>(),
  ]);
  return {
    offerings: await Promise.all(offerings.results.map(async (entry) => ({
      ...entry,
      useAcademicYearBreaks: Boolean(entry.useAcademicYearBreaks),
      twoInstallmentEnabled: Boolean(entry.twoInstallmentEnabled),
      canDelete: entry.kind === "event" ? false : await unusedCourseOffering(env, String(entry.id)),
    }))),
    eventOccurrences: occurrences.results.map((entry) => ({
      ...entry,
      registrationOpen: entry.registrationStatus === "open",
    })),
    offeringBreaks: offeringBreaks.results,
  };
}

async function unusedCourseOffering(env: WorkerEnv, offeringId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT CASE WHEN
    EXISTS (SELECT 1 FROM registration_window_offering WHERE activity_offering_id = ?)
    OR EXISTS (
      SELECT 1 FROM class_session AS class_row
      WHERE class_row.activity_offering_id = ? AND (
        EXISTS (SELECT 1 FROM enrollment WHERE class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM application_child WHERE selected_class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM waitlist_entry WHERE class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM registration_draft_child WHERE selected_class_session_id = class_row.id OR preferred_waitlist_class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM registration_capacity_hold WHERE class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM registration_draft_waitlist_entry WHERE class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM waitlist_seat_offer WHERE class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM course_attendance WHERE class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM course_absence_notice WHERE class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM course_makeup_resolution WHERE source_class_session_id = class_row.id)
        OR EXISTS (SELECT 1 FROM course_makeup_assignment WHERE target_class_session_id = class_row.id)
      )
    )
    THEN 0 ELSE 1 END AS unused`).bind(offeringId, offeringId).first<{ unused: number }>();
  return row?.unused === 1;
}

export async function saveActivityOffering(env: WorkerEnv, actor: StaffPrincipal, input: OfferingSaveInput): Promise<void> {
  requireManage(actor);
  const kind = text(input.kind) as OfferingKind;
  if (!OFFERING_KINDS.includes(kind)) throw new OfferingError("invalid");
  const requestedChargeMode = text(input.chargeMode);
  if (kind !== "event" && requestedChargeMode && requestedChargeMode !== "paid") throw new OfferingError("invalid");
  const chargeMode = (kind === "event" ? (requestedChargeMode || defaultCharge(kind)) : "paid") as ChargeMode;
  const facebookGroupUrl = optionalText(input.facebookGroupUrl);
  const note = optionalText(input.note, 1000);
  if (!CHARGE_MODES.includes(chargeMode) || !validUrl(facebookGroupUrl)) throw new OfferingError("invalid");

  if (!input.id) {
    const offeringId = id();
    const time = now();
    const provenance = flags(env);
    if (kind === "event") {
      const title = text(input.title);
      const localDate = text(input.eventDate ?? input.startsOn);
      const startTime = text(input.eventStartTime);
      const endTime = text(input.eventEndTime);
      const capacity = Number(input.eventCapacity);
      if (!title || !validDate(localDate) || !validTime(startTime) || !validTime(endTime)
        || startTime >= endTime || !Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new OfferingError("invalid");
      const occurrenceId = id();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO activity_offering (
          id, kind, title, academic_year_id, stage_code, level_label, starts_on, ends_on,
          curriculum_program_id, use_academic_year_breaks, charge_mode, facebook_group_url,
          note, status, is_test, test_run_id, created_at, updated_at
        ) VALUES (?, 'event', ?, NULL, NULL, NULL, ?, ?, NULL, 0, ?, ?, ?, 'active', ?, ?, ?, ?)`)
          .bind(offeringId, title, localDate, localDate, chargeMode, facebookGroupUrl, note, provenance.isTest, provenance.testRunId, time, time),
        env.DB.prepare(`INSERT INTO offering_event_occurrence (
          id, activity_offering_id, local_date, start_time, end_time, capacity,
          registration_status, is_test, test_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?)`)
          .bind(occurrenceId, offeringId, localDate, startTime, endTime, capacity, provenance.isTest, provenance.testRunId, time, time),
        audit(env, actor, "activity_offering_created", "activity_offering", offeringId, { kind, chargeMode, registrationOpen: false }, provenance, time),
      ]);
      return;
    }

    const startsOn = kind === "annual_course"
      ? (optionalText(input.startsOn, 10) || await defaultAnnualStartDate(env))
      : optionalText(input.startsOn, 10);
    if (!startsOn || !validDate(startsOn)) throw new OfferingError("invalid");
    const program = kind === "annual_course"
      ? await currentAnnualProgramForStage(env, text(input.annualStageCode, 30))
      : await currentProgramForFamily(env, "summer_course", text(input.programFamilyId, 100));
    const sourceFlags = flags(env, program);
    const annualYear = kind === "annual_course" ? await academicYearForAnnualOffering(env, startsOn, sourceFlags) : null;
    const endsOn = kind === "annual_course" ? annualYear?.endsOn ?? null : optionalText(input.endsOn, 10);
    if (!endsOn || !validDate(endsOn) || endsOn < startsOn) throw new OfferingError("invalid");
    const title = kind === "annual_course"
      ? `${annualYear?.label} · ${stageLabel(program.stageCode)}`
      : text(input.title);
    const duration = Number(input.defaultClassDurationMinutes ?? defaultDuration(kind, kind === "annual_course" ? program.stageCode : null));
    if (!Number.isInteger(duration) || duration < 15 || duration > 360) throw new OfferingError("invalid");
    const classes = initialClasses(input, kind);
    if (!title) throw new OfferingError("invalid");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_offering (
        id, kind, title, academic_year_id, stage_code, level_label, starts_on, ends_on,
        curriculum_program_id, use_academic_year_breaks, charge_mode, facebook_group_url,
        default_class_duration_minutes,
        note, status, is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .bind(offeringId, kind, title, annualYear?.id ?? program.academicYearId, kind === "annual_course" ? program.stageCode : null, null,
          startsOn, endsOn, program.id,
          defaultBreakPolicy(kind) ? 1 : 0,
          chargeMode, facebookGroupUrl, duration, note, sourceFlags.isTest, sourceFlags.testRunId, time, time),
      audit(env, actor, "activity_offering_created", "activity_offering", offeringId, {
        kind, chargeMode, useAcademicYearBreaks: defaultBreakPolicy(kind),
        programId: program.id, defaultClassDurationMinutes: duration, initialClassCount: classes.length,
      }, sourceFlags, time),
      ...(annualYear?.created ? [audit(env, actor, "academic_year_shell_created", "academic_year", annualYear.id, {
        startsOn, createdForAnnualOffering: offeringId,
      }, sourceFlags, time)] : []),
      ...initialClassStatements(env, actor, {
        id: offeringId,
        kind,
        academicYearId: annualYear?.id ?? program.academicYearId,
        stageCode: kind === "annual_course" ? program.stageCode : "stage_1",
        startsOn,
        endsOn,
      }, classes, duration, sourceFlags, time),
    ]);
    return;
  }

  const current = await offeringById(env, input.id);
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new OfferingError("conflict");
  if (kind !== current.kind) throw new OfferingError("immutable");
  const time = now();
  const provenance = flags(env, current);

  if (current.kind === "event") {
    const occurrence = await eventForOffering(env, current.id);
    if (!occurrence || !input.eventExpectedUpdatedAt || occurrence.updatedAt !== input.eventExpectedUpdatedAt) throw new OfferingError("conflict");
    const title = text(input.title);
    const localDate = text(input.eventDate);
    const startTime = text(input.eventStartTime);
    const endTime = text(input.eventEndTime);
    const capacity = Number(input.eventCapacity);
    const registrationOpen = Boolean(input.eventRegistrationOpen);
    if (!title || !validDate(localDate) || !validTime(startTime) || !validTime(endTime) || startTime >= endTime
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new OfferingError("invalid");
    const structuralChange = occurrence.localDate !== localDate || occurrence.startTime !== startTime
      || occurrence.endTime !== endTime || occurrence.capacity !== capacity;
    if (occurrence.registrationStatus === "open" && (structuralChange || chargeMode !== current.chargeMode)) throw new OfferingError("immutable");
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE activity_offering SET title = ?, starts_on = ?, ends_on = ?,
        charge_mode = ?, facebook_group_url = ?, note = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?`)
        .bind(title, localDate, localDate, chargeMode, facebookGroupUrl, note, time, current.id, input.expectedUpdatedAt),
      env.DB.prepare(`UPDATE offering_event_occurrence SET local_date = ?, start_time = ?, end_time = ?,
        capacity = ?, registration_status = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
        .bind(localDate, startTime, endTime, capacity, registrationOpen ? "open" : "closed", time, occurrence.id, input.eventExpectedUpdatedAt),
      audit(env, actor, "activity_offering_changed", "activity_offering", current.id, {
        chargeModeChanged: chargeMode !== current.chargeMode,
        eventScheduleChanged: structuralChange,
        registrationOpen,
        facebookGroupChanged: facebookGroupUrl !== current.facebookGroupUrl,
      }, provenance, time),
    ]);
    if ((result[0]?.meta?.changes ?? 0) !== 1 || (result[1]?.meta?.changes ?? 0) !== 1) throw new OfferingError("conflict");
    return;
  }

  const program = current.curriculumProgramId ? await programById(env, current.curriculumProgramId) : null;
  if (!program) throw new OfferingError("invalid");
  const startsOn = text(input.startsOn) || current.startsOn || "";
  const annualYear = current.kind === "annual_course" ? await academicYearForAnnualOffering(env, startsOn, provenance) : null;
  const endsOn = current.kind === "annual_course" ? annualYear?.endsOn ?? "" : (text(input.endsOn) || current.endsOn || "");
  const title = current.kind === "annual_course" ? `${annualYear?.label} · ${stageLabel(program.stageCode)}` : text(input.title);
  const useBreaks = defaultBreakPolicy(current.kind);
  const duration = Number(input.defaultClassDurationMinutes ?? current.defaultClassDurationMinutes ?? defaultDuration(current.kind, current.stageCode));
  if (!title || !validDate(startsOn) || !validDate(endsOn) || endsOn < startsOn
    || !Number.isInteger(duration) || duration < 15 || duration > 360) throw new OfferingError("invalid");
  const structuralChange = startsOn !== current.startsOn || endsOn !== current.endsOn
    || useBreaks !== Boolean(current.useAcademicYearBreaks)
    || (annualYear?.id ?? program.academicYearId) !== current.academicYearId
    || (current.kind === "annual_course" && program.stageCode !== current.stageCode);
  if (structuralChange && (await offeringHasCalendar(env, current.id)
    || await offeringRegistrationOpen(env, current.id)
    || await offeringHasRegistrationReferences(env, current.id))) throw new OfferingError("immutable");
  const update = structuralChange
    ? env.DB.prepare(`UPDATE activity_offering SET title = ?, academic_year_id = ?, stage_code = ?, level_label = NULL, starts_on = ?, ends_on = ?,
      curriculum_program_id = ?, use_academic_year_breaks = ?, charge_mode = 'paid',
      facebook_group_url = ?, note = ?, default_class_duration_minutes = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .bind(title, annualYear?.id ?? program.academicYearId, current.kind === "annual_course" ? program.stageCode : null,
        startsOn, endsOn, program.id, useBreaks ? 1 : 0,
        facebookGroupUrl, note, duration, time, current.id, input.expectedUpdatedAt)
    : env.DB.prepare(`UPDATE activity_offering SET title = ?, facebook_group_url = ?, note = ?,
      default_class_duration_minutes = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .bind(title, facebookGroupUrl, note, duration, time, current.id, input.expectedUpdatedAt);
  const result = await env.DB.batch([
    update,
    audit(env, actor, "activity_offering_changed", "activity_offering", current.id, {
      programChanged: false,
      breakPolicyChanged: useBreaks !== Boolean(current.useAcademicYearBreaks),
      facebookGroupChanged: facebookGroupUrl !== current.facebookGroupUrl,
    }, provenance, time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new OfferingError("conflict");
}

export async function saveOfferingFacebookGroup(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { offeringId: string; expectedUpdatedAt: string; facebookGroupUrl?: string | null },
): Promise<void> {
  requireManage(actor);
  const current = await offeringById(env, input.offeringId);
  const facebookGroupUrl = optionalText(input.facebookGroupUrl);
  if (!validUrl(facebookGroupUrl)) throw new OfferingError("invalid");
  if (current.updatedAt !== input.expectedUpdatedAt) throw new OfferingError("conflict");
  const time = now();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE activity_offering SET facebook_group_url = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
      .bind(facebookGroupUrl, time, current.id, input.expectedUpdatedAt),
    audit(env, actor, "activity_offering_facebook_changed", "activity_offering", current.id, {}, flags(env, current), time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new OfferingError("conflict");
}

export async function saveOfferingBreak(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { id?: string; expectedUpdatedAt?: string; offeringId: string; label: string; startsOn: string; endsOn: string; note?: string | null },
): Promise<void> {
  requireManage(actor);
  const offering = await offeringById(env, text(input.offeringId, 100));
  if (!['annual_course', 'summer_course'].includes(offering.kind)) throw new OfferingError("invalid");
  const label = text(input.label);
  const startsOn = text(input.startsOn, 10);
  const endsOn = text(input.endsOn, 10);
  const note = optionalText(input.note, 500);
  if (!label || !validDate(startsOn) || !validDate(endsOn) || endsOn < startsOn) throw new OfferingError("invalid");
  const time = now();
  const provenance = flags(env, offering);

  if (!input.id) {
    const breakId = id();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_offering_break (
        id, activity_offering_id, label, starts_on, ends_on, note,
        is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(breakId, offering.id, label, startsOn, endsOn, note, provenance.isTest, provenance.testRunId, time, time),
      audit(env, actor, "offering_break_created", "activity_offering_break", breakId, { offeringId: offering.id }, provenance, time),
    ]);
    return;
  }

  if (!input.expectedUpdatedAt) throw new OfferingError("conflict");
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE activity_offering_break
      SET label = ?, starts_on = ?, ends_on = ?, note = ?, updated_at = ?
      WHERE id = ? AND activity_offering_id = ? AND updated_at = ?`)
      .bind(label, startsOn, endsOn, note, time, input.id, offering.id, input.expectedUpdatedAt),
    audit(env, actor, "offering_break_changed", "activity_offering_break", input.id, { offeringId: offering.id }, provenance, time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new OfferingError("conflict");
}

export async function removeOfferingBreak(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { breakId: string; expectedUpdatedAt: string },
): Promise<void> {
  requireManage(actor);
  const current = await env.DB.prepare(`SELECT break_row.id, break_row.activity_offering_id AS offeringId,
    break_row.is_test AS isTest, break_row.test_run_id AS testRunId, break_row.updated_at AS updatedAt
    FROM activity_offering_break AS break_row WHERE break_row.id = ?`).bind(input.breakId).first<{
      id: string; offeringId: string; isTest: number; testRunId: string | null; updatedAt: string;
    }>();
  if (!current) throw new OfferingError("not_found");
  if (current.updatedAt !== input.expectedUpdatedAt) throw new OfferingError("conflict");
  const time = now();
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM activity_offering_break WHERE id = ? AND updated_at = ?").bind(current.id, input.expectedUpdatedAt),
    audit(env, actor, "offering_break_removed", "activity_offering_break", current.id, { offeringId: current.offeringId }, flags(env, current), time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new OfferingError("conflict");
}

export async function deleteUnusedEventOffering(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { offeringId: string; expectedUpdatedAt: string },
): Promise<void> {
  requireManage(actor);
  const current = await offeringById(env, input.offeringId);
  if (current.kind !== "event") throw new OfferingError("invalid");
  if (current.updatedAt !== input.expectedUpdatedAt) throw new OfferingError("conflict");
  const occurrence = await eventForOffering(env, current.id);
  // Events have no registration or attendance tables yet. A closed occurrence
  // with no future foreign-key reference is therefore safely removable today;
  // database restrictions will reject this path as future durable references
  // are added.
  if (!occurrence || occurrence.registrationStatus !== "closed") throw new OfferingError("immutable");
  const time = now();
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM offering_event_occurrence WHERE id = ?").bind(occurrence.id),
    env.DB.prepare("DELETE FROM activity_offering WHERE id = ? AND updated_at = ?").bind(current.id, input.expectedUpdatedAt),
    audit(env, actor, "activity_offering_deleted", "activity_offering", current.id, { kind: "event" }, flags(env, current), time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1 || (result[1]?.meta?.changes ?? 0) !== 1) throw new OfferingError("conflict");
}

export async function deleteUnusedCourseOffering(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { offeringId: string; expectedUpdatedAt: string },
): Promise<void> {
  requireManage(actor);
  const current = await offeringById(env, input.offeringId);
  if (current.kind !== "annual_course" && current.kind !== "summer_course") throw new OfferingError("invalid");
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new OfferingError("conflict");
  if (!(await unusedCourseOffering(env, current.id))) throw new OfferingError("referenced");

  const classes = await env.DB.prepare("SELECT COUNT(*) AS count FROM class_session WHERE activity_offering_id = ?")
    .bind(current.id).first<{ count: number }>();
  const time = now();
  const result = await env.DB.batch([
    // This context is the only narrow exception to normal calendar-revision
    // immutability. It exists solely while deleting an otherwise unused
    // Offering and disappears before the Offering itself is removed.
    env.DB.prepare(`INSERT INTO unused_offering_deletion_context (activity_offering_id, created_at)
      VALUES (?, ?)`).bind(current.id, time),
    env.DB.prepare(`UPDATE class_calendar_revision
      SET based_on_revision_id = NULL, status = 'draft'
      WHERE class_calendar_id IN (
        SELECT calendar.id FROM class_calendar AS calendar
        INNER JOIN class_session AS class_row ON class_row.id = calendar.class_session_id
        WHERE class_row.activity_offering_id = ?
      )`).bind(current.id),
    env.DB.prepare(`DELETE FROM class_calendar_revision
      WHERE class_calendar_id IN (
        SELECT calendar.id FROM class_calendar AS calendar
        INNER JOIN class_session AS class_row ON class_row.id = calendar.class_session_id
        WHERE class_row.activity_offering_id = ?
      )`).bind(current.id),
    env.DB.prepare(`DELETE FROM class_calendar
      WHERE class_session_id IN (
        SELECT id FROM class_session WHERE activity_offering_id = ?
      )`).bind(current.id),
    // Meeting rules cascade from their unused classes. Configuration rows are
    // removed only after the service rejects every operational reference.
    env.DB.prepare("DELETE FROM activity_offering_break WHERE activity_offering_id = ?").bind(current.id),
    env.DB.prepare("DELETE FROM offering_course_pricing WHERE activity_offering_id = ?").bind(current.id),
    env.DB.prepare("DELETE FROM class_session WHERE activity_offering_id = ?").bind(current.id),
    env.DB.prepare("DELETE FROM unused_offering_deletion_context WHERE activity_offering_id = ?").bind(current.id),
    env.DB.prepare(`DELETE FROM activity_offering
      WHERE id = ? AND updated_at = ? AND kind IN ('annual_course', 'summer_course')`).bind(current.id, input.expectedUpdatedAt),
    audit(env, actor, "activity_offering_deleted", "activity_offering", current.id, {
      kind: current.kind,
      deletedUnusedClassCount: classes?.count ?? 0,
    }, flags(env, current), time),
  ]);
  if ((result[8]?.meta?.changes ?? 0) !== 1) throw new OfferingError("conflict");
}
