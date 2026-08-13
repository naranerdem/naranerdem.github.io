import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export const OFFERING_KINDS = ["annual_course", "summer_course", "event"] as const;
export const CHARGE_MODES = ["free", "paid"] as const;
export type OfferingKind = typeof OFFERING_KINDS[number];
export type ChargeMode = typeof CHARGE_MODES[number];

export class OfferingError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "immutable") {
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
    WHERE family.id = ? AND family.kind = ?
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

async function academicYearForAnnualOffering(env: WorkerEnv, startsOn: string, endsOn: string): Promise<{ id: string; label: string }> {
  const year = await env.DB.prepare(`SELECT id, public_label AS label FROM academic_year
    WHERE starts_on IS NOT NULL AND ends_on IS NOT NULL
      AND starts_on <= ? AND ends_on >= ?
    ORDER BY is_current DESC, starts_on DESC LIMIT 1`).bind(startsOn, endsOn).first<{ id: string; label: string }>();
  if (!year) throw new OfferingError("invalid");
  return year;
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
      offering.note, offering.status, offering.is_test AS isTest,
      offering.test_run_id AS testRunId, offering.updated_at AS updatedAt
      FROM activity_offering AS offering
      LEFT JOIN curriculum_program AS program ON program.id = offering.curriculum_program_id
      LEFT JOIN curriculum_program_family AS family ON family.id = program.program_family_id
      LEFT JOIN academic_year AS year ON year.id = offering.academic_year_id
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
    offerings: offerings.results.map((entry) => ({
      ...entry,
      useAcademicYearBreaks: Boolean(entry.useAcademicYearBreaks),
    })),
    eventOccurrences: occurrences.results.map((entry) => ({
      ...entry,
      registrationOpen: entry.registrationStatus === "open",
    })),
    offeringBreaks: offeringBreaks.results,
  };
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

    const startsOn = optionalText(input.startsOn, 10);
    const endsOn = optionalText(input.endsOn, 10);
    if (!startsOn || !endsOn || !validDate(startsOn) || !validDate(endsOn) || endsOn < startsOn) throw new OfferingError("invalid");
    const program = kind === "annual_course"
      ? await currentAnnualProgramForStage(env, text(input.annualStageCode, 30))
      : await currentProgramForFamily(env, "summer_course", text(input.programFamilyId, 100));
    const annualYear = kind === "annual_course" ? await academicYearForAnnualOffering(env, startsOn, endsOn) : null;
    const title = kind === "annual_course"
      ? `${annualYear?.label} · ${stageLabel(program.stageCode)}`
      : text(input.title);
    const sourceFlags = flags(env, program);
    if (!title) throw new OfferingError("invalid");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_offering (
        id, kind, title, academic_year_id, stage_code, level_label, starts_on, ends_on,
        curriculum_program_id, use_academic_year_breaks, charge_mode, facebook_group_url,
        note, status, is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .bind(offeringId, kind, title, annualYear?.id ?? program.academicYearId, kind === "annual_course" ? program.stageCode : null, null,
          startsOn, endsOn, program.id,
          defaultBreakPolicy(kind) ? 1 : 0,
          chargeMode, facebookGroupUrl, note, sourceFlags.isTest, sourceFlags.testRunId, time, time),
      audit(env, actor, "activity_offering_created", "activity_offering", offeringId, {
        kind, chargeMode, useAcademicYearBreaks: defaultBreakPolicy(kind),
        programId: program.id,
      }, sourceFlags, time),
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
  const endsOn = text(input.endsOn) || current.endsOn || "";
  const annualYear = current.kind === "annual_course" ? await academicYearForAnnualOffering(env, startsOn, endsOn) : null;
  const title = current.kind === "annual_course" ? `${annualYear?.label} · ${stageLabel(program.stageCode)}` : text(input.title);
  const useBreaks = defaultBreakPolicy(current.kind);
  if (!title || !validDate(startsOn) || !validDate(endsOn) || endsOn < startsOn) throw new OfferingError("invalid");
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
      facebook_group_url = ?, note = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .bind(title, annualYear?.id ?? program.academicYearId, current.kind === "annual_course" ? program.stageCode : null,
        startsOn, endsOn, program.id, useBreaks ? 1 : 0,
        facebookGroupUrl, note, time, current.id, input.expectedUpdatedAt)
    : env.DB.prepare(`UPDATE activity_offering SET title = ?, facebook_group_url = ?, note = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`)
      .bind(title, facebookGroupUrl, note, time, current.id, input.expectedUpdatedAt);
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
