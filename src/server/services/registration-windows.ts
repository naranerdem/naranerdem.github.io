import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "../staff/authorization";

export type RegistrationWindowState = "future" | "active" | "past";

export class RegistrationWindowError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "immutable") {
    super("Registration window operation failed.");
    this.name = "RegistrationWindowError";
  }
}

interface WindowRow {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  isTest: number;
  testRunId: string | null;
  updatedAt: string;
}

interface OfferingRow {
  id: string;
  title: string;
  kind: "annual_course" | "summer_course";
  startsOn: string | null;
  endsOn: string | null;
  isTest: number;
}

export interface RegistrationWindowSaveInput {
  id?: string;
  expectedUpdatedAt?: string;
  name: unknown;
  startsOn: unknown;
  endsOn: unknown;
  offeringIds: unknown;
}

function now(): string { return new Date().toISOString(); }
function text(value: unknown, max = 160): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().slice(0, max) : "";
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => text(entry, 100)).filter(Boolean))];
}

export function mongoliaCivilDate(date = new Date()): string {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${values.year}-${values.month}-${values.day}`;
}

export function registrationWindowState(window: Pick<WindowRow, "startsOn" | "endsOn">, localDate = mongoliaCivilDate()): RegistrationWindowState {
  if (localDate < window.startsOn) return "future";
  if (localDate > window.endsOn) return "past";
  return "active";
}

export const activeWindowForOfferingSql = (offeringExpression: string): string => `
  EXISTS (
    SELECT 1
    FROM registration_window_offering AS registration_window_offering
    INNER JOIN registration_window ON registration_window.id = registration_window_offering.registration_window_id
    WHERE registration_window_offering.activity_offering_id = ${offeringExpression}
      AND registration_window.starts_on <= ?
      AND registration_window.ends_on >= ?
  )
`;

function requireManage(actor: StaffPrincipal): void {
  if (!hasStaffCapability(actor, "registration.manage")) throw new RegistrationWindowError("forbidden");
}

function provenance(env: WorkerEnv) {
  return env.APP_ENV === "staging"
    ? { isTest: 1, testRunId: "staff-registration-window" }
    : { isTest: 0, testRunId: null };
}

function audit(
  env: WorkerEnv,
  actor: StaffPrincipal,
  action: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  flags: { isTest: number; testRunId: string | null },
  occurredAt: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, 'registration_window', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), occurredAt, actor.staffAccountId, action, subjectId,
      JSON.stringify(metadata), env.APP_ENV, flags.isTest, flags.testRunId, occurredAt);
}

async function windowById(env: WorkerEnv, id: string): Promise<WindowRow> {
  const row = await env.DB.prepare(`SELECT id, name, starts_on AS startsOn, ends_on AS endsOn,
    is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
    FROM registration_window WHERE id = ?`).bind(id).first<WindowRow>();
  if (!row) throw new RegistrationWindowError("not_found");
  return row;
}

async function selectedOfferings(env: WorkerEnv, ids: string[]): Promise<OfferingRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await env.DB.prepare(`SELECT id, title, kind, starts_on AS startsOn, ends_on AS endsOn,
    is_test AS isTest FROM activity_offering
    WHERE id IN (${placeholders}) AND status = 'active' AND kind IN ('annual_course', 'summer_course')`)
    .bind(...ids).all<OfferingRow>();
  if (result.results.length !== ids.length) throw new RegistrationWindowError("invalid");
  if (env.APP_ENV === "production" && result.results.some((offering) => offering.isTest)) throw new RegistrationWindowError("invalid");
  return result.results;
}

export async function getRegistrationWindowOverview(env: WorkerEnv, localDate = mongoliaCivilDate()) {
  const [windows, offerings, registrations] = await Promise.all([
    env.DB.prepare(`SELECT id, name, starts_on AS startsOn, ends_on AS endsOn,
      is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
      FROM registration_window
      WHERE (? = 'staging' OR is_test = 0)
      ORDER BY starts_on DESC, name`).bind(env.APP_ENV).all<WindowRow>(),
    env.DB.prepare(`SELECT offering.id, offering.title, offering.kind, offering.starts_on AS startsOn,
      offering.ends_on AS endsOn, offering.is_test AS isTest
      FROM activity_offering AS offering
      WHERE offering.status = 'active' AND offering.kind IN ('annual_course', 'summer_course')
        AND (? = 'staging' OR offering.is_test = 0)
      ORDER BY offering.starts_on, offering.title`).bind(env.APP_ENV).all<OfferingRow>(),
    env.DB.prepare(`SELECT registration_draft_child.id AS childId,
      registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
      registration_draft_child.status AS childStatus,
      registration_draft.guardian_full_name AS guardianName, registration_draft.primary_phone AS primaryPhone,
      registration_draft.email, registration_draft.verified_at AS verifiedAt,
      class_session.stage_code AS stageCode, class_session.display_label AS classLabel,
      registration_draft_waitlist_entry.status AS waitlistStatus,
      payment_installment.status AS initialPaymentStatus,
      enrollment.status AS enrollmentStatus,
      registration_draft_child.promotion_status AS promotionStatus,
      registration_draft_child.identity_resolution_status AS identityResolutionStatus
      FROM registration_draft_child
      INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
      LEFT JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
      LEFT JOIN registration_draft_waitlist_entry ON registration_draft_waitlist_entry.registration_draft_child_id = registration_draft_child.id
      LEFT JOIN payment_installment ON payment_installment.registration_draft_child_id = registration_draft_child.id
        AND payment_installment.installment_kind = 'initial'
      LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      WHERE (? = 'staging' OR registration_draft.is_test = 0)
      ORDER BY registration_draft.created_at DESC, registration_draft_child.position`).bind(env.APP_ENV).all<Record<string, unknown>>(),
  ]);
  const memberships = await env.DB.prepare(`SELECT registration_window_id AS windowId,
    activity_offering_id AS offeringId FROM registration_window_offering`).all<{ windowId: string; offeringId: string }>();
  const byWindow = new Map<string, string[]>();
  for (const membership of memberships.results) {
    const current = byWindow.get(membership.windowId) ?? [];
    current.push(membership.offeringId);
    byWindow.set(membership.windowId, current);
  }
  return {
    today: localDate,
    offerings: offerings.results,
    windows: windows.results.map((window) => ({
      ...window,
      state: registrationWindowState(window, localDate),
      offeringIds: byWindow.get(window.id) ?? [],
    })),
    registrations: registrations.results,
  };
}

export async function saveRegistrationWindow(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: RegistrationWindowSaveInput,
  localDate = mongoliaCivilDate(),
): Promise<void> {
  requireManage(actor);
  const name = text(input.name, 160);
  const startsOn = text(input.startsOn, 10);
  const endsOn = text(input.endsOn, 10);
  const offeringIds = uniqueIds(input.offeringIds);
  if (!name || !validDate(startsOn) || !validDate(endsOn) || endsOn < startsOn || !offeringIds.length) {
    throw new RegistrationWindowError("invalid");
  }
  await selectedOfferings(env, offeringIds);
  const occurredAt = now();

  if (!input.id) {
    const id = crypto.randomUUID();
    const flags = provenance(env);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO registration_window (
        id, name, starts_on, ends_on, is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, name, startsOn, endsOn, flags.isTest, flags.testRunId, occurredAt, occurredAt),
      ...offeringIds.map((offeringId) => env.DB.prepare(`INSERT INTO registration_window_offering (
        registration_window_id, activity_offering_id, created_at
      ) VALUES (?, ?, ?)`).bind(id, offeringId, occurredAt)),
      audit(env, actor, "registration_window_created", id, { startsOn, endsOn, offeringCount: offeringIds.length }, flags, occurredAt),
    ]);
    return;
  }

  const current = await windowById(env, text(input.id, 100));
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new RegistrationWindowError("conflict");
  const state = registrationWindowState(current, localDate);
  if (state === "past") throw new RegistrationWindowError("immutable");
  if (state === "active" && startsOn !== current.startsOn) throw new RegistrationWindowError("immutable");
  const flags = { isTest: current.isTest, testRunId: current.testRunId };
  await env.DB.batch([
    env.DB.prepare(`UPDATE registration_window SET name = ?, starts_on = ?, ends_on = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`).bind(name, startsOn, endsOn, occurredAt, current.id, current.updatedAt),
    env.DB.prepare("DELETE FROM registration_window_offering WHERE registration_window_id = ?").bind(current.id),
    ...offeringIds.map((offeringId) => env.DB.prepare(`INSERT INTO registration_window_offering (
      registration_window_id, activity_offering_id, created_at
    ) VALUES (?, ?, ?)`).bind(current.id, offeringId, occurredAt)),
    audit(env, actor, "registration_window_changed", current.id, { state, startsOn, endsOn, offeringCount: offeringIds.length }, flags, occurredAt),
  ]);
}

export async function deleteRegistrationWindow(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { id: string; expectedUpdatedAt: string },
  localDate = mongoliaCivilDate(),
): Promise<void> {
  requireManage(actor);
  const current = await windowById(env, text(input.id, 100));
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new RegistrationWindowError("conflict");
  if (registrationWindowState(current, localDate) !== "future") throw new RegistrationWindowError("immutable");
  const occurredAt = now();
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM registration_window WHERE id = ? AND updated_at = ?").bind(current.id, current.updatedAt),
    audit(env, actor, "registration_window_deleted", current.id, {}, { isTest: current.isTest, testRunId: current.testRunId }, occurredAt),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new RegistrationWindowError("conflict");
}
