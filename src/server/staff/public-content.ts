import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export type CourseRuleCode = "guardian" | "student";

export interface PublicCenterInformation {
  phone: string | null; publicEmail: string | null; facebookPageUrl: string | null; physicalAddress: string | null;
  homepageIntro: string | null; aboutCenterText: string | null; teacherBio: string | null; updatedAt: string;
}
export interface CourseRule { code: CourseRuleCode; title: string; versionId: string; bodyText: string; updatedAt: string; }
export class PublicContentError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict" | "not_found") { super("Public content operation failed."); }
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}
function validUrl(value: string | null): boolean { try { return !value || new URL(value).protocol === "https:"; } catch { return false; } }
function audit(env: WorkerEnv, actor: StaffPrincipal, action: string, subjectType: string, subjectId: string, metadata: Record<string, unknown>, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at)
    VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, subjectType, subjectId, JSON.stringify(metadata), env.APP_ENV, isTest, isTest ? "public-content" : null, now);
}

export async function getPublicCenterInformation(env: WorkerEnv): Promise<PublicCenterInformation> {
  const row = await env.DB.prepare(`SELECT phone, public_email AS publicEmail, facebook_page_url AS facebookPageUrl,
    physical_address AS physicalAddress, homepage_intro AS homepageIntro, about_center_text AS aboutCenterText,
    teacher_bio AS teacherBio, updated_at AS updatedAt FROM public_center_information WHERE singleton = 1`).first<PublicCenterInformation>();
  if (!row) throw new PublicContentError("not_found");
  return row;
}

export async function updatePublicCenterInformation(env: WorkerEnv, actor: StaffPrincipal, input: Record<string, unknown>): Promise<PublicCenterInformation> {
  if (!hasStaffCapability(actor, "content.manage")) throw new PublicContentError("forbidden");
  const current = await getPublicCenterInformation(env);
  if (input.expectedUpdatedAt !== current.updatedAt) throw new PublicContentError("conflict");
  const value = { phone: text(input.phone, 80), publicEmail: text(input.publicEmail, 200), facebookPageUrl: text(input.facebookPageUrl, 500), physicalAddress: text(input.physicalAddress, 500), homepageIntro: text(input.homepageIntro, 1000), aboutCenterText: text(input.aboutCenterText, 6000), teacherBio: text(input.teacherBio, 4000) };
  if (!validUrl(value.facebookPageUrl) || (value.publicEmail && !/^\S+@\S+\.\S+$/.test(value.publicEmail))) throw new PublicContentError("invalid");
  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE public_center_information SET phone=?, public_email=?, facebook_page_url=?, physical_address=?, homepage_intro=?, about_center_text=?, teacher_bio=?, updated_at=? WHERE singleton=1 AND updated_at=?`)
      .bind(value.phone, value.publicEmail, value.facebookPageUrl, value.physicalAddress, value.homepageIntro, value.aboutCenterText, value.teacherBio, now, current.updatedAt),
    audit(env, actor, "public_center_information_changed", "public_center_information", "1", { fields: Object.keys(value).filter((key) => value[key as keyof typeof value]) }, now),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new PublicContentError("conflict");
  return { ...value, updatedAt: now };
}

export async function getCourseRules(env: WorkerEnv): Promise<CourseRule[]> {
  const result = await env.DB.prepare(`SELECT document.code, document.title, document.updated_at AS updatedAt,
    version.id AS versionId, version.body_text AS bodyText
    FROM course_rule_document AS document JOIN course_rule_version AS version ON version.id = document.current_version_id
    ORDER BY CASE document.code WHEN 'guardian' THEN 1 ELSE 2 END`).all<CourseRule>();
  return result.results;
}
export async function assertCourseRuleVersions(env: WorkerEnv, guardianVersionId: string, studentVersionId: string): Promise<void> {
  const rows = await env.DB.prepare(`SELECT document.code, version.id AS versionId FROM course_rule_version AS version
    JOIN course_rule_document AS document ON document.id = version.course_rule_document_id
    WHERE version.id IN (?, ?)`).bind(guardianVersionId, studentVersionId).all<{ code: CourseRuleCode; versionId: string }>();
  if (rows.results.length !== 2 || !rows.results.some((row) => row.code === "guardian" && row.versionId === guardianVersionId)
    || !rows.results.some((row) => row.code === "student" && row.versionId === studentVersionId)) throw new PublicContentError("invalid");
}
export async function saveCourseRule(env: WorkerEnv, actor: StaffPrincipal, input: { code: unknown; bodyText: unknown; expectedUpdatedAt: unknown }): Promise<CourseRule> {
  if (!hasStaffCapability(actor, "content.manage")) throw new PublicContentError("forbidden");
  if (input.code !== "guardian" && input.code !== "student") throw new PublicContentError("invalid");
  const bodyText = text(input.bodyText, 12000); if (!bodyText) throw new PublicContentError("invalid");
  const document = await env.DB.prepare(`SELECT document.id, document.code, document.title, document.updated_at AS updatedAt, document.current_version_id AS versionId, version.body_text AS currentBodyText
    FROM course_rule_document AS document JOIN course_rule_version AS version ON version.id = document.current_version_id WHERE document.code = ?`).bind(input.code).first<{ id: string; code: CourseRuleCode; title: string; updatedAt: string; versionId: string; currentBodyText: string }>();
  if (!document) throw new PublicContentError("not_found");
  if (input.expectedUpdatedAt !== document.updatedAt) throw new PublicContentError("conflict");
  if (bodyText === document.currentBodyText) return { code: document.code, title: document.title, versionId: document.versionId, bodyText, updatedAt: document.updatedAt };
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText));
  const bodyHash = Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const prior = await env.DB.prepare(`SELECT id FROM course_rule_version WHERE course_rule_document_id = ? AND body_hash = ?`).bind(document.id, bodyHash).first<{ id: string }>();
  if (prior) return { code: document.code, title: document.title, versionId: prior.id, bodyText, updatedAt: document.updatedAt };
  const now = new Date().toISOString(); const versionId = crypto.randomUUID();
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO course_rule_version (id, course_rule_document_id, body_text, body_hash, created_at) VALUES (?, ?, ?, ?, ?)`).bind(versionId, document.id, bodyText, bodyHash, now),
    env.DB.prepare(`UPDATE course_rule_document SET current_version_id=?, updated_at=? WHERE id=? AND updated_at=?`).bind(versionId, now, document.id, document.updatedAt),
    audit(env, actor, "course_rule_published", "course_rule_document", document.id, { code: document.code, versionId }, now),
  ]);
  if ((result[1]?.meta?.changes ?? 0) !== 1) throw new PublicContentError("conflict");
  return { code: document.code, title: document.title, versionId, bodyText, updatedAt: now };
}
