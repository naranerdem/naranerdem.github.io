import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export type CoursePaymentPlanCode = "single" | "two_installment";

export interface CoursePricing {
  offeringId: string;
  oneTimeAmountMnt: number;
  twoInstallmentEnabled: boolean;
  firstInstallmentAmountMnt: number | null;
  secondInstallmentAmountMnt: number | null;
  secondInstallmentDueOn: string | null;
  updatedAt: string;
}

export interface PaymentCollectionSettings {
  bankName: string | null;
  accountHolderName: string | null;
  accountNumber: string | null;
  iban: string | null;
  transferInstruction: string | null;
  updatedAt: string;
  complete: boolean;
}

export class CoursePricingError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "not_ready" | "payment_settings_incomplete") {
    super("Course pricing operation failed.");
    this.name = "CoursePricingError";
  }
}

interface OfferingKindRow { id: string; kind: "annual_course" | "summer_course" | "event"; startsOn: string | null; endsOn: string | null; isTest: number; testRunId: string | null; }

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}
function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function complete(value: Omit<PaymentCollectionSettings, "complete">): boolean {
  return Boolean(value.bankName && value.accountHolderName && (value.accountNumber || value.iban));
}
function flags(_env: WorkerEnv, source: OfferingKindRow) {
  return { isTest: source.isTest, testRunId: source.testRunId };
}
function audit(env: WorkerEnv, actor: StaffPrincipal, action: string, subjectType: string, subjectId: string, metadata: Record<string, unknown>, provenance: { isTest: number; testRunId: string | null }, occurredAt: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), occurredAt, actor.staffAccountId, action, subjectType, subjectId,
      JSON.stringify(metadata), env.APP_ENV, provenance.isTest, provenance.testRunId, occurredAt);
}

async function offering(env: WorkerEnv, offeringId: string): Promise<OfferingKindRow> {
  const row = await env.DB.prepare(`SELECT id, kind, starts_on AS startsOn, ends_on AS endsOn,
    is_test AS isTest, test_run_id AS testRunId
    FROM activity_offering WHERE id = ?`).bind(offeringId).first<OfferingKindRow>();
  if (!row) throw new CoursePricingError("not_found");
  if (row.kind === "event") throw new CoursePricingError("invalid");
  return row;
}

export async function getPaymentCollectionSettingsFromDatabase(database: D1Database): Promise<PaymentCollectionSettings> {
  const row = await database.prepare(`SELECT bank_name AS bankName, account_holder_name AS accountHolderName,
    account_number AS accountNumber, iban, transfer_instruction AS transferInstruction, updated_at AS updatedAt
    FROM payment_collection_settings WHERE singleton = 1`).first<Omit<PaymentCollectionSettings, "complete">>();
  if (!row) throw new CoursePricingError("not_ready");
  return { ...row, complete: complete(row) };
}

export async function getPaymentCollectionSettings(env: WorkerEnv): Promise<PaymentCollectionSettings> {
  return getPaymentCollectionSettingsFromDatabase(env.DB);
}

export async function getCoursePricing(env: WorkerEnv, offeringId: string): Promise<CoursePricing | null> {
  const row = await env.DB.prepare(`SELECT activity_offering_id AS offeringId,
    one_time_amount_mnt AS oneTimeAmountMnt, two_installment_enabled AS twoInstallmentEnabled,
    first_installment_amount_mnt AS firstInstallmentAmountMnt,
    second_installment_amount_mnt AS secondInstallmentAmountMnt,
    second_installment_due_on AS secondInstallmentDueOn, updated_at AS updatedAt
    FROM offering_course_pricing WHERE activity_offering_id = ?`).bind(offeringId).first<Omit<CoursePricing, "twoInstallmentEnabled"> & { twoInstallmentEnabled: number }>();
  return row ? { ...row, twoInstallmentEnabled: Boolean(row.twoInstallmentEnabled) } : null;
}

export async function saveCoursePricing(env: WorkerEnv, actor: StaffPrincipal, input: {
  offeringId: string; oneTimeAmountMnt: number; twoInstallmentEnabled: boolean;
  firstInstallmentAmountMnt?: number | null; secondInstallmentAmountMnt?: number | null;
  secondInstallmentDueOn?: string | null; expectedUpdatedAt?: string | null;
}): Promise<CoursePricing> {
  if (!hasStaffCapability(actor, "payment.manage")) throw new CoursePricingError("forbidden");
  const source = await offering(env, input.offeringId);
  const oneTime = positiveInteger(input.oneTimeAmountMnt);
  const first = positiveInteger(input.firstInstallmentAmountMnt);
  const second = positiveInteger(input.secondInstallmentAmountMnt);
  const due = text(input.secondInstallmentDueOn, 10);
  if (!oneTime || (input.twoInstallmentEnabled && (!first || !second || !validDate(due)))) throw new CoursePricingError("invalid");
  if (input.twoInstallmentEnabled && due && source.startsOn && due < source.startsOn) throw new CoursePricingError("invalid");
  const current = await getCoursePricing(env, source.id);
  if (current && (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt)) throw new CoursePricingError("conflict");
  const now = new Date().toISOString();
  const values = [oneTime, input.twoInstallmentEnabled ? 1 : 0, input.twoInstallmentEnabled ? first : null,
    input.twoInstallmentEnabled ? second : null, input.twoInstallmentEnabled ? due : null];
  const statement = current
    ? env.DB.prepare(`UPDATE offering_course_pricing SET one_time_amount_mnt = ?, two_installment_enabled = ?,
        first_installment_amount_mnt = ?, second_installment_amount_mnt = ?, second_installment_due_on = ?, updated_at = ?
        WHERE activity_offering_id = ? AND updated_at = ?`).bind(...values, now, source.id, current.updatedAt)
    : env.DB.prepare(`INSERT INTO offering_course_pricing (
        activity_offering_id, one_time_amount_mnt, two_installment_enabled, first_installment_amount_mnt,
        second_installment_amount_mnt, second_installment_due_on, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(source.id, ...values, now, now);
  const results = await env.DB.batch([
    statement,
    audit(env, actor, current ? "offering_course_pricing_changed" : "offering_course_pricing_created",
      "activity_offering", source.id, { twoInstallmentEnabled: input.twoInstallmentEnabled }, flags(env, source), now),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) throw new CoursePricingError("conflict");
  return { offeringId: source.id, oneTimeAmountMnt: oneTime, twoInstallmentEnabled: input.twoInstallmentEnabled,
    firstInstallmentAmountMnt: input.twoInstallmentEnabled ? first : null,
    secondInstallmentAmountMnt: input.twoInstallmentEnabled ? second : null,
    secondInstallmentDueOn: input.twoInstallmentEnabled ? due : null, updatedAt: now };
}

export async function updatePaymentCollectionSettings(env: WorkerEnv, actor: StaffPrincipal, input: {
  bankName?: string | null; accountHolderName?: string | null; accountNumber?: string | null;
  iban?: string | null; transferInstruction?: string | null; expectedUpdatedAt: string;
}): Promise<PaymentCollectionSettings> {
  if (!hasStaffCapability(actor, "content.manage")) throw new CoursePricingError("forbidden");
  const current = await getPaymentCollectionSettings(env);
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new CoursePricingError("conflict");
  const value = { bankName: text(input.bankName, 120), accountHolderName: text(input.accountHolderName, 160),
    accountNumber: text(input.accountNumber, 120), iban: text(input.iban, 80), transferInstruction: text(input.transferInstruction, 500) };
  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE payment_collection_settings SET bank_name = ?, account_holder_name = ?, account_number = ?,
      iban = ?, transfer_instruction = ?, updated_at = ? WHERE singleton = 1 AND updated_at = ?`)
      .bind(value.bankName, value.accountHolderName, value.accountNumber, value.iban, value.transferInstruction, now, current.updatedAt),
    audit(env, actor, "payment_collection_settings_changed", "payment_collection_settings", "1",
      { bankNameConfigured: Boolean(value.bankName), accountHolderConfigured: Boolean(value.accountHolderName), accountNumberConfigured: Boolean(value.accountNumber), ibanConfigured: Boolean(value.iban) },
      { isTest: env.APP_ENV === "staging" ? 1 : 0, testRunId: env.APP_ENV === "staging" ? "staff-settings" : null }, now),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new CoursePricingError("conflict");
  return { ...value, updatedAt: now, complete: complete({ ...value, updatedAt: now }) };
}

export async function assertOfferingRegistrationReady(env: WorkerEnv, offeringId: string): Promise<void> {
  const source = await offering(env, offeringId);
  const pricing = await getCoursePricing(env, source.id);
  if (!pricing) throw new CoursePricingError("not_ready");
  const settings = await getPaymentCollectionSettings(env);
  if (!settings.complete) throw new CoursePricingError("payment_settings_incomplete");
}
