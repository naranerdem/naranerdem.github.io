import { rulesContent } from "../../content/rules";
import { normalizeEmail, validEmail } from "../auth/email-address";
import { randomToken, sha256 } from "../auth/crypto";
import type { D1Database, D1Result, WorkerEnv } from "../env";
import { registrationWriteEnabled } from "../security/operational-gates";
import { getPaymentCollectionSettings, getPaymentCollectionSettingsFromDatabase, type CoursePaymentPlanCode } from "../staff/course-pricing";
import { activeWindowForOfferingSql, mongoliaCivilDate } from "./registration-windows";
import { assertCourseRuleVersions, PublicContentError } from "../staff/public-content";
import { getInitialPaymentDeadlineSettingFromDatabase } from "../staff/initial-payment-deadline";
import { getPaymentReminderSetting } from "../staff/payment-reminders";
import { activeReferralCodes, normalizeReferralCode, type RegistrationProvenance } from "./referral-codes";

export const REGISTRATION_DRAFT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REGISTRATION_RESEND_COOLDOWN_SECONDS = 60;
export const REGISTRATION_DRAFT_COOKIE = "naran_registration_draft";

type StageCode = "stage_1" | "stage_2" | "stage_3";

export interface RegistrationSubmissionInput {
  guardian: {
    fullName: string;
    relationship: string;
    primaryPhone: string;
    secondaryPhone?: string;
    email: string;
    facebookName?: string;
    homeAddress: string;
  };
  children: Array<{
    surname: string;
    givenName: string;
    gender: "female" | "male" | "not_specified";
    dateOfBirth: string;
    currentGrade: string;
    currentSchool?: string;
    facebookName?: string;
    returningStatus: "new" | "returning";
    previousStageCode?: StageCode | "unknown";
    selectedStageCode: StageCode;
    selectedClassSessionId?: string;
    preferredWaitlistClassSessionId?: string;
    codeInput?: string;
    paymentPlanCode?: CoursePaymentPlanCode;
  }>;
  parentRulesAcknowledged: boolean;
  studentRulesAcknowledged: boolean;
  parentRulesVersion?: string;
  studentRulesVersion?: string;
  turnstileToken: string;
}

export interface RegistrationSubmissionOptions {
  idempotencyKey?: string | null;
}

interface ClassRow {
  id: string;
  academicYearId: string;
  stageCode: StageCode;
  status: string;
  academicYearIsTest: number;
  offeringIsTest: number;
  classIsTest: number;
  classIsTestOnly: number;
  registrationWindowActive: number;
  offeringId: string | null;
  oneTimeAmountMnt: number | null;
  twoInstallmentEnabled: number | null;
  firstInstallmentAmountMnt: number | null;
  secondInstallmentAmountMnt: number | null;
  secondInstallmentDueOn: string | null;
}

interface ChallengeRow {
  id: string;
  normalizedEmail: string;
  status: "pending" | "used" | "expired" | "invalidated";
  expiresAt: string;
  invalidatedAt: string | null;
  registrationDraftId: string | null;
  isTest: number;
  testRunId: string | null;
}

interface DraftAccessRow {
  id: string;
  normalizedEmail: string;
  email: string;
  status: string;
  emailLastSentAt: string | null;
  expiresAt: string;
}

export class RegistrationSubmissionError extends Error {
  constructor(public readonly code: string) {
    super("Registration submission failed.");
    this.name = "RegistrationSubmissionError";
  }
}

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function paymentReference(): string {
  // Deliberately opaque and copyable: no name, email, or other family data.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `NE-${[...bytes].map((value) => alphabet[value % alphabet.length]).join("")}`;
}

async function unusedPaymentReference(database: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const value = paymentReference();
    const existing = await database.prepare("SELECT 1 AS value FROM payment_request WHERE payment_reference = ?")
      .bind(value).first<{ value: number }>();
    if (!existing) return value;
  }
  throw new RegistrationSubmissionError("payment_reference_unavailable");
}

function changeCount(result: D1Result<unknown> | undefined): number {
  return result?.meta?.changes ?? 0;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().slice(0, max) : "";
}

function normalizedIdempotencyKey(value: string | null | undefined): string | null {
  const key = clean(value, 120);
  return /^[A-Za-z0-9._:-]{16,120}$/.test(key) ? key : null;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function compactPhone(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

async function transferDescription(database: D1Database, childName: string, phone: string): Promise<string> {
  const base = `${childName} ${compactPhone(phone)}`.slice(0, 120);
  const result = await database.prepare(`SELECT payment_request.transfer_description AS transferDescription
    FROM payment_request
    INNER JOIN registration_draft ON registration_draft.id = payment_request.registration_draft_id
    WHERE registration_draft.primary_phone = ?
      AND EXISTS (SELECT 1 FROM payment_installment
        WHERE payment_installment.payment_request_id = payment_request.id
          AND payment_installment.installment_kind = 'initial'
          AND payment_installment.status IN ('pending', 'partially_paid'))`)
    .bind(phone).all<{ transferDescription: string | null }>();
  const used = new Set(result.results.map((item) => item.transferDescription).filter(Boolean));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new RegistrationSubmissionError("payment_reference_unavailable");
}

export function registrationDraftCookie(token: string, secure = true): string {
  const parts = [
    `${REGISTRATION_DRAFT_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${REGISTRATION_DRAFT_TTL_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(request: Request, name: string): string {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function validateSubmission(input: RegistrationSubmissionInput): RegistrationSubmissionInput {
  const guardian = {
    fullName: clean(input?.guardian?.fullName, 160),
    relationship: clean(input?.guardian?.relationship, 80),
    primaryPhone: clean(input?.guardian?.primaryPhone, 40),
    secondaryPhone: clean(input?.guardian?.secondaryPhone, 40),
    email: clean(input?.guardian?.email, 254),
    facebookName: clean(input?.guardian?.facebookName, 160),
    homeAddress: clean(input?.guardian?.homeAddress, 500),
  };
  if (!guardian.fullName || !guardian.relationship || !guardian.primaryPhone || !guardian.facebookName || !guardian.homeAddress) {
    throw new RegistrationSubmissionError("invalid_guardian");
  }
  if (!validEmail(normalizeEmail(guardian.email))) throw new RegistrationSubmissionError("invalid_email");
  if (!Array.isArray(input.children) || input.children.length < 1 || input.children.length > 8) {
    throw new RegistrationSubmissionError("invalid_children");
  }

  const stages = new Set<StageCode>(["stage_1", "stage_2", "stage_3"]);
  const genders = new Set(["female", "male", "not_specified"]);
  const children = input.children.map((source) => {
    const child = {
      surname: clean(source.surname, 100),
      givenName: clean(source.givenName, 100),
      gender: source.gender,
      dateOfBirth: clean(source.dateOfBirth, 10),
      currentGrade: clean(source.currentGrade, 20),
      currentSchool: clean(source.currentSchool, 160),
      facebookName: clean(source.facebookName, 160),
      returningStatus: source.returningStatus,
      previousStageCode: source.previousStageCode,
      selectedStageCode: source.selectedStageCode,
      selectedClassSessionId: clean(source.selectedClassSessionId, 100),
      preferredWaitlistClassSessionId: clean(source.preferredWaitlistClassSessionId, 100),
      codeInput: clean(source.codeInput, 120),
      paymentPlanCode: source.paymentPlanCode,
    };
    if (!child.surname || !child.givenName || !genders.has(child.gender) || !validDate(child.dateOfBirth)) {
      throw new RegistrationSubmissionError("invalid_child");
    }
    if (!child.currentGrade || !stages.has(child.selectedStageCode)) {
      throw new RegistrationSubmissionError("invalid_child");
    }
    if (!new Set(["new", "returning"]).has(child.returningStatus)) {
      throw new RegistrationSubmissionError("invalid_child");
    }
    if (child.returningStatus === "returning" && !child.previousStageCode) {
      throw new RegistrationSubmissionError("invalid_previous_stage");
    }
    if (!child.selectedClassSessionId && !child.preferredWaitlistClassSessionId) {
      throw new RegistrationSubmissionError("class_choice_required");
    }
    if (child.selectedClassSessionId && child.selectedClassSessionId === child.preferredWaitlistClassSessionId) {
      throw new RegistrationSubmissionError("duplicate_class_choice");
    }
    if (child.paymentPlanCode && !(["single", "two_installment"] as const).includes(child.paymentPlanCode)) {
      throw new RegistrationSubmissionError("invalid_payment_plan");
    }
    return child;
  });

  if (!input.parentRulesAcknowledged || !input.studentRulesAcknowledged) {
    throw new RegistrationSubmissionError("rules_not_acknowledged");
  }
  return { ...input, guardian, children };
}

function sourceProvenance(classes: ClassRow[], environment: WorkerEnv["APP_ENV"]): RegistrationProvenance {
  const first = classes[0];
  if (!first) throw new RegistrationSubmissionError("invalid_class");
  const sourceFlagsAreConsistent = (item: ClassRow) => item.academicYearIsTest === item.offeringIsTest
    && item.offeringIsTest === item.classIsTest
    && item.classIsTestOnly === item.classIsTest;
  if (classes.some((item) => !sourceFlagsAreConsistent(item))) throw new RegistrationSubmissionError("invalid_class");
  const isTest = first.classIsTest;
  if (classes.some((item) => item.classIsTest !== isTest)) throw new RegistrationSubmissionError("mixed_class_provenance");
  if (environment === "production" && isTest) throw new RegistrationSubmissionError("invalid_class");
  return { isTest, testRunId: null };
}

async function loadChosenClasses(env: WorkerEnv, ids: string[], localDate: string): Promise<ClassRow[]> {
  const { DB: database } = env;
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await database.prepare(`
    SELECT class_session.id AS id,
      class_session.academic_year_id AS academicYearId,
      class_session.stage_code AS stageCode,
      class_session.status AS status,
      academic_year.is_test AS academicYearIsTest,
      offering.is_test AS offeringIsTest,
      class_session.is_test AS classIsTest,
      class_session.is_test_only AS classIsTestOnly,
      class_session.activity_offering_id AS offeringId,
      CASE WHEN ${activeWindowForOfferingSql("offering.id")} THEN 1 ELSE 0 END AS registrationWindowActive,
      pricing.one_time_amount_mnt AS oneTimeAmountMnt,
      pricing.two_installment_enabled AS twoInstallmentEnabled,
      pricing.first_installment_amount_mnt AS firstInstallmentAmountMnt,
      pricing.second_installment_amount_mnt AS secondInstallmentAmountMnt,
      pricing.second_installment_due_on AS secondInstallmentDueOn
    FROM class_session
    INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
    INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
      AND offering.kind IN ('annual_course', 'summer_course') AND offering.status = 'active'
    LEFT JOIN offering_course_pricing AS pricing ON pricing.activity_offering_id = offering.id
    WHERE class_session.id IN (${placeholders})
      AND (? != 'production' OR (
        academic_year.is_test = 0 AND offering.is_test = 0
        AND class_session.is_test = 0 AND class_session.is_test_only = 0
      ))
  `).bind(localDate, localDate, ...uniqueIds, env.APP_ENV).all<ClassRow>();
  if (result.results.length !== uniqueIds.length) throw new RegistrationSubmissionError("invalid_class");
  return result.results;
}

export const acquireAllRequestedSeatsSql = `
  WITH requested AS MATERIALIZED (
    SELECT selected_class_session_id AS class_session_id, COUNT(*) AS requested_count
    FROM registration_draft_child
    WHERE registration_draft_id = ? AND selected_class_session_id IS NOT NULL
    GROUP BY selected_class_session_id
  ),
  confirmed AS MATERIALIZED (
    SELECT enrollment.class_session_id, COUNT(*) AS count
    FROM enrollment
    INNER JOIN application_child ON application_child.id = enrollment.application_child_id
    INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
    WHERE enrollment.status = 'confirmed'
      AND application_child.status = 'enrolled'
      AND pre_registration.deleted_at IS NULL
    GROUP BY enrollment.class_session_id
  ),
  legacy_holds AS MATERIALIZED (
    SELECT enrollment.class_session_id, COUNT(*) AS count
    FROM enrollment
    INNER JOIN application_child ON application_child.id = enrollment.application_child_id
    INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
    WHERE enrollment.status = 'awaiting_initial_payment'
      AND application_child.status = 'hold_created'
      AND pre_registration.deleted_at IS NULL
    GROUP BY enrollment.class_session_id
  ),
  draft_holds AS MATERIALIZED (
    SELECT registration_capacity_hold.class_session_id, COUNT(*) AS count
    FROM registration_capacity_hold
    LEFT JOIN registration_draft_child
      ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
    WHERE registration_capacity_hold.status = 'active'
      AND (registration_capacity_hold.hold_type = 'initial_payment'
        OR registration_capacity_hold.deadline_at > ?)
      AND registration_draft_child.canonical_enrollment_id IS NULL
    GROUP BY registration_capacity_hold.class_session_id
  ),
  waitlist_offers AS MATERIALIZED (
    SELECT class_session_id, COUNT(*) AS count FROM waitlist_seat_offer
    WHERE status IN ('active', 'awaiting_transfer') GROUP BY class_session_id
  ),
  capacity_ok AS MATERIALIZED (
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM requested
      INNER JOIN class_session ON class_session.id = requested.class_session_id
      LEFT JOIN confirmed ON confirmed.class_session_id = requested.class_session_id
      LEFT JOIN legacy_holds ON legacy_holds.class_session_id = requested.class_session_id
      LEFT JOIN draft_holds ON draft_holds.class_session_id = requested.class_session_id
      LEFT JOIN waitlist_offers ON waitlist_offers.class_session_id = requested.class_session_id
      WHERE class_session.status NOT IN ('available', 'full')
        OR class_session.capacity - COALESCE(confirmed.count, 0)
          - COALESCE(legacy_holds.count, 0) - COALESCE(draft_holds.count, 0) - COALESCE(waitlist_offers.count, 0)
          < requested.requested_count
    ) THEN 0 ELSE 1 END AS ok
  )
  INSERT INTO registration_capacity_hold (
    id, registration_draft_child_id, class_session_id, hold_type, status,
    deadline_at, is_test, test_run_id, created_at, updated_at
  )
  SELECT registration_draft_child.id || ':hold', registration_draft_child.id,
    registration_draft_child.selected_class_session_id,
    'initial_payment', 'active', ?, registration_draft_child.is_test,
    registration_draft_child.test_run_id, ?, ?
  FROM registration_draft_child
  WHERE registration_draft_child.registration_draft_id = ?
    AND registration_draft_child.selected_class_session_id IS NOT NULL
    AND (SELECT ok FROM capacity_ok) = 1
`;

export async function createRegistrationDraft(
  env: WorkerEnv,
  rawInput: RegistrationSubmissionInput,
  nowDate = new Date(),
  options: RegistrationSubmissionOptions = {},
) {
  if (!registrationWriteEnabled(env)) throw new RegistrationSubmissionError("disabled");
  const input = validateSubmission(rawInput);
  const idempotencyKey = normalizedIdempotencyKey(options.idempotencyKey);
  const parentRulesVersion = clean(input.parentRulesVersion, 120) || rulesContent.parent.version;
  const studentRulesVersion = clean(input.studentRulesVersion, 120) || rulesContent.student.version;
  try { await assertCourseRuleVersions(env, parentRulesVersion, studentRulesVersion); }
  catch (error) { if (error instanceof PublicContentError) throw new RegistrationSubmissionError("invalid_rules_version"); throw error; }
  const classIds = input.children.flatMap((child) => [
    child.selectedClassSessionId ?? "",
    child.preferredWaitlistClassSessionId ?? "",
  ]);
  const classes = await loadChosenClasses(env, classIds, mongoliaCivilDate(nowDate));
  const classById = new Map(classes.map((item) => [item.id, item]));
  const yearIds = new Set(classes.map((item) => item.academicYearId));
  if (yearIds.size !== 1 || classes.some((item) => !["available", "full"].includes(item.status))) {
    throw new RegistrationSubmissionError("invalid_class");
  }
  if (classes.some((item) => item.registrationWindowActive !== 1)) {
    throw new RegistrationSubmissionError("registration_closed");
  }
  const provenance = sourceProvenance(classes, env.APP_ENV);
  for (const child of input.children) {
    for (const id of [child.selectedClassSessionId, child.preferredWaitlistClassSessionId]) {
      if (id && classById.get(id)?.stageCode !== child.selectedStageCode) {
        throw new RegistrationSubmissionError("invalid_class_stage");
      }
    }
  }
  const paymentSettings = await getPaymentCollectionSettings(env);
  const paymentSnapshots = input.children.map((child) => {
    if (!child.selectedClassSessionId) return null;
    const selected = classById.get(child.selectedClassSessionId);
    if (!selected || !paymentSettings.complete || !selected.oneTimeAmountMnt || selected.oneTimeAmountMnt < 1) {
      throw new RegistrationSubmissionError("pricing_unavailable");
    }
    if (child.paymentPlanCode === "single") return { code: "single" as const, initial: selected.oneTimeAmountMnt, second: null, due: null };
    if (child.paymentPlanCode === "two_installment" && selected.twoInstallmentEnabled
      && selected.firstInstallmentAmountMnt && selected.secondInstallmentAmountMnt && selected.secondInstallmentDueOn) {
      return { code: "two_installment" as const, initial: selected.firstInstallmentAmountMnt,
        second: selected.secondInstallmentAmountMnt, due: selected.secondInstallmentDueOn };
    }
    throw new RegistrationSubmissionError("invalid_payment_plan");
  });

  const referralCodes = await activeReferralCodes(env.DB, input.children.map((child) => child.codeInput ?? ""), provenance);
  const referrals = input.children.map((child) => {
    const code = normalizeReferralCode(child.codeInput);
    if (!code) return null;
    const referral = referralCodes.get(code);
    if (!referral) throw new RegistrationSubmissionError("invalid_referral_code");
    return referral;
  });

  const now = nowDate.toISOString();
  const paymentDeadline = await getInitialPaymentDeadlineSettingFromDatabase(env.DB);
  const paymentReminder = await getPaymentReminderSetting(env);
  const paymentDeadlineAt = addSeconds(nowDate, paymentDeadline.deadlineMinutes * 60);
  const initialReminderAt = addSeconds(nowDate, (paymentDeadline.deadlineMinutes - paymentReminder.initialReminderLeadMinutes) * 60);
  const expiresAt = addSeconds(nowDate, REGISTRATION_DRAFT_TTL_SECONDS);
  const draftId = crypto.randomUUID();
  const testRunId = provenance.isTest ? `registration:${draftId}` : null;
  const rawAccessToken = randomToken();
  const accessTokenHash = await sha256(rawAccessToken);
  const normalizedEmail = normalizeEmail(input.guardian.email);
  const childIds = input.children.map(() => crypto.randomUUID());
  const selectedSeatCount = input.children.filter((child) => child.selectedClassSessionId).length;
  const paymentRequestId = crypto.randomUUID();
  const reference = await unusedPaymentReference(env.DB);
  const description = await transferDescription(env.DB, input.children[0]?.givenName || "Хүүхэд", input.guardian.primaryPhone);

  async function existingIdempotentDraft() {
    if (!idempotencyKey) return null;
    return env.DB.prepare(`SELECT registration_draft.id AS draftId,
      registration_draft.email AS email,
      MAX(CASE WHEN registration_capacity_hold.status = 'active'
        AND registration_capacity_hold.hold_type = 'initial_payment'
        THEN registration_capacity_hold.deadline_at ELSE NULL END) AS paymentDeadlineAt
      FROM registration_draft
      LEFT JOIN registration_draft_child ON registration_draft_child.registration_draft_id = registration_draft.id
      LEFT JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      WHERE registration_draft.submission_idempotency_key = ?
      GROUP BY registration_draft.id`).bind(idempotencyKey).first<{
      draftId: string;
      email: string;
      paymentDeadlineAt: string | null;
    }>();
  }

  const existing = await existingIdempotentDraft();
  if (existing) {
    return {
      draftId: existing.draftId,
      email: existing.email,
      normalizedEmail: normalizeEmail(existing.email),
      hasPaymentHold: Boolean(existing.paymentDeadlineAt),
      paymentDeadlineAt: existing.paymentDeadlineAt,
      paymentReference: null,
      accessCookie: null,
      created: false,
    };
  }

  const statements = [env.DB.prepare(`
    INSERT INTO registration_draft (
      id, access_token_hash, academic_year_id, guardian_full_name,
      guardian_relationship, primary_phone, secondary_phone, email,
      normalized_email, facebook_name, home_address, payment_plan_code,
      parent_rules_version, student_rules_version, status, expires_at,
      submission_idempotency_key, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_initial_payment', ?, ?, ?, ?, ?, ?)
  `).bind(
    draftId, accessTokenHash, [...yearIds][0], input.guardian.fullName,
    input.guardian.relationship, input.guardian.primaryPhone, input.guardian.secondaryPhone || null,
    input.guardian.email, normalizedEmail, input.guardian.facebookName || null,
    input.guardian.homeAddress, "per_child", parentRulesVersion,
    studentRulesVersion, expiresAt, idempotencyKey, provenance.isTest, testRunId, now, now,
  )];

  input.children.forEach((child, index) => {
    statements.push(env.DB.prepare(`
      INSERT INTO registration_draft_child (
        id, registration_draft_id, position, surname, given_name, gender,
        date_of_birth, current_grade, current_school, facebook_name, returning_status,
        previous_stage_code, selected_stage_code, selected_class_session_id,
        preferred_waitlist_class_session_id, code_input, payment_plan_code,
        initial_payment_amount_mnt, second_payment_amount_mnt, second_payment_due_on, status, is_test,
        test_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).bind(
      childIds[index], draftId, index, child.surname, child.givenName, child.gender,
      child.dateOfBirth, child.currentGrade, child.currentSchool || null, child.facebookName || null,
      child.returningStatus, child.previousStageCode || null, child.selectedStageCode,
      child.selectedClassSessionId || null, child.preferredWaitlistClassSessionId || null,
      child.codeInput || null, paymentSnapshots[index]?.code ?? null, paymentSnapshots[index]?.initial ?? null,
      paymentSnapshots[index]?.second ?? null, paymentSnapshots[index]?.due ?? null,
      provenance.isTest, testRunId, now, now,
    ));
  });

  referrals.forEach((referral, index) => {
    if (!referral) return;
    statements.push(env.DB.prepare(`INSERT INTO registration_draft_referral (
      registration_draft_child_id, referral_code_id, referring_enrollment_id,
      captured_code, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'captured', ?, ?, ?, ?)`)
      .bind(childIds[index], referral.id, referral.enrollmentId, referral.code,
        provenance.isTest, testRunId, now, now));
  });

  const seatHoldStatementIndex = statements.length;
  statements.push(env.DB.prepare(acquireAllRequestedSeatsSql).bind(
    draftId, now, paymentDeadlineAt, now, now, draftId,
  ));
  statements.push(env.DB.prepare(`
    UPDATE registration_draft_child
    SET status = 'awaiting_initial_payment', updated_at = ?
    WHERE registration_draft_id = ?
      AND EXISTS (
        SELECT 1 FROM registration_capacity_hold
        WHERE registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
          AND registration_capacity_hold.status = 'active'
      )
  `).bind(now, draftId));
  statements.push(env.DB.prepare(`
    INSERT OR IGNORE INTO registration_draft_waitlist_entry (
      id, registration_draft_child_id, class_session_id, status, is_test, test_run_id, created_at, updated_at
    ) SELECT registration_draft_child.id || ':waitlist', registration_draft_child.id,
      registration_draft_child.preferred_waitlist_class_session_id, 'active', registration_draft_child.is_test,
      registration_draft_child.test_run_id, ?, ?
    FROM registration_draft_child
    INNER JOIN class_session ON class_session.id = registration_draft_child.preferred_waitlist_class_session_id
    WHERE registration_draft_child.registration_draft_id = ?
      AND registration_draft_child.preferred_waitlist_class_session_id IS NOT NULL
      AND class_session.status IN ('available', 'full')
  `).bind(now, now, draftId));
  statements.push(env.DB.prepare(`
    INSERT INTO payment_request (id, registration_draft_id, payment_reference, transfer_description, created_at, updated_at, is_test, test_run_id)
    SELECT ?, registration_draft.id, ?, ?, ?, ?, registration_draft.is_test, registration_draft.test_run_id
    FROM registration_draft WHERE registration_draft.id = ? AND EXISTS (
      SELECT 1 FROM registration_capacity_hold
      INNER JOIN registration_draft_child ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
      WHERE registration_draft_child.registration_draft_id = registration_draft.id
        AND registration_capacity_hold.hold_type = 'initial_payment' AND registration_capacity_hold.status = 'active'
    )
  `).bind(paymentRequestId, reference, description, now, now, draftId));
  statements.push(env.DB.prepare(`
    INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind,
      amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id)
    SELECT registration_draft_child.id || ':initial-installment', ?, registration_draft_child.id, 1, 'initial',
      registration_draft_child.initial_payment_amount_mnt, ?, ?, ?, ?, 'pending', ?, ?, registration_draft_child.is_test, registration_draft_child.test_run_id
    FROM registration_draft_child WHERE registration_draft_child.registration_draft_id = ?
      AND registration_draft_child.selected_class_session_id IS NOT NULL AND registration_draft_child.initial_payment_amount_mnt IS NOT NULL
      AND EXISTS (SELECT 1 FROM payment_request WHERE id = ?)
  `).bind(paymentRequestId, paymentDeadlineAt, paymentDeadlineAt, paymentReminder.initialReminderLeadMinutes, initialReminderAt, now, now, draftId, paymentRequestId));
  statements.push(env.DB.prepare(`
    INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind,
      amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id)
    SELECT registration_draft_child.id || ':later-installment', ?, registration_draft_child.id, 2, 'later',
      registration_draft_child.second_payment_amount_mnt, registration_draft_child.second_payment_due_on,
      registration_draft_child.second_payment_due_on, ?, strftime('%Y-%m-%dT%H:%M:%fZ', datetime(registration_draft_child.second_payment_due_on, '-' || ? || ' minutes')), 'pending', ?, ?, registration_draft_child.is_test, registration_draft_child.test_run_id
    FROM registration_draft_child WHERE registration_draft_child.registration_draft_id = ?
      AND registration_draft_child.second_payment_amount_mnt IS NOT NULL AND registration_draft_child.second_payment_due_on IS NOT NULL
      AND EXISTS (SELECT 1 FROM payment_request WHERE id = ?)
  `).bind(paymentRequestId, paymentReminder.laterReminderLeadMinutes, paymentReminder.laterReminderLeadMinutes, now, now, draftId, paymentRequestId));

  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    const duplicate = await existingIdempotentDraft();
    if (duplicate) {
      return {
        draftId: duplicate.draftId,
        email: duplicate.email,
        normalizedEmail: normalizeEmail(duplicate.email),
        hasPaymentHold: Boolean(duplicate.paymentDeadlineAt),
        paymentDeadlineAt: duplicate.paymentDeadlineAt,
        paymentReference: null,
        accessCookie: null,
        created: false,
      };
    }
    throw error;
  }
  const holdResult = results[seatHoldStatementIndex];
  const heldSeatCount = changeCount(holdResult);
  if (selectedSeatCount > 0 && heldSeatCount !== selectedSeatCount) {
    await env.DB.batch([
      env.DB.prepare("UPDATE registration_draft SET status = 'seat_unavailable', updated_at = ? WHERE id = ?").bind(now, draftId),
      env.DB.prepare("UPDATE registration_draft_child SET status = 'seat_unavailable', updated_at = ? WHERE registration_draft_id = ? AND selected_class_session_id IS NOT NULL").bind(now, draftId),
    ]);
    throw new RegistrationSubmissionError("capacity_changed");
  }
  if (selectedSeatCount === 0) {
    await env.DB.prepare(`UPDATE registration_draft SET status = 'waitlisted', updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM registration_draft_waitlist_entry
        INNER JOIN registration_draft_child ON registration_draft_child.id = registration_draft_waitlist_entry.registration_draft_child_id
        WHERE registration_draft_child.registration_draft_id = registration_draft.id
          AND registration_draft_waitlist_entry.status = 'active')`).bind(now, draftId).run();
  }

  return {
    draftId,
    email: input.guardian.email,
    normalizedEmail,
    hasPaymentHold: heldSeatCount > 0,
    paymentDeadlineAt: heldSeatCount > 0 ? paymentDeadlineAt : null,
    paymentReference: heldSeatCount > 0 ? description : null,
    accessCookie: registrationDraftCookie(rawAccessToken, true),
    created: true,
  };
}

export async function markRegistrationEmailSent(database: D1Database, draftId: string, nowDate = new Date()) {
  const now = nowDate.toISOString();
  await database.prepare(`
    UPDATE registration_draft
    SET email_last_sent_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, now, draftId).run();
}

export async function markRegistrationEmailFailed(database: D1Database, draftId: string, nowDate = new Date()) {
  const now = nowDate.toISOString();
  await database.prepare(`
    UPDATE registration_draft
    SET updated_at = ?
    WHERE id = ?
  `).bind(now, draftId).run();
}

export async function draftForAccessToken(database: D1Database, rawToken: string, nowDate = new Date()) {
  if (!rawToken || rawToken.length > 256) throw new RegistrationSubmissionError("draft_access_denied");
  const tokenHash = await sha256(rawToken);
  const row = await database.prepare(`
    SELECT id, normalized_email AS normalizedEmail, email, status,
      email_last_sent_at AS emailLastSentAt, expires_at AS expiresAt
    FROM registration_draft
    WHERE access_token_hash = ? AND expires_at > ?
  `).bind(tokenHash, nowDate.toISOString()).first<DraftAccessRow>();
  if (!row) throw new RegistrationSubmissionError("draft_access_denied");
  return row;
}

export async function pendingRegistrationForAccess(
  database: D1Database,
  rawToken: string,
  nowDate = new Date(),
) {
  const draft = await draftForAccessToken(database, rawToken, nowDate);
  const summary = await database.prepare(`
    SELECT
      MAX(CASE WHEN registration_capacity_hold.status = 'active'
        AND registration_capacity_hold.hold_type = 'initial_payment'
        AND registration_capacity_hold.deadline_at > ?
        THEN registration_capacity_hold.deadline_at ELSE NULL END) AS paymentDeadlineAt,
      SUM(CASE WHEN registration_draft_child.selected_class_session_id IS NOT NULL THEN 1 ELSE 0 END) AS selectedCount
    FROM registration_draft_child
    LEFT JOIN registration_capacity_hold
      ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
    WHERE registration_draft_child.registration_draft_id = ?
  `).bind(nowDate.toISOString(), draft.id).first<{ paymentDeadlineAt: string | null; selectedCount: number }>();
  return {
    email: draft.email,
    hasPaymentHold: Boolean(summary?.paymentDeadlineAt),
    paymentDeadlineAt: summary?.paymentDeadlineAt ?? null,
    waitlistOnly: Number(summary?.selectedCount ?? 0) === 0,
    emailDeliveryFailed: draft.status === "email_delivery_failed",
  };
}

export function enforceResendCooldown(draft: DraftAccessRow, nowDate = new Date()) {
  if (!draft.emailLastSentAt) return;
  const nextAllowed = new Date(draft.emailLastSentAt).getTime() + REGISTRATION_RESEND_COOLDOWN_SECONDS * 1000;
  if (nextAllowed > nowDate.getTime()) throw new RegistrationSubmissionError("resend_cooldown");
}

export async function claimRegistrationEmailSend(
  database: D1Database,
  draft: DraftAccessRow,
  nowDate = new Date(),
) {
  const now = nowDate.toISOString();
  const cutoff = addSeconds(nowDate, -REGISTRATION_RESEND_COOLDOWN_SECONDS);
  const result = await database.prepare(`
    UPDATE registration_draft
    SET email_last_sent_at = ?, updated_at = ?
    WHERE id = ?
      AND status NOT IN ('cancelled', 'expired')
      AND (email_last_sent_at IS NULL OR email_last_sent_at <= ?)
  `).bind(now, now, draft.id, cutoff).run();
  if (changeCount(result) !== 1) throw new RegistrationSubmissionError("resend_cooldown");
}

export async function changeDraftEmail(
  database: D1Database,
  draft: DraftAccessRow,
  emailInput: string,
  nowDate = new Date(),
) {
  const email = clean(emailInput, 254);
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) throw new RegistrationSubmissionError("invalid_email");
  const now = nowDate.toISOString();
  const cutoff = addSeconds(nowDate, -REGISTRATION_RESEND_COOLDOWN_SECONDS);
  const results = await database.batch([
    database.prepare(`
      UPDATE registration_draft
      SET email = ?, normalized_email = ?, email_last_sent_at = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('cancelled', 'expired')
        AND (email_last_sent_at IS NULL OR email_last_sent_at <= ?)
    `).bind(email, normalizedEmail, now, now, draft.id, cutoff),
    database.prepare(`
      UPDATE email_verification_challenge
      SET status = 'invalidated', invalidated_at = ?, updated_at = ?
      WHERE registration_draft_id = ? AND status = 'pending'
    `).bind(now, now, draft.id),
  ]);
  if (changeCount(results[0]) !== 1) throw new RegistrationSubmissionError("draft_not_editable");
  return { ...draft, email, normalizedEmail, emailLastSentAt: now };
}

export async function challengeForTokenHash(database: D1Database, tokenHash: string) {
  return database.prepare(`
    SELECT id, normalized_email AS normalizedEmail, status, expires_at AS expiresAt,
      invalidated_at AS invalidatedAt, registration_draft_id AS registrationDraftId,
      is_test AS isTest, test_run_id AS testRunId
    FROM email_verification_challenge
    WHERE token_hash = ?
  `).bind(tokenHash).first<ChallengeRow>();
}

export const reacquireAllRequestedSeatsSql = `
  WITH requested AS MATERIALIZED (
    SELECT selected_class_session_id AS class_session_id, COUNT(*) AS requested_count
    FROM registration_draft_child
    WHERE registration_draft_id = ? AND selected_class_session_id IS NOT NULL
    GROUP BY selected_class_session_id
  ),
  confirmed AS MATERIALIZED (
    SELECT enrollment.class_session_id, COUNT(*) AS count
    FROM enrollment
    INNER JOIN application_child ON application_child.id = enrollment.application_child_id
    INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
    WHERE enrollment.status = 'confirmed' AND application_child.status = 'enrolled'
      AND pre_registration.deleted_at IS NULL
    GROUP BY enrollment.class_session_id
  ),
  legacy_holds AS MATERIALIZED (
    SELECT enrollment.class_session_id, COUNT(*) AS count
    FROM enrollment
    INNER JOIN application_child ON application_child.id = enrollment.application_child_id
    INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
    WHERE enrollment.status = 'awaiting_initial_payment'
      AND application_child.status = 'hold_created'
      AND pre_registration.deleted_at IS NULL
    GROUP BY enrollment.class_session_id
  ),
  other_draft_holds AS MATERIALIZED (
    SELECT registration_capacity_hold.class_session_id, COUNT(*) AS count
    FROM registration_capacity_hold
    INNER JOIN registration_draft_child
      ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
    WHERE registration_capacity_hold.status = 'active'
      AND (registration_capacity_hold.hold_type = 'initial_payment'
        OR registration_capacity_hold.deadline_at > ?)
      AND registration_draft_child.registration_draft_id != ?
      AND registration_draft_child.canonical_enrollment_id IS NULL
    GROUP BY registration_capacity_hold.class_session_id
  ),
  waitlist_offers AS MATERIALIZED (
    SELECT class_session_id, COUNT(*) AS count FROM waitlist_seat_offer
    WHERE status IN ('active', 'awaiting_transfer') GROUP BY class_session_id
  ),
  capacity_ok AS MATERIALIZED (
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM requested
      INNER JOIN class_session ON class_session.id = requested.class_session_id
      LEFT JOIN confirmed ON confirmed.class_session_id = requested.class_session_id
      LEFT JOIN legacy_holds ON legacy_holds.class_session_id = requested.class_session_id
      LEFT JOIN other_draft_holds ON other_draft_holds.class_session_id = requested.class_session_id
      LEFT JOIN waitlist_offers ON waitlist_offers.class_session_id = requested.class_session_id
      WHERE class_session.status NOT IN ('available', 'full')
        OR class_session.capacity - COALESCE(confirmed.count, 0)
          - COALESCE(legacy_holds.count, 0) - COALESCE(other_draft_holds.count, 0) - COALESCE(waitlist_offers.count, 0)
          < requested.requested_count
    ) THEN 0 ELSE 1 END AS ok
  )
  UPDATE registration_capacity_hold
  SET hold_type = 'initial_payment', status = 'active', deadline_at = ?,
    converted_at = ?, updated_at = ?
  WHERE registration_draft_child_id IN (
    SELECT id FROM registration_draft_child
    WHERE registration_draft_id = ? AND selected_class_session_id IS NOT NULL
  ) AND (SELECT ok FROM capacity_ok) = 1
`;

export async function confirmRegistrationChallenge(
  env: WorkerEnv,
  challenge: ChallengeRow,
  session: { id: string; tokenHash: string; createdAt: string; expiresAt: string },
  nowDate = new Date(),
) {
  if (!challenge.registrationDraftId) throw new RegistrationSubmissionError("challenge_not_registration");
  const draftId = challenge.registrationDraftId;
  const now = nowDate.toISOString();
  const paymentDeadline = await getInitialPaymentDeadlineSettingFromDatabase(env.DB);
  const paymentReminder = await getPaymentReminderSetting(env);
  const paymentDeadlineAt = addSeconds(nowDate, paymentDeadline.deadlineMinutes * 60);
  const initialReminderAt = addSeconds(nowDate, (paymentDeadline.deadlineMinutes - paymentReminder.initialReminderLeadMinutes) * 60);
  const paymentRequestId = crypto.randomUUID();
  const reference = await unusedPaymentReference(env.DB);
  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN selected_class_session_id IS NOT NULL THEN 1 ELSE 0 END) AS selectedCount,
      SUM(CASE WHEN preferred_waitlist_class_session_id IS NOT NULL THEN 1 ELSE 0 END) AS waitlistCount,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM registration_draft_waitlist_entry
        WHERE registration_draft_waitlist_entry.registration_draft_child_id = registration_draft_child.id
          AND registration_draft_waitlist_entry.status = 'active') THEN 1 ELSE 0 END) AS activeWaitlistCount,
      SUM(CASE WHEN selected_class_session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM registration_capacity_hold
        WHERE registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
          AND registration_capacity_hold.status = 'active'
          AND registration_capacity_hold.hold_type = 'provisional_email_confirmation'
          AND registration_capacity_hold.deadline_at > ?
      ) THEN 1 ELSE 0 END) AS timelyCount,
      SUM(CASE WHEN selected_class_session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM registration_capacity_hold
        WHERE registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
          AND registration_capacity_hold.status = 'active'
          AND registration_capacity_hold.hold_type = 'initial_payment'
      ) THEN 1 ELSE 0 END) AS initialCount
    FROM registration_draft_child
    WHERE registration_draft_id = ?
  `).bind(now, draftId).first<{ selectedCount: number; waitlistCount: number; activeWaitlistCount: number; timelyCount: number; initialCount: number }>();
  if (!counts) throw new RegistrationSubmissionError("draft_not_found");
  const selectedCount = Number(counts.selectedCount || 0);
  const timely = selectedCount > 0 && Number(counts.timelyCount || 0) === selectedCount;
  const alreadyInitial = selectedCount > 0 && Number(counts.initialCount || 0) === selectedCount;

  const sessionInsert = env.DB.prepare(`
    INSERT INTO verified_email_session (
      id, normalized_email, session_token_hash, created_at, expires_at,
      revoked_at, is_test, test_run_id, registration_draft_id
    ) SELECT ?, normalized_email, ?, ?, ?, NULL, is_test, test_run_id, registration_draft_id
      FROM email_verification_challenge
      WHERE id = ? AND status = 'pending' AND expires_at > ? AND invalidated_at IS NULL
  `).bind(session.id, session.tokenHash, session.createdAt, session.expiresAt, challenge.id, now);
  const challengeUpdate = env.DB.prepare(`
    UPDATE email_verification_challenge
    SET status = 'used', used_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending' AND expires_at > ? AND invalidated_at IS NULL
  `).bind(now, now, challenge.id, now);
  const holdUpdate = alreadyInitial
    ? env.DB.prepare("UPDATE registration_capacity_hold SET updated_at = updated_at WHERE 1 = 0")
    : timely
    ? env.DB.prepare(`
        UPDATE registration_capacity_hold
        SET hold_type = 'initial_payment', deadline_at = ?, converted_at = ?, updated_at = ?
        WHERE registration_draft_child_id IN (
          SELECT id FROM registration_draft_child WHERE registration_draft_id = ?
            AND selected_class_session_id IS NOT NULL
        ) AND status = 'active' AND hold_type = 'provisional_email_confirmation' AND deadline_at > ?
      `).bind(paymentDeadlineAt, now, now, draftId, now)
    : env.DB.prepare(reacquireAllRequestedSeatsSql).bind(
        draftId, now, draftId, paymentDeadlineAt, now, now, draftId,
      );
  const waitlistInsert = env.DB.prepare(`
    INSERT OR IGNORE INTO registration_draft_waitlist_entry (
      id, registration_draft_child_id, class_session_id, status, is_test,
      test_run_id, created_at, updated_at
    )
    SELECT registration_draft_child.id || ':waitlist', registration_draft_child.id,
      registration_draft_child.preferred_waitlist_class_session_id, 'active', registration_draft_child.is_test,
      registration_draft_child.test_run_id, ?, ?
    FROM registration_draft_child
    INNER JOIN class_session
      ON class_session.id = registration_draft_child.preferred_waitlist_class_session_id
    WHERE registration_draft_child.registration_draft_id = ?
      AND registration_draft_child.preferred_waitlist_class_session_id IS NOT NULL
      AND class_session.status IN ('available', 'full')
  `).bind(now, now, draftId);
  const draftVerified = env.DB.prepare(`
    UPDATE registration_draft
    SET verified_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, now, draftId);

  const paymentRequest = env.DB.prepare(`
    INSERT OR IGNORE INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
    SELECT ?, registration_draft.id, ?, ?, ?, registration_draft.is_test, registration_draft.test_run_id
    FROM registration_draft
    WHERE registration_draft.id = ? AND EXISTS (
      SELECT 1 FROM registration_capacity_hold
      INNER JOIN registration_draft_child ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
      WHERE registration_draft_child.registration_draft_id = registration_draft.id
        AND registration_capacity_hold.hold_type = 'initial_payment' AND registration_capacity_hold.status = 'active'
    )
  `).bind(paymentRequestId, reference, now, now, draftId);
  const initialInstallments = env.DB.prepare(`
    INSERT OR IGNORE INTO payment_installment (
      id, payment_request_id, registration_draft_child_id, installment_number, installment_kind,
      amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id
    ) SELECT registration_draft_child.id || ':initial-installment', ?, registration_draft_child.id, 1, 'initial',
      registration_draft_child.initial_payment_amount_mnt, ?, ?, ?, ?, 'pending', ?, ?, registration_draft_child.is_test,
      registration_draft_child.test_run_id
    FROM registration_draft_child
    WHERE registration_draft_child.registration_draft_id = ?
      AND registration_draft_child.selected_class_session_id IS NOT NULL
      AND registration_draft_child.initial_payment_amount_mnt IS NOT NULL
      AND EXISTS (SELECT 1 FROM payment_request WHERE id = ?)
  `).bind(paymentRequestId, paymentDeadlineAt, paymentDeadlineAt, paymentReminder.initialReminderLeadMinutes, initialReminderAt, now, now, draftId, paymentRequestId);
  const laterInstallments = env.DB.prepare(`
    INSERT OR IGNORE INTO payment_installment (
      id, payment_request_id, registration_draft_child_id, installment_number, installment_kind,
      amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id
    ) SELECT registration_draft_child.id || ':later-installment', ?, registration_draft_child.id, 2, 'later',
      registration_draft_child.second_payment_amount_mnt,
      registration_draft_child.second_payment_due_on || '9999-12-31',
      registration_draft_child.second_payment_due_on || '9999-12-31', ?, strftime('%Y-%m-%dT%H:%M:%fZ', datetime(registration_draft_child.second_payment_due_on, '-' || ? || ' minutes')), 'pending', ?, ?, registration_draft_child.is_test,
      registration_draft_child.test_run_id
    FROM registration_draft_child
    WHERE registration_draft_child.registration_draft_id = ?
      AND registration_draft_child.second_payment_amount_mnt IS NOT NULL
      AND registration_draft_child.second_payment_due_on IS NOT NULL
      AND EXISTS (SELECT 1 FROM payment_request WHERE id = ?)
  `).bind(paymentRequestId, paymentReminder.laterReminderLeadMinutes, paymentReminder.laterReminderLeadMinutes, now, now, draftId, paymentRequestId);

  const results = await env.DB.batch([sessionInsert, challengeUpdate, holdUpdate, waitlistInsert, draftVerified, paymentRequest, initialInstallments, laterInstallments]);
  if (changeCount(results[0]) !== 1 || changeCount(results[1]) !== 1 || changeCount(results[4]) !== 1) {
    throw new RegistrationSubmissionError("invalid_or_expired_token");
  }
  const heldSeatCount = changeCount(results[2]);
  const waitlistCount = changeCount(results[3]);
  const allSeatsHeld = selectedCount === 0 || alreadyInitial || heldSeatCount === selectedCount;
  const draftStatus = selectedCount > 0 && allSeatsHeld
    ? "awaiting_initial_payment"
    : selectedCount === 0 && (waitlistCount > 0 || Number(counts.activeWaitlistCount || 0) > 0)
      ? "waitlisted"
      : "seat_unavailable";

  await env.DB.batch([
    env.DB.prepare("UPDATE registration_draft SET status = ?, updated_at = ? WHERE id = ?").bind(draftStatus, now, draftId),
    env.DB.prepare(`
      UPDATE registration_draft_child SET status = 'awaiting_initial_payment', updated_at = ?
      WHERE registration_draft_id = ? AND EXISTS (
        SELECT 1 FROM registration_capacity_hold
        WHERE registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
          AND registration_capacity_hold.status = 'active'
          AND registration_capacity_hold.hold_type = 'initial_payment'
      )
    `).bind(now, draftId),
    env.DB.prepare(`
      UPDATE registration_draft_child SET status = 'waitlisted', updated_at = ?
      WHERE registration_draft_id = ? AND selected_class_session_id IS NULL AND EXISTS (
        SELECT 1 FROM registration_draft_waitlist_entry
        WHERE registration_draft_waitlist_entry.registration_draft_child_id = registration_draft_child.id
          AND registration_draft_waitlist_entry.status = 'active'
      )
    `).bind(now, draftId),
    env.DB.prepare(`
      UPDATE registration_draft_child SET status = 'seat_unavailable', updated_at = ?
      WHERE registration_draft_id = ? AND selected_class_session_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM registration_capacity_hold
          WHERE registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
            AND registration_capacity_hold.status = 'active'
            AND registration_capacity_hold.hold_type = 'initial_payment'
        )
    `).bind(now, draftId),
    env.DB.prepare(`
      UPDATE registration_capacity_hold SET status = 'expired', updated_at = ?
      WHERE registration_draft_child_id IN (
        SELECT id FROM registration_draft_child WHERE registration_draft_id = ?
      ) AND status = 'active' AND hold_type = 'provisional_email_confirmation' AND deadline_at <= ?
    `).bind(now, draftId, now),
  ]);

  return {
    draftId,
    status: draftStatus,
    hasPaymentHold: selectedCount > 0 && allSeatsHeld,
    paymentDeadlineAt: selectedCount > 0 && allSeatsHeld ? paymentDeadlineAt : null,
    lateReacquired: selectedCount > 0 && !timely && !alreadyInitial && allSeatsHeld,
  };
}

export async function sessionOwnsDraft(
  database: D1Database,
  rawSessionToken: string,
  draftId: string,
  nowDate = new Date(),
) {
  if (!rawSessionToken || rawSessionToken.length > 256) return false;
  const tokenHash = await sha256(rawSessionToken);
  const row = await database.prepare(`
    SELECT id FROM verified_email_session
    WHERE session_token_hash = ? AND registration_draft_id = ?
      AND expires_at > ? AND revoked_at IS NULL
  `).bind(tokenHash, draftId, nowDate.toISOString()).first<{ id: string }>();
  return Boolean(row);
}

async function registrationStatusForDraft(
  database: D1Database,
  draft: { id: string; email: string; status: string; verifiedAt: string | null; guardianFullName?: string; relationship?: string; primaryPhone?: string; secondaryPhone?: string | null; facebookName?: string | null; homeAddress?: string },
  nowDate: Date,
) {
  const children = await database.prepare(`
    SELECT registration_draft_child.id,
      registration_draft_child.surname,
      registration_draft_child.given_name AS givenName,
      registration_draft_child.status,
      registration_draft_child.selected_stage_code AS selectedStageCode,
      registration_draft_child.payment_plan_code AS paymentPlanCode,
      registration_draft_child.initial_payment_amount_mnt AS initialPaymentAmountMnt,
      registration_draft_child.second_payment_amount_mnt AS secondPaymentAmountMnt,
      registration_draft_child.second_payment_due_on AS secondPaymentDueOn,
      selected_class.display_label AS selectedClassLabel,
      selected_class.weekday AS selectedClassWeekday,
      selected_class.start_time AS selectedClassStartTime,
      selected_class.end_time AS selectedClassEndTime,
      preferred_class.display_label AS waitlistClassLabel,
      preferred_class.weekday AS waitlistClassWeekday,
      preferred_class.start_time AS waitlistClassStartTime,
      preferred_class.end_time AS waitlistClassEndTime,
      registration_capacity_hold.hold_type AS holdType,
      registration_capacity_hold.deadline_at AS holdDeadlineAt,
      registration_capacity_hold.status AS holdStatus,
      registration_draft_waitlist_entry.status AS waitlistStatus,
      payment_request.id AS paymentRequestId,
      COALESCE(payment_request.transfer_description, payment_request.payment_reference) AS paymentReference,
      payment_installment.status AS initialInstallmentStatus,
      enrollment.status AS canonicalEnrollmentStatus,
      enrollment.confirmed_at AS canonicalEnrollmentConfirmedAt,
      (SELECT later.amount_mnt FROM payment_installment AS later
        WHERE later.registration_draft_child_id = registration_draft_child.id
          AND later.installment_kind = 'later' ORDER BY later.installment_number LIMIT 1) AS laterInstallmentAmountMnt,
      (SELECT later.effective_due_at FROM payment_installment AS later
        WHERE later.registration_draft_child_id = registration_draft_child.id
          AND later.installment_kind = 'later' ORDER BY later.installment_number LIMIT 1) AS laterInstallmentDueAt,
      activity_offering.facebook_group_url AS offeringFacebookGroupUrl,
      enrollment_referral_code.code AS referralCode,
      EXISTS(SELECT 1 FROM payment_evidence WHERE payment_evidence.payment_request_id = payment_request.id
        AND payment_evidence.evidence_type = 'parent_claim') AS parentPaymentClaimed
    FROM registration_draft_child
    LEFT JOIN class_session AS selected_class ON selected_class.id = registration_draft_child.selected_class_session_id
    LEFT JOIN registration_draft_waitlist_entry ON registration_draft_waitlist_entry.registration_draft_child_id = registration_draft_child.id
    LEFT JOIN class_session AS preferred_class ON preferred_class.id = COALESCE(
      registration_draft_waitlist_entry.class_session_id,
      registration_draft_child.preferred_waitlist_class_session_id
    )
    LEFT JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
    LEFT JOIN payment_installment ON payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.installment_kind = 'initial'
    LEFT JOIN payment_request ON payment_request.id = payment_installment.payment_request_id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    LEFT JOIN enrollment_referral_code ON enrollment_referral_code.enrollment_id = enrollment.id
      AND enrollment_referral_code.status = 'active'
    LEFT JOIN activity_offering ON activity_offering.id = selected_class.activity_offering_id
    WHERE registration_draft_child.registration_draft_id = ?
    ORDER BY registration_draft_child.position
  `).bind(draft.id).all<Record<string, unknown>>();
  const hasActiveInitialPaymentHold = children.results.some((child) => child.holdType === "initial_payment"
    && child.holdStatus === "active");
  const paymentCollectionSettings = hasActiveInitialPaymentHold
    ? await getPaymentCollectionSettingsFromDatabase(database)
    : null;
  return { ...draft, children: children.results, now: nowDate.toISOString(),
    paymentCollection: paymentCollectionSettings?.complete ? {
      bankName: paymentCollectionSettings.bankName, accountHolderName: paymentCollectionSettings.accountHolderName,
      accountNumber: paymentCollectionSettings.accountNumber, iban: paymentCollectionSettings.iban,
      transferInstruction: paymentCollectionSettings.transferInstruction,
    } : null };
}

export async function registrationStatusForDraftId(database: D1Database, draftId: string, nowDate = new Date()) {
  const draft = await database.prepare(`SELECT id, email, status, verified_at AS verifiedAt, guardian_full_name AS guardianFullName,
    guardian_relationship AS relationship, primary_phone AS primaryPhone, secondary_phone AS secondaryPhone, facebook_name AS facebookName,
    home_address AS homeAddress FROM registration_draft WHERE id = ?`).bind(draftId)
    .first<{ id: string; email: string; status: string; verifiedAt: string | null; guardianFullName: string; relationship: string; primaryPhone: string; secondaryPhone: string | null; facebookName: string | null; homeAddress: string }>();
  if (!draft) throw new RegistrationSubmissionError("draft_access_denied");
  return registrationStatusForDraft(database, draft, nowDate);
}

export async function registrationStatusForSession(database: D1Database, rawSessionToken: string, nowDate = new Date()) {
  if (!rawSessionToken || rawSessionToken.length > 256) throw new RegistrationSubmissionError("session_required");
  const tokenHash = await sha256(rawSessionToken);
  const draft = await database.prepare(`SELECT registration_draft.id, registration_draft.email, registration_draft.status,
    registration_draft.verified_at AS verifiedAt, registration_draft.guardian_full_name AS guardianFullName,
    registration_draft.guardian_relationship AS relationship, registration_draft.primary_phone AS primaryPhone, registration_draft.secondary_phone AS secondaryPhone,
    registration_draft.facebook_name AS facebookName, registration_draft.home_address AS homeAddress FROM verified_email_session
    INNER JOIN registration_draft ON registration_draft.id = verified_email_session.registration_draft_id
    WHERE verified_email_session.session_token_hash = ? AND verified_email_session.expires_at > ?
      AND verified_email_session.revoked_at IS NULL`)
    .bind(tokenHash, nowDate.toISOString()).first<{ id: string; email: string; status: string; verifiedAt: string | null; guardianFullName: string; relationship: string; primaryPhone: string; secondaryPhone: string | null; facebookName: string | null; homeAddress: string }>();
  if (!draft) throw new RegistrationSubmissionError("session_required");
  return registrationStatusForDraft(database, draft, nowDate);
}

export async function registrationStatusForAccess(database: D1Database, rawAccessToken: string, nowDate = new Date()) {
  const access = await draftForAccessToken(database, rawAccessToken, nowDate);
  const draft = await database.prepare(`SELECT id, email, status, verified_at AS verifiedAt, guardian_full_name AS guardianFullName,
    guardian_relationship AS relationship, primary_phone AS primaryPhone, secondary_phone AS secondaryPhone, facebook_name AS facebookName,
    home_address AS homeAddress FROM registration_draft WHERE id = ?`)
    .bind(access.id).first<{ id: string; email: string; status: string; verifiedAt: string | null; guardianFullName: string; relationship: string; primaryPhone: string; secondaryPhone: string | null; facebookName: string | null; homeAddress: string }>();
  if (!draft) throw new RegistrationSubmissionError("draft_access_denied");
  return registrationStatusForDraft(database, draft, nowDate);
}

export async function joinOriginalClassWaitlist(
  database: D1Database,
  rawSessionToken: string,
  childId: string,
  nowDate = new Date(),
) {
  if (!rawSessionToken || rawSessionToken.length > 256 || !childId) {
    throw new RegistrationSubmissionError("session_required");
  }
  const tokenHash = await sha256(rawSessionToken);
  const now = nowDate.toISOString();
  const result = await database.prepare(`
    INSERT OR IGNORE INTO registration_draft_waitlist_entry (
      id, registration_draft_child_id, class_session_id, status, is_test,
      test_run_id, created_at, updated_at
    )
    SELECT registration_draft_child.id || ':waitlist', registration_draft_child.id,
      registration_draft_child.selected_class_session_id, 'active', registration_draft_child.is_test,
      registration_draft_child.test_run_id, ?, ?
    FROM registration_draft
    INNER JOIN registration_draft_child
      ON registration_draft_child.registration_draft_id = registration_draft.id
    INNER JOIN class_session
      ON class_session.id = registration_draft_child.selected_class_session_id
    WHERE registration_draft.access_token_hash = ?
      AND registration_draft.expires_at > ?
      AND registration_draft_child.id = ?
      AND registration_draft_child.status = 'seat_unavailable'
      AND registration_draft_child.preferred_waitlist_class_session_id IS NULL
      AND class_session.status IN ('available', 'full')
  `).bind(now, now, tokenHash, now, childId).run();
  if (changeCount(result) !== 1) throw new RegistrationSubmissionError("waitlist_unavailable");
  await database.prepare(`
    UPDATE registration_draft_child SET status = 'waitlisted', updated_at = ? WHERE id = ?
  `).bind(now, childId).run();
  await database.prepare(`
    UPDATE registration_draft
    SET status = CASE WHEN EXISTS (
      SELECT 1 FROM registration_draft_child
      WHERE registration_draft_child.registration_draft_id = registration_draft.id
        AND registration_draft_child.status = 'seat_unavailable'
    ) THEN 'seat_unavailable' ELSE 'waitlisted' END,
    updated_at = ?
    WHERE id = (SELECT registration_draft_id FROM registration_draft_child WHERE id = ?)
  `).bind(now, childId).run();
}
