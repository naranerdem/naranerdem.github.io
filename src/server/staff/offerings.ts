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
  academicYearId: string;
  stageCode: "stage_1" | "stage_2" | "stage_3";
  status: "draft" | "published" | "superseded" | "archived";
  displayName: string;
}

interface YearRow {
  id: string;
  label: string;
  startsOn: string | null;
  endsOn: string | null;
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
function validStage(value: string | null): value is "stage_1" | "stage_2" | "stage_3" {
  return value !== null && ["stage_1", "stage_2", "stage_3"].includes(value);
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
  const row = await env.DB.prepare(`SELECT id, academic_year_id AS academicYearId,
    stage_code AS stageCode, status, display_name AS displayName
    FROM curriculum_program WHERE id = ?`).bind(programId).first<ProgramContextRow>();
  if (!row) throw new OfferingError("not_found");
  return row;
}

async function yearById(env: WorkerEnv, yearId: string): Promise<YearRow> {
  const row = await env.DB.prepare(`SELECT id, public_label AS label, starts_on AS startsOn,
    ends_on AS endsOn, is_test AS isTest, test_run_id AS testRunId
    FROM academic_year WHERE id = ?`).bind(yearId).first<YearRow>();
  if (!row) throw new OfferingError("not_found");
  return row;
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

async function offeringClassesFitPeriod(env: WorkerEnv, offeringId: string, startsOn: string, endsOn: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM class_session
    INNER JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id
    WHERE class_session.activity_offering_id = ?
      AND (class_meeting_rule.first_date < ?
        OR (class_meeting_rule.last_date IS NOT NULL AND class_meeting_rule.last_date > ?))
    ) THEN 0 ELSE 1 END AS fits`).bind(offeringId, startsOn, endsOn).first<{ fits: number }>();
  return row?.fits === 1;
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
}> {
  const [offerings, occurrences] = await Promise.all([
    env.DB.prepare(`SELECT offering.id, offering.kind, offering.title,
      offering.academic_year_id AS academicYearId, offering.stage_code AS stageCode,
      offering.level_label AS levelLabel, offering.starts_on AS startsOn, offering.ends_on AS endsOn,
      offering.curriculum_program_id AS curriculumProgramId,
      program.display_name AS programName, program.status AS programStatus,
      offering.use_academic_year_breaks AS useAcademicYearBreaks,
      offering.charge_mode AS chargeMode, offering.facebook_group_url AS facebookGroupUrl,
      offering.note, offering.status, offering.is_test AS isTest,
      offering.test_run_id AS testRunId, offering.updated_at AS updatedAt
      FROM activity_offering AS offering
      LEFT JOIN curriculum_program AS program ON program.id = offering.curriculum_program_id
      WHERE offering.status = 'active'
      ORDER BY offering.starts_on DESC, offering.kind, offering.title`).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id, activity_offering_id AS offeringId, local_date AS localDate,
      start_time AS startTime, end_time AS endTime, capacity,
      registration_status AS registrationStatus, is_test AS isTest,
      test_run_id AS testRunId, updated_at AS updatedAt
      FROM offering_event_occurrence ORDER BY local_date, start_time`).all<Record<string, unknown>>(),
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
  };
}

async function resolveCourseProgram(
  env: WorkerEnv,
  kind: "annual_course" | "summer_course",
  offeringId: string,
  title: string,
  academicYearId: string | null,
  stageCode: string | null,
  selectedProgramId: string | null,
  provenance: { isTest: number; testRunId: string | null },
  time: string,
): Promise<{ academicYearId: string; stageCode: "stage_1" | "stage_2" | "stage_3"; programId: string; setup: D1PreparedStatement[] }> {
  if (selectedProgramId) {
    const program = await programById(env, selectedProgramId);
    if (!['draft', 'published'].includes(program.status)) throw new OfferingError("invalid");
    if (kind === "annual_course" && (program.academicYearId !== academicYearId || program.stageCode !== stageCode)) throw new OfferingError("invalid");
    return { academicYearId: program.academicYearId, stageCode: program.stageCode, programId: program.id, setup: [] };
  }

  if (kind === "annual_course") {
    if (!academicYearId || !validStage(stageCode)) throw new OfferingError("invalid");
    const existing = await env.DB.prepare(`SELECT id, academic_year_id AS academicYearId,
      stage_code AS stageCode, status, display_name AS displayName FROM curriculum_program
      WHERE academic_year_id = ? AND stage_code = ? AND status IN ('draft', 'published')
      ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, revision_number DESC LIMIT 1`)
      .bind(academicYearId, stageCode).first<ProgramContextRow>();
    if (existing) return { academicYearId, stageCode, programId: existing.id, setup: [] };
    const programId = id();
    return {
      academicYearId,
      stageCode,
      programId,
      setup: [env.DB.prepare(`INSERT INTO curriculum_program (
        id, academic_year_id, stage_code, revision_number, display_name, status,
        is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, 'draft', ?, ?, ?, ?)`)
        .bind(programId, academicYearId, stageCode, `${stageLabel(stageCode)}ны хөтөлбөр`, provenance.isTest, provenance.testRunId, time, time)],
    };
  }

  const internalYearId = `summer-context-${offeringId}`;
  const programId = id();
  return {
    academicYearId: internalYearId,
    stageCode: "stage_1",
    programId,
    setup: [
      env.DB.prepare(`INSERT INTO academic_year (
        id, public_label, registration_status, starts_on, ends_on, is_current,
        is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, 'draft', ?, ?, 0, ?, ?, ?, ?)`)
        .bind(internalYearId, title, null, null, provenance.isTest, provenance.testRunId, time, time),
      env.DB.prepare(`INSERT INTO curriculum_program (
        id, academic_year_id, stage_code, revision_number, display_name, status,
        is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, 'stage_1', 1, ?, 'draft', ?, ?, ?, ?)`)
        .bind(programId, internalYearId, `${title} хөтөлбөр`, provenance.isTest, provenance.testRunId, time, time),
    ],
  };
}

export async function saveActivityOffering(env: WorkerEnv, actor: StaffPrincipal, input: OfferingSaveInput): Promise<void> {
  requireManage(actor);
  const kind = text(input.kind) as OfferingKind;
  if (!OFFERING_KINDS.includes(kind)) throw new OfferingError("invalid");
  const chargeMode = (text(input.chargeMode) || defaultCharge(kind)) as ChargeMode;
  const facebookGroupUrl = optionalText(input.facebookGroupUrl);
  const levelLabel = optionalText(input.levelLabel, 80);
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

    const selectedYearId = optionalText(input.academicYearId, 100);
    const selectedStage = optionalText(input.stageCode, 20);
    let title = text(input.title);
    let startsOn = optionalText(input.startsOn, 10);
    let endsOn = optionalText(input.endsOn, 10);
    let sourceFlags = provenance;
    if (kind === "annual_course") {
      if (!selectedYearId || !validStage(selectedStage)) throw new OfferingError("invalid");
      const year = await yearById(env, selectedYearId);
      sourceFlags = flags(env, year);
      title = `${year.label} · ${stageLabel(selectedStage)}`;
      startsOn = startsOn || year.startsOn;
      endsOn = endsOn || year.endsOn;
    }
    if (!title || !startsOn || !endsOn || !validDate(startsOn) || !validDate(endsOn) || endsOn < startsOn) throw new OfferingError("invalid");
    const resolved = await resolveCourseProgram(
      env, kind, offeringId, title, selectedYearId, selectedStage,
      optionalText(input.curriculumProgramId, 100), sourceFlags, time,
    );
    const offeringStage = kind === "annual_course" ? resolved.stageCode : null;
    await env.DB.batch([
      ...resolved.setup,
      env.DB.prepare(`INSERT INTO activity_offering (
        id, kind, title, academic_year_id, stage_code, level_label, starts_on, ends_on,
        curriculum_program_id, use_academic_year_breaks, charge_mode, facebook_group_url,
        note, status, is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .bind(offeringId, kind, title, resolved.academicYearId, offeringStage, levelLabel,
          startsOn, endsOn, resolved.programId,
          (input.useAcademicYearBreaks ?? defaultBreakPolicy(kind)) ? 1 : 0,
          chargeMode, facebookGroupUrl, note, sourceFlags.isTest, sourceFlags.testRunId, time, time),
      audit(env, actor, "activity_offering_created", "activity_offering", offeringId, {
        kind, chargeMode, useAcademicYearBreaks: input.useAcademicYearBreaks ?? defaultBreakPolicy(kind),
        programId: resolved.programId,
      }, sourceFlags, time),
    ]);
    return;
  }

  const current = await offeringById(env, input.id);
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new OfferingError("conflict");
  if (kind !== current.kind) throw new OfferingError("immutable");
  const title = current.kind === "annual_course" ? current.title : text(input.title);
  if (!title) throw new OfferingError("invalid");
  const time = now();
  const provenance = flags(env, current);

  if (current.kind === "event") {
    const occurrence = await eventForOffering(env, current.id);
    if (!occurrence || !input.eventExpectedUpdatedAt || occurrence.updatedAt !== input.eventExpectedUpdatedAt) throw new OfferingError("conflict");
    const localDate = text(input.eventDate);
    const startTime = text(input.eventStartTime);
    const endTime = text(input.eventEndTime);
    const capacity = Number(input.eventCapacity);
    const registrationOpen = Boolean(input.eventRegistrationOpen);
    if (!validDate(localDate) || !validTime(startTime) || !validTime(endTime) || startTime >= endTime
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

  const startsOn = text(input.startsOn);
  const endsOn = text(input.endsOn);
  const programId = text(input.curriculumProgramId);
  const useBreaks = Boolean(input.useAcademicYearBreaks);
  if (!validDate(startsOn) || !validDate(endsOn) || endsOn < startsOn || !programId) throw new OfferingError("invalid");
  const program = await programById(env, programId);
  if (!['draft', 'published'].includes(program.status)) throw new OfferingError("invalid");
  if (current.kind === "annual_course" && (program.academicYearId !== current.academicYearId || program.stageCode !== current.stageCode)) throw new OfferingError("invalid");
  if (current.kind === "summer_course" && program.academicYearId !== current.academicYearId) throw new OfferingError("invalid");
  const periodChanged = startsOn !== current.startsOn || endsOn !== current.endsOn;
  const structuralChange = startsOn !== current.startsOn || endsOn !== current.endsOn
    || programId !== current.curriculumProgramId || useBreaks !== Boolean(current.useAcademicYearBreaks);
  if (structuralChange && (await offeringHasCalendar(env, current.id)
    || await offeringRegistrationOpen(env, current.id)
    || await offeringHasRegistrationReferences(env, current.id))) throw new OfferingError("immutable");
  if (periodChanged && !(await offeringClassesFitPeriod(env, current.id, startsOn, endsOn))) throw new OfferingError("invalid");
  if (chargeMode !== current.chargeMode && (await offeringRegistrationOpen(env, current.id) || await offeringHasRegistrationReferences(env, current.id))) {
    throw new OfferingError("immutable");
  }
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE activity_offering SET title = ?, level_label = ?, starts_on = ?, ends_on = ?,
      curriculum_program_id = ?, use_academic_year_breaks = ?, charge_mode = ?,
      facebook_group_url = ?, note = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .bind(title, levelLabel, startsOn, endsOn, programId, useBreaks ? 1 : 0, chargeMode,
        facebookGroupUrl, note, time, current.id, input.expectedUpdatedAt),
    audit(env, actor, "activity_offering_changed", "activity_offering", current.id, {
      chargeModeChanged: chargeMode !== current.chargeMode,
      programChanged: programId !== current.curriculumProgramId,
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
