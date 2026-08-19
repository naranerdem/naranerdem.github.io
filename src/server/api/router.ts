import type { WorkerEnv, WorkerExecutionContext } from "../env";
import { secureEqual } from "../auth/crypto";
import { EmailVerificationError, startEmailVerification, verifyEmailToken } from "../auth/email-verification";
import { VERIFIED_EMAIL_COOKIE } from "../auth/email-verification";
import { EmailConfigurationError, EmailDeliveryError } from "../email/service";
import { getRegistrationCatalog } from "../services/registration-catalog";
import { getPublicSiteModel } from "../services/public-site";
import {
  deleteRegistrationWindow,
  getRegistrationWindowOverview,
  RegistrationWindowError,
  saveRegistrationWindow,
} from "../services/registration-windows";
import { getPublishedCalendars } from "../services/published-calendar";
import {
  changeDraftEmail,
  claimRegistrationEmailSend,
  createRegistrationDraft,
  draftForAccessToken,
  markRegistrationEmailFailed,
  markRegistrationEmailSent,
  joinOriginalClassWaitlist,
  pendingRegistrationForAccess,
  readCookie,
  REGISTRATION_DRAFT_COOKIE,
  RegistrationSubmissionError,
  registrationStatusForAccess,
  type RegistrationSubmissionInput,
} from "../services/registration-submission";
import {
  claimParentPayment,
  getInitialPaymentQueue,
  markPaymentCreditRefunded,
  PaymentReconciliationError,
  recordCheckedNotFound,
  recordManualPayment,
  releaseUnpaidSeat,
  undoTentativePaymentConfirmation,
  updatePaymentConfirmationGraceSetting,
} from "../staff/payment-reconciliation";
import {
  CanonicalPromotionError,
  getPromotionReviewQueue,
  resolvePromotionIdentity,
} from "../services/canonical-enrollment-promotion";
import { TurnstileError, verifyTurnstile } from "../security/turnstile";
import { hasStaffCapability, resolveStaffPrincipal, type StaffCapability } from "../staff/authorization";
import {
  claimStaffLoginAttempt,
  clearStaffAttemptCookie,
  clearStaffSessionCookie,
  readStaffAttemptCookie,
  readStaffCookie,
  revokeStaffSession,
  revokeAllStaffSessions,
  startStaffLogin,
  verifyStaffLogin,
} from "../staff/auth";
import {
  addStaffAccountEmail,
  createStaffAccount,
  listStaffAccounts,
  removeStaffAccountEmail,
  setPrimaryStaffAccountEmail,
  setStaffAccountStatus,
  StaffAdministrationError,
  updateStaffAccount,
} from "../staff/administration";
import { requireSameOrigin, StaffRequestSecurityError } from "../staff/request-security";
import {
  listStaffSessionPolicies,
  StaffSessionPolicyError,
  updateStaffSessionPolicies,
  type StaffSessionPolicyInput,
} from "../staff/session-policy";
import { AnnualCourseStartDefaultError, updateAnnualCourseStartDefault } from "../staff/annual-course-start-default";
import { CoursePricingError, saveCoursePricing, updatePaymentCollectionSettings } from "../staff/course-pricing";
import { PublicContentError, saveCourseRule, updatePublicCenterInformation } from "../staff/public-content";
import { getCourseRules } from "../staff/public-content";
import { getTeacherDashboardPreferences, TeacherDashboardPreferencesError, updateTeacherDashboardPreferences } from "../staff/teacher-dashboard-preferences";
import { PublicQrRedirectSettingsError, updatePublicQrRedirectSettings } from "../public-qr-redirects";
import { RegistrationCorrectionError, registrationCorrectionDetail, saveRegistrationCorrection } from "../staff/registration-corrections";
import {
  CourseAttendanceError,
  cancelCourseAbsenceNotice,
  clearCourseAttendance,
  getCourseAttendanceDay,
  markUnmarkedRosterPresent,
  recordCourseAttendance,
  saveCourseAbsenceNotice,
} from "../staff/course-attendance";
import {
  assignCourseMakeupToNormalClass,
  assignCourseMakeupToSpecialOccurrence,
  cancelCourseMakeupAssignment,
  cancelSpecialCourseMakeupOccurrence,
  CourseMakeupError,
  createSpecialCourseMakeupOccurrence,
  getCourseMakeupOverview,
  resolveCourseMakeupAsNotNeeded,
  reopenCourseMakeupResolution,
} from "../staff/course-makeups";
import {
  applyDailyChange,
  DayChangeError,
  getDailyChangesOverview,
  previewDailyChange,
} from "../staff/day-changes";
import {
  ProgramCalendarError,
  cancelFutureCalendarSlot,
  changeCalendarDraft,
  createCalendarChangeDraft,
  createSummerProgramFamilyDraft,
  discardCalendarDraft,
  discardProgramFamilyDraft,
  deleteProgramDraftLesson,
  deleteSummerProgramFamilyDraft,
  deleteClassSession,
  generateCalendarDraft,
  getProgramCalendarOverview,
  publishCalendarDraft,
  publishProgramFamilyDraft,
  removeAcademicYearBreak,
  saveAcademicYearBreak,
  saveClassSession,
  insertProgramDraftLesson,
  moveProgramDraftLesson,
  renameProgramDraft,
  renameProgramDraftLesson,
  startProgramFamilyDraft,
  saveProgramFamilyPublicInformation,
} from "../staff/program-calendar";
import {
  OfferingError,
  deleteUnusedEventOffering,
  saveActivityOffering,
  removeOfferingBreak,
  saveOfferingBreak,
  saveOfferingFacebookGroup,
} from "../staff/offerings";

type ErrorCode =
  | "configuration_error"
  | "internal_error"
  | "invalid_request"
  | "method_not_allowed"
  | "not_found"
  | "registration_unavailable"
  | "forbidden"
  | "unauthorized"
  | "verification_failed";

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  if (headers) {
    const source = new Headers(headers);
    source.forEach((value, key) => {
      if (key !== "set-cookie") responseHeaders.set(key, value);
    });
    const cookieHeaders = typeof source.getSetCookie === "function"
      ? source.getSetCookie()
      : source.get("Set-Cookie") ? [source.get("Set-Cookie") as string] : [];
    for (const value of cookieHeaders) responseHeaders.append("Set-Cookie", value);
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function error(code: ErrorCode, message: string, status: number, headers?: HeadersInit): Response {
  return json({ error: { code, message } }, status, headers);
}

function methodNotAllowed(allow = "GET"): Response {
  return error("method_not_allowed", "Энэ хүсэлтийн арга одоогоор боломжгүй.", 405, { Allow: allow });
}

function authEmailAvailable(env: WorkerEnv): boolean {
  return env.EMAIL_ENABLED === "true" && env.AUTH_EMAIL_ENABLED === "true";
}

function authNotFound(): Response {
  return error("not_found", "Хүссэн API зам олдсонгүй.", 404);
}

function staffLoginAccepted(attemptCookie?: string): Response {
  return json({
    ok: true,
    message: "Хэрэв энэ хаяг идэвхтэй ажилтны бүртгэлтэй бол нэвтрэх холбоос илгээгдэнэ.",
  }, 202, attemptCookie
    ? { "Cache-Control": "no-store", "Set-Cookie": attemptCookie }
    : { "Cache-Control": "no-store" });
}

function staffSecurityError(caught: unknown): Response | null {
  if (!(caught instanceof StaffRequestSecurityError)) return null;
  return error("forbidden", "Хүсэлтийн эх сурвалжийг шалгаж чадсангүй.", 403, { "Cache-Control": "no-store" });
}

async function staffPrincipalForRequest(request: Request, env: WorkerEnv) {
  return resolveStaffPrincipal(env, readStaffCookie(request));
}

async function requireStaffCapability(
  request: Request,
  env: WorkerEnv,
  capability: StaffCapability,
): Promise<Response | null> {
  const principal = await staffPrincipalForRequest(request, env);
  if (!principal) {
    return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
  }
  if (!hasStaffCapability(principal, capability)) {
    return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  }
  return null;
}

function registrationWritesAvailable(env: WorkerEnv): boolean {
  return env.APP_ENV === "staging"
    && env.REGISTRATION_WRITE_ENABLED === "true";
}

function registrationError(caught: unknown): Response {
  if (caught instanceof TurnstileError) {
    return error("invalid_request", "Хамгаалалтын шалгалтыг дахин хийнэ үү.", 400);
  }
  if (caught instanceof RegistrationSubmissionError) {
    if (caught.code === "capacity_changed") {
      return error("registration_unavailable", "Сонгосон ангийн суудал саяхан дүүрлээ. Анги, цагаа дахин сонгоно уу.", 409);
    }
    if (caught.code === "registration_closed") {
      return error("registration_unavailable", "Энэ сургалтын бүртгэлийн хугацаа хаагдсан байна.", 409);
    }
    if (caught.code === "resend_cooldown") {
      return error("invalid_request", "И-мэйлийг дахин илгээхийн өмнө түр хүлээнэ үү.", 429);
    }
    if (["draft_access_denied", "session_required", "draft_not_editable"].includes(caught.code)) {
      return error("not_found", "Бүртгэлийн төлөв олдсонгүй.", 404);
    }
    return error("invalid_request", "Бүртгэлийн мэдээллээ шалгана уу.", 400);
  }
  if (caught instanceof EmailConfigurationError) {
    return error("configuration_error", "Баталгаажуулах и-мэйл одоогоор бэлэн биш байна.", 503);
  }
  if (caught instanceof EmailDeliveryError) {
    return error("internal_error", "Баталгаажуулах и-мэйлийг одоогоор илгээж чадсангүй.", 503);
  }
  return error("internal_error", "Бүртгэлийг одоогоор үргэлжлүүлж чадсангүй.", 500);
}

function registrationWindowError(caught: unknown): Response {
  if (caught instanceof RegistrationCorrectionError) {
    if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
    if (caught.code === "not_found") return error("not_found", "Бүртгэлийн мэдээлэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
    if (caught.code === "needs_review") return error("invalid_request", "Энэ мэдээлэл өмнөх бүртгэлтэй холбогдсон тул админ шалгаж засна.", 409, { "Cache-Control": "no-store" });
    return error("invalid_request", "Мэдээллээ шалгаад дахин оролдоно уу.", 400, { "Cache-Control": "no-store" });
  }
  if (!(caught instanceof RegistrationWindowError)) {
    return error("internal_error", "Бүртгэлийн хугацааг одоогоор хадгалж чадсангүй.", 500, { "Cache-Control": "no-store" });
  }
  if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  if (caught.code === "not_found") return error("not_found", "Бүртгэлийн хугацаа олдсонгүй.", 404, { "Cache-Control": "no-store" });
  if (caught.code === "conflict") return error("invalid_request", "Мэдээлэл өөрчлөгдсөн байна. Хуудсыг шинэчлээд шалгана уу.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "immutable") return error("invalid_request", "Өнгөрсөн хугацааг өөрчлөх боломжгүй. Идэвхтэй хугацааны эхлэх өдрийг өөрчилж болохгүй.", 409, { "Cache-Control": "no-store" });
  return error("invalid_request", "Нэр, огноо, сонгосон сургалтуудаа шалгана уу.", 400, { "Cache-Control": "no-store" });
}

function paymentReconciliationError(caught: unknown): Response {
  if (!(caught instanceof PaymentReconciliationError)) {
    return error("internal_error", "Төлбөрийн мэдээллийг одоогоор хадгалж чадсангүй.", 500, { "Cache-Control": "no-store" });
  }
  if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  if (caught.code === "not_found") return error("not_found", "Төлбөрийн мэдээлэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
  if (caught.code === "not_due") return error("invalid_request", "Төлбөрийн хугацаа дуусаагүй тул суудлыг чөлөөлөх боломжгүй.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "already_paid") return error("invalid_request", "Төлбөр бүрэн баталгаажсан тул суудлыг чөлөөлөх боломжгүй.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "conflict") return error("invalid_request", "Төлбөрийн мэдээлэл өөрчлөгдсөн байна. Дахин шалгана уу.", 409, { "Cache-Control": "no-store" });
  return error("invalid_request", "Төлбөрийн мэдээллээ шалгана уу.", 400, { "Cache-Control": "no-store" });
}

function canonicalPromotionError(caught: unknown): Response {
  if (!(caught instanceof CanonicalPromotionError)) return error("internal_error", "Бүртгэлийг баталгаажуулж чадсангүй.", 500, { "Cache-Control": "no-store" });
  if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  if (caught.code === "not_found") return error("not_found", "Бүртгэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
  if (caught.code === "not_eligible") return error("invalid_request", "Эхний төлбөр бүрэн баталгаажаагүй байна.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "invalid") return error("invalid_request", "Хүүхдийн мэдээллийг дахин шалгана уу.", 400, { "Cache-Control": "no-store" });
  return error("invalid_request", "Бүртгэлийн төлөв өөрчлөгдсөн байна. Дахин ачаална уу.", 409, { "Cache-Control": "no-store" });
}

function programCalendarError(caught: unknown): Response {
  if (caught instanceof OfferingError) {
    if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
    if (caught.code === "not_found") return error("invalid_request", "Сонгосон мэдээлэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
    if (caught.code === "conflict") return error("invalid_request", "Энэ мэдээлэл өөр газраас шинэчлэгдсэн байна. Хуудсыг шинэчлээд өөрчлөлтөө шалгана уу.", 409, { "Cache-Control": "no-store" });
    if (caught.code === "immutable") return error("invalid_request", "Ашиглагдаж буй мэдээллийг эндээс шууд өөрчилж болохгүй.", 409, { "Cache-Control": "no-store" });
    return error("invalid_request", "Оруулсан мэдээллээ шалгана уу.", 400, { "Cache-Control": "no-store" });
  }
  if (!(caught instanceof ProgramCalendarError)) {
    return error("internal_error", "Хөтөлбөр, хуваарийг одоогоор хадгалж чадсангүй.", 500, { "Cache-Control": "no-store" });
  }
  if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  if (caught.code === "not_found") return error("invalid_request", "Сонгосон мэдээлэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
  if (caught.code === "conflict") return error("invalid_request", "Энэ мэдээлэл өөр газраас шинэчлэгдсэн байна. Хуудсыг шинэчлээд өөрчлөлтөө шалгана уу.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "immutable") return error("invalid_request", "Хэвлэгдсэн эсвэл ашиглагдаж буй мэдээллийг шууд өөрчилж болохгүй. Шинэ ноорог үүсгэнэ үү.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "referenced") return error("invalid_request", "Энэ анги бүртгэл эсвэл хуваарьт ашиглагдсан тул устгаж болохгүй.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "insufficient_slots") return error("invalid_request", "Хөтөлбөрийн бүх хичээл сонгосон хугацаанд багтахгүй байна. Хугацааг сунгах, давтамжийг өөрчлөх эсвэл нэмэлт өдөр оруулна уу.", 422, { "Cache-Control": "no-store" });
  return error("invalid_request", "Оруулсан мэдээллээ шалгана уу.", 400, { "Cache-Control": "no-store" });
}

function courseAttendanceError(caught: unknown): Response {
  if (!(caught instanceof CourseAttendanceError)) {
    return error("internal_error", "Ирцийн мэдээллийг одоогоор хадгалж чадсангүй.", 500, { "Cache-Control": "no-store" });
  }
  if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  if (caught.code === "not_found") return error("invalid_request", "Сонгосон хичээл олдсонгүй.", 404, { "Cache-Control": "no-store" });
  if (caught.code === "not_enrolled") return error("invalid_request", "Энэ сурагч тухайн хичээлийн бүртгэлтэй жагсаалтад алга.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "future_occurrence") return error("invalid_request", "Ирцийг хичээл болох өдрөөс эхэлж тэмдэглэнэ.", 409, { "Cache-Control": "no-store" });
  return error("invalid_request", "Оруулсан мэдээллээ шалгана уу.", 400, { "Cache-Control": "no-store" });
}

function courseMakeupError(caught: unknown): Response {
  if (!(caught instanceof CourseMakeupError)) {
    return error("internal_error", "Нөхөх хичээлийн мэдээллийг одоогоор хадгалж чадсангүй.", 500, { "Cache-Control": "no-store" });
  }
  if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  if (caught.code === "not_found") return error("not_found", "Сонгосон нөхөх хичээл олдсонгүй.", 404, { "Cache-Control": "no-store" });
  if (caught.code === "not_eligible") return error("invalid_request", "Энэ таслалт нөхөх хичээлд одоогоор тохирохгүй байна.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "capacity") return error("invalid_request", "Сонгосон хичээлийн сул суудал дүүрсэн байна.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "conflict") return error("invalid_request", "Мэдээлэл өөрчлөгдсөн байна. Жагсаалтаа шинэчлээд дахин оролдоно уу.", 409, { "Cache-Control": "no-store" });
  return error("invalid_request", "Оруулсан мэдээллээ шалгана уу.", 400, { "Cache-Control": "no-store" });
}

function dayChangeError(caught: unknown): Response {
  if (!(caught instanceof DayChangeError)) {
    return error("internal_error", "Өдрийн хуваарийн өөрчлөлтийг одоогоор хадгалж чадсангүй.", 500, { "Cache-Control": "no-store" });
  }
  const classContext = caught.blockingClassLabel ? `${caught.blockingClassLabel}: ` : "";
  if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  if (caught.code === "not_found") return error("not_found", "Сонгосон өдрийн хичээл олдсонгүй.", 404, { "Cache-Control": "no-store" });
  if (caught.code === "attendance_protected") return error("invalid_request", `${classContext}ирц тэмдэглэсэн тул цуцлах боломжгүй.`, 409, { "Cache-Control": "no-store" });
  if (caught.code === "history_protected") return error("invalid_request", `${classContext}дууссан хичээлийн түүхийг өөрчлөх боломжгүй.`, 409, { "Cache-Control": "no-store" });
  if (caught.code === "conflict") return error("invalid_request", `${classContext}хуваарь бэлэн биш эсвэл сонгосон өдөр давхардсан байна. Хуваариа шалгана уу.`, 409, { "Cache-Control": "no-store" });
  return error("invalid_request", "Өдөр, анги, орлуулах огноогоо шалгана уу.", 400, { "Cache-Control": "no-store" });
}

function staffAdministrationError(caught: unknown): Response {
  if (!(caught instanceof StaffAdministrationError)) {
    return error("internal_error", "Ажилтны мэдээллийг одоогоор хадгалж чадсангүй.", 500, { "Cache-Control": "no-store" });
  }
  if (caught.code === "forbidden") return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
  if (caught.code === "staff_not_found") return error("not_found", "Сонгосон ажилтан олдсонгүй.", 404, { "Cache-Control": "no-store" });
  if (caught.code === "email_conflict") return error("invalid_request", "Энэ и-мэйл хаяг өөр ажилтанд бүртгэлтэй байна.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "email_limit") return error("invalid_request", "Нэг ажилтанд хамгийн ихдээ 3 и-мэйл хаяг нэмнэ.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "primary_email") return error("invalid_request", "Үндсэн и-мэйлийг хасахын өмнө өөр хаягийг үндсэн болгоно уу.", 409, { "Cache-Control": "no-store" });
  if (caught.code === "last_active_admin") return error("invalid_request", "Сүүлийн идэвхтэй админы эрхийг хасах боломжгүй.", 409, { "Cache-Control": "no-store" });
  return error("invalid_request", "Нэр, и-мэйл хаяг, эрхийг шалгана уу.", 400, { "Cache-Control": "no-store" });
}

export async function handleApiRequest(
  request: Request,
  env: WorkerEnv,
  context?: WorkerExecutionContext,
): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/api/health") {
    if (request.method !== "GET") return methodNotAllowed();

    try {
      const result = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      if (result?.ok !== 1) throw new Error("D1 health query did not return the expected value.");
      return json({ ok: true, environment: env.APP_ENV });
    } catch {
      return error("internal_error", "Үйлчилгээ одоогоор бэлэн биш байна.", 500);
    }
  }

  if (path === "/api/registration/catalog") {
    if (request.method !== "GET") return methodNotAllowed();

    try {
      return json(await getRegistrationCatalog(env.DB, env.APP_ENV), 200, { "Cache-Control": "no-store" });
    } catch {
      return error("internal_error", "Бүртгэлийн мэдээллийг одоогоор авч чадсангүй.", 500);
    }
  }

  if (path === "/api/public-site") {
    if (request.method !== "GET") return methodNotAllowed();
    try { return json(await getPublicSiteModel(env), 200, { "Cache-Control": "no-store" }); }
    catch { return error("internal_error", "Нийтийн мэдээллийг одоогоор авч чадсангүй.", 500); }
  }

  if (path === "/api/calendar/published") {
    if (request.method !== "GET") return methodNotAllowed();
    try {
      return json(await getPublishedCalendars(env.DB, env.APP_ENV), 200, { "Cache-Control": "no-store" });
    } catch {
      return error("internal_error", "Хуваарийг одоогоор авч чадсангүй.", 500);
    }
  }

  if (path === "/api/registration/config") {
    if (request.method !== "GET") return methodNotAllowed();
    return json({
      environment: env.APP_ENV,
      writeEnabled: registrationWritesAvailable(env),
      turnstileSiteKey: registrationWritesAvailable(env) ? env.TURNSTILE_SITE_KEY ?? null : null,
    }, 200, { "Cache-Control": "no-store" });
  }

  if (path === "/api/registration/bootstrap") {
    if (request.method !== "GET") return methodNotAllowed();
    try {
      return json({
        config: {
          environment: env.APP_ENV,
          writeEnabled: registrationWritesAvailable(env),
          turnstileSiteKey: registrationWritesAvailable(env) ? env.TURNSTILE_SITE_KEY ?? null : null,
        },
        catalog: await getRegistrationCatalog(env.DB, env.APP_ENV),
        courseRules: await getCourseRules(env),
      }, 200, { "Cache-Control": "no-store" });
    } catch {
      return error("internal_error", "Бүртгэлийн мэдээллийг одоогоор авч чадсангүй.", 500);
    }
  }

  if (path === "/api/registration/submit") {
    if (!registrationWritesAvailable(env)) return authNotFound();
    if (request.method !== "POST") return methodNotAllowed("POST");
    let payload: RegistrationSubmissionInput;
    try {
      payload = await request.json() as RegistrationSubmissionInput;
    } catch {
      return error("invalid_request", "Бүртгэлийн мэдээллээ шалгана уу.", 400);
    }

    try {
      await verifyTurnstile(env, payload.turnstileToken, request.headers.get("CF-Connecting-IP") ?? undefined);
      const draft = await createRegistrationDraft(env, payload);
      try {
        await startEmailVerification(env, draft.email, { registrationDraftId: draft.draftId });
        await markRegistrationEmailSent(env.DB, draft.draftId);
      } catch (caught) {
        await markRegistrationEmailFailed(env.DB, draft.draftId);
        return json({
          ok: true,
          emailSent: false,
          email: draft.email,
          hasPaymentHold: draft.hasPaymentHold,
          paymentDeadlineAt: draft.paymentDeadlineAt,
        }, 202, { "Cache-Control": "no-store", "Set-Cookie": draft.accessCookie });
      }
      return json({
        ok: true,
        emailSent: true,
        email: draft.email,
        hasPaymentHold: draft.hasPaymentHold,
        paymentDeadlineAt: draft.paymentDeadlineAt,
      }, 202, { "Cache-Control": "no-store", "Set-Cookie": draft.accessCookie });
    } catch (caught) {
      return registrationError(caught);
    }
  }

  if (path === "/api/registration/email/resend") {
    if (!registrationWritesAvailable(env)) return authNotFound();
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      const draft = await draftForAccessToken(env.DB, readCookie(request, REGISTRATION_DRAFT_COOKIE));
      await claimRegistrationEmailSend(env.DB, draft);
      try {
        await startEmailVerification(env, draft.email, { registrationDraftId: draft.id, invalidatePrevious: true });
      } catch (caught) {
        await markRegistrationEmailFailed(env.DB, draft.id);
        throw caught;
      }
      await markRegistrationEmailSent(env.DB, draft.id);
      return json({ ok: true, email: draft.email }, 202, { "Cache-Control": "no-store" });
    } catch (caught) {
      return registrationError(caught);
    }
  }

  if (path === "/api/registration/email/change") {
    if (!registrationWritesAvailable(env)) return authNotFound();
    if (request.method !== "POST") return methodNotAllowed("POST");
    let email = "";
    let turnstileToken = "";
    try {
      const payload = await request.json() as { email?: unknown; turnstileToken?: unknown };
      if (typeof payload.email !== "string" || typeof payload.turnstileToken !== "string") throw new Error("invalid");
      email = payload.email;
      turnstileToken = payload.turnstileToken;
    } catch {
      return error("invalid_request", "И-мэйл хаягаа зөв оруулна уу.", 400);
    }
    try {
      await verifyTurnstile(env, turnstileToken, request.headers.get("CF-Connecting-IP") ?? undefined);
      const draft = await draftForAccessToken(env.DB, readCookie(request, REGISTRATION_DRAFT_COOKIE));
      const updated = await changeDraftEmail(env.DB, draft, email);
      try {
        await startEmailVerification(env, updated.email, { registrationDraftId: updated.id });
      } catch (caught) {
        await markRegistrationEmailFailed(env.DB, updated.id);
        throw caught;
      }
      await markRegistrationEmailSent(env.DB, updated.id);
      return json({ ok: true, email: updated.email }, 202, { "Cache-Control": "no-store" });
    } catch (caught) {
      return registrationError(caught);
    }
  }

  if (path === "/api/registration/status") {
    if (!registrationWritesAvailable(env)) return authNotFound();
    if (request.method !== "GET") return methodNotAllowed();
    try {
      const status = await registrationStatusForAccess(env.DB, readCookie(request, REGISTRATION_DRAFT_COOKIE));
      return json(status, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      return registrationError(caught);
    }
  }

  if (path === "/api/registration/pending") {
    if (!registrationWritesAvailable(env)) return authNotFound();
    if (request.method !== "GET") return methodNotAllowed();
    try {
      const pending = await pendingRegistrationForAccess(env.DB, readCookie(request, REGISTRATION_DRAFT_COOKIE));
      return json(pending, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      return registrationError(caught);
    }
  }

  if (path === "/api/registration/status/waitlist") {
    if (!registrationWritesAvailable(env)) return authNotFound();
    if (request.method !== "POST") return methodNotAllowed("POST");
    let childId = "";
    try {
      const payload = await request.json() as { childId?: unknown };
      if (typeof payload.childId !== "string") throw new Error("invalid");
      childId = payload.childId;
    } catch {
      return error("invalid_request", "Хүлээлгийн жагсаалтын хүсэлтийг шалгана уу.", 400);
    }
    try {
      await joinOriginalClassWaitlist(env.DB, readCookie(request, REGISTRATION_DRAFT_COOKIE), childId);
      return json({ ok: true }, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      return registrationError(caught);
    }
  }

  if (path === "/api/registration/status/payment-claim") {
    if (!registrationWritesAvailable(env)) return authNotFound();
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403, { "Cache-Control": "no-store" });
    }
    try {
      const payload = await request.json() as { paymentRequestId?: unknown };
      if (typeof payload.paymentRequestId !== "string") throw new PaymentReconciliationError("invalid");
      const status = await registrationStatusForAccess(env.DB, readCookie(request, REGISTRATION_DRAFT_COOKIE));
      await claimParentPayment(env.DB, payload.paymentRequestId, status.id, readCookie(request, REGISTRATION_DRAFT_COOKIE));
      return json({ ok: true }, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      return paymentReconciliationError(caught);
    }
  }

  if (path === "/api/auth/email/start") {
    if (env.APP_ENV !== "staging" || !authEmailAvailable(env)) return authNotFound();
    if (request.method !== "POST") return methodNotAllowed("POST");

    const suppliedTestKey = request.headers.get("X-Naran-Test-Key") ?? "";
    if (!env.STAGING_AUTH_TEST_KEY || !suppliedTestKey || !await secureEqual(suppliedTestKey, env.STAGING_AUTH_TEST_KEY)) {
      return authNotFound();
    }

    let email = "";
    try {
      const payload = await request.json() as { email?: unknown };
      if (typeof payload.email !== "string") throw new Error("Invalid email payload");
      email = payload.email;
    } catch {
      return error("invalid_request", "И-мэйл хаягаа зөв оруулна уу.", 400);
    }

    try {
      await startEmailVerification(env, email);
      return json({ ok: true, message: "Хэрэв хүсэлт хүчинтэй бол баталгаажуулах и-мэйл илгээгдэнэ." }, 202, {
        "Cache-Control": "no-store",
      });
    } catch (caught) {
      if (caught instanceof EmailVerificationError && caught.code === "invalid_email") {
        return error("invalid_request", "И-мэйл хаягаа зөв оруулна уу.", 400);
      }
      if (caught instanceof EmailConfigurationError) {
        return error("configuration_error", "И-мэйл баталгаажуулалт одоогоор бэлэн биш байна.", 503);
      }
      if (caught instanceof EmailDeliveryError) {
        return error("internal_error", "Баталгаажуулах и-мэйлийг одоогоор илгээж чадсангүй.", 503);
      }
      return error("internal_error", "И-мэйл баталгаажуулалт одоогоор бэлэн биш байна.", 500);
    }
  }

  if (path === "/api/auth/email/verify") {
    if (!authEmailAvailable(env)) return authNotFound();
    if (request.method !== "POST") return methodNotAllowed("POST");

    let token = "";
    try {
      const payload = await request.json() as { token?: unknown };
      if (typeof payload.token !== "string") throw new Error("Invalid verification token");
      token = payload.token;
    } catch {
      return error(
        "verification_failed",
        "Баталгаажуулах холбоос хүчингүй эсвэл хугацаа нь дууссан байна.",
        400,
        { "Cache-Control": "no-store" },
      );
    }

    try {
      const result = await verifyEmailToken(env, token, readCookie(request, VERIFIED_EMAIL_COOKIE));
      const headers = new Headers({
        "Cache-Control": "no-store",
        Location: result.redirectUrl,
      });
      if (result.cookie) headers.append("Set-Cookie", result.cookie);
      return new Response(null, {
        status: 303,
        headers,
      });
    } catch {
      return error(
        "verification_failed",
        "Баталгаажуулах холбоос хүчингүй эсвэл хугацаа нь дууссан байна.",
        400,
        { "Cache-Control": "no-store" },
      );
    }
  }

  if (path === "/api/staff/auth/start") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    let email = "";
    try {
      requireSameOrigin(request, env);
      const payload = await request.json() as { email?: unknown };
      if (typeof payload.email === "string") email = payload.email;
    } catch (caught) {
      const securityResponse = staffSecurityError(caught);
      if (securityResponse) return securityResponse;
      return staffLoginAccepted();
    }

    try {
      const result = await startStaffLogin(env, email, {
        clientIp: request.headers.get("CF-Connecting-IP") ?? undefined,
        existingAttemptSecret: readStaffAttemptCookie(request),
      });
      if (result.delivery) {
        const work = result.delivery.catch(() => undefined);
        if (context) context.waitUntil(work);
        else await work;
      }
      return staffLoginAccepted(result.attemptCookie ?? undefined);
    } catch {
      return staffLoginAccepted();
    }
  }

  if (path === "/api/staff/auth/verify") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    let token = "";
    try {
      requireSameOrigin(request, env);
      const payload = await request.json() as { token?: unknown };
      if (typeof payload.token !== "string") throw new Error("invalid token payload");
      token = payload.token;
    } catch (caught) {
      const securityResponse = staffSecurityError(caught);
      if (securityResponse) return securityResponse;
      return error("verification_failed", "Холбоос ашиглагдсан эсвэл хугацаа нь дууссан байна.", 400, {
        "Cache-Control": "no-store",
      });
    }
    try {
      const result = await verifyStaffLogin(
        env,
        token,
        readStaffAttemptCookie(request),
        readStaffCookie(request),
      );
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (result.cookie) headers.append("Set-Cookie", result.cookie);
      if (result.claimed) headers.append("Set-Cookie", clearStaffAttemptCookie(true));
      return json({
        ok: true,
        approved: result.approved,
        claimed: result.claimed,
        alreadySignedIn: result.alreadySignedIn,
      }, 200, headers);
    } catch {
      return error("verification_failed", "Холбоос ашиглагдсан эсвэл хугацаа нь дууссан байна.", 400, {
        "Cache-Control": "no-store",
      });
    }
  }

  if (path === "/api/staff/auth/attempt/claim") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const result = await claimStaffLoginAttempt(env, readStaffAttemptCookie(request));
    const headers = new Headers({ "Cache-Control": "no-store" });
    if (result.state === "authenticated") {
      headers.append("Set-Cookie", result.cookie);
      headers.append("Set-Cookie", clearStaffAttemptCookie(true));
      return json({ state: "authenticated" }, 200, headers);
    }
    if (["expired", "claimed"].includes(result.state)) {
      headers.append("Set-Cookie", clearStaffAttemptCookie(true));
    }
    return json({ state: result.state }, 200, headers);
  }

  if (path === "/api/staff/session") {
    if (request.method !== "GET") return methodNotAllowed();
    const principal = await staffPrincipalForRequest(request, env);
    if (!principal) return json({ authenticated: false }, 200, { "Cache-Control": "no-store" });
    return json({
      authenticated: true,
      displayName: principal.displayName,
      roles: principal.roles,
      capabilities: principal.capabilities,
      expiresAt: principal.sessionExpiresAt,
      absoluteExpiresAt: principal.sessionAbsoluteExpiresAt,
    }, 200, { "Cache-Control": "no-store" });
  }

  if (path === "/api/staff/dashboard-preferences") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const principal = await staffPrincipalForRequest(request, env);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    try { return json(await getTeacherDashboardPreferences(env), 200, { "Cache-Control": "no-store" }); }
    catch { return error("internal_error", "Тохиргоог авч чадсангүй.", 500, { "Cache-Control": "no-store" }); }
  }

  if (path === "/api/staff/team") {
    const rawSessionToken = readStaffCookie(request);
    const principal = await resolveStaffPrincipal(env, rawSessionToken);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    if (!hasStaffCapability(principal, "admin.staff.manage")) {
      return error("forbidden", "Ажилтны мэдээллийг харах эрх алга.", 403, { "Cache-Control": "no-store" });
    }
    if (request.method === "GET") {
      return json({ accounts: await listStaffAccounts(env, principal) }, 200, { "Cache-Control": "no-store" });
    }
    if (!new Set(["POST", "PUT"]).has(request.method)) return methodNotAllowed("GET, POST, PUT");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    try {
      const payload = await request.json() as Record<string, unknown>;
      if (request.method === "POST") {
        const created = await createStaffAccount(env, principal, {
          displayName: payload.displayName,
          email: payload.email,
          role: payload.role,
        });
        return json({ ok: true, ...created }, 201, { "Cache-Control": "no-store" });
      }
      const staffAccountId = String(payload.staffAccountId ?? "");
      if (payload.action === "update") {
        await updateStaffAccount(env, principal, staffAccountId, {
          displayName: payload.displayName,
          role: payload.role,
        });
      } else if (payload.action === "email-add") {
        await addStaffAccountEmail(env, principal, staffAccountId, payload.email);
      } else if (payload.action === "email-primary") {
        await setPrimaryStaffAccountEmail(env, principal, staffAccountId, String(payload.emailId ?? ""));
      } else if (payload.action === "email-remove") {
        await removeStaffAccountEmail(env, principal, staffAccountId, String(payload.emailId ?? ""));
      } else if (payload.action === "status") {
        const status = payload.status === "active" ? "active" : payload.status === "disabled" ? "disabled" : null;
        if (!status) throw new StaffAdministrationError("staff_not_found");
        await setStaffAccountStatus(env, principal, staffAccountId, status);
      } else if (payload.action === "revoke-sessions") {
        await revokeAllStaffSessions(env, principal, staffAccountId);
      } else {
        return error("not_found", "Хүссэн үйлдэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
      }
      const currentPrincipal = await resolveStaffPrincipal(env, rawSessionToken, new Date(), "passive");
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (!currentPrincipal) headers.append("Set-Cookie", clearStaffSessionCookie(true));
      return json({ ok: true, reauthenticationRequired: !currentPrincipal }, 200, headers);
    } catch (caught) {
      return staffAdministrationError(caught);
    }
  }

  if (path === "/api/staff/settings/auth") {
    if (request.method === "GET") {
      const principal = await staffPrincipalForRequest(request, env);
      if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
      if (!hasStaffCapability(principal, "admin.settings.manage")) {
        return error("forbidden", "Энэ тохиргоог харах эрх алга.", 403, { "Cache-Control": "no-store" });
      }
      return json({ policies: await listStaffSessionPolicies(env) }, 200, { "Cache-Control": "no-store" });
    }
    if (request.method !== "PUT") return methodNotAllowed("GET, PUT");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const rawSessionToken = readStaffCookie(request);
    const principal = await resolveStaffPrincipal(env, rawSessionToken);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    if (!hasStaffCapability(principal, "admin.settings.manage")) {
      return error("forbidden", "Энэ тохиргоог өөрчлөх эрх алга.", 403, { "Cache-Control": "no-store" });
    }
    try {
      const payload = await request.json() as { policies?: unknown };
      if (!Array.isArray(payload.policies)) throw new StaffSessionPolicyError("invalid_policy");
      const policies = await updateStaffSessionPolicies(
        env,
        principal,
        payload.policies as StaffSessionPolicyInput[],
      );
      const currentPrincipal = await resolveStaffPrincipal(env, rawSessionToken, new Date(), "passive");
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (!currentPrincipal) headers.append("Set-Cookie", clearStaffSessionCookie(true));
      return json({ policies, reauthenticationRequired: !currentPrincipal }, 200, headers);
    } catch (caught) {
      if (caught instanceof StaffSessionPolicyError) {
        const status = caught.code === "forbidden" ? 403 : 400;
        return error(
          caught.code === "forbidden" ? "forbidden" : "invalid_request",
          caught.code === "forbidden"
            ? "Энэ тохиргоог өөрчлөх эрх алга."
            : "Хугацааны утгыг шалгана уу.",
          status,
          { "Cache-Control": "no-store" },
        );
      }
      return error("invalid_request", "Хугацааны утгыг шалгана уу.", 400, { "Cache-Control": "no-store" });
    }
  }

  if (path === "/api/staff/logout") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    await revokeStaffSession(env, readStaffCookie(request));
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": clearStaffSessionCookie(true),
      },
    });
  }

  if (path === "/api/staff/proof/calendar") {
    if (request.method !== "GET") return methodNotAllowed();
    const denied = await requireStaffCapability(request, env, "calendar.view");
    return denied ?? json({ ok: true, capability: "calendar.view" }, 200, { "Cache-Control": "no-store" });
  }

  if (path === "/api/staff/proof/calendar-mutation") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const denied = await requireStaffCapability(request, env, "calendar.manage");
    return denied ?? json({ ok: true, capability: "calendar.manage", changed: false }, 200, {
      "Cache-Control": "no-store",
    });
  }

  if (path === "/api/staff/proof/attendance") {
    if (request.method !== "GET") return methodNotAllowed();
    const denied = await requireStaffCapability(request, env, "attendance.view");
    return denied ?? json({ ok: true, capability: "attendance.view" }, 200, { "Cache-Control": "no-store" });
  }

  if (path === "/api/staff/proof/attendance-mutation") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const denied = await requireStaffCapability(request, env, "attendance.manage");
    return denied ?? json({ ok: true, capability: "attendance.manage", changed: false }, 200, {
      "Cache-Control": "no-store",
    });
  }

  if (path === "/api/staff/payments") {
    if (request.method === "GET") {
      const denied = await requireStaffCapability(request, env, "payment.view");
      if (denied) return denied;
      const principal = await staffPrincipalForRequest(request, env);
      if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
      try {
        const queue = await getInitialPaymentQueue(env, principal);
        const promotion = await getPromotionReviewQueue(env, principal);
        return json({ ...queue, promotionItems: promotion.items }, 200, { "Cache-Control": "no-store" });
      } catch (caught) {
        return paymentReconciliationError(caught);
      }
    }
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403, { "Cache-Control": "no-store" });
    }
    const principal = await staffPrincipalForRequest(request, env);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    if (!hasStaffCapability(principal, "payment.manage")) {
      return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
    }
    try {
      const payload = await request.json() as Record<string, unknown>;
      switch (payload.action) {
        case "payment.record":
          return json({ ok: true, ...await recordManualPayment(env, principal, {
            paymentRequestId: String(payload.paymentRequestId ?? ""),
            allocations: Array.isArray(payload.allocations) ? payload.allocations.map((item) => ({
              installmentId: String((item as Record<string, unknown>).installmentId ?? ""),
              amountMnt: Number((item as Record<string, unknown>).amountMnt),
            })) : [],
            source: payload.source === "staff_manual_cash" ? "staff_manual_cash" : "staff_manual_bank",
            receivedAt: typeof payload.receivedAt === "string" ? payload.receivedAt : undefined,
            receivedAmountMnt: payload.receivedAmountMnt == null ? undefined : Number(payload.receivedAmountMnt),
            idempotencyKey: String(payload.idempotencyKey ?? ""),
            approveSeatConfirmation: Boolean(payload.approveSeatConfirmation),
            remainingPaymentDueAt: typeof payload.remainingPaymentDueAt === "string" ? payload.remainingPaymentDueAt : undefined,
          }) }, 200, { "Cache-Control": "no-store" });
        case "payment.undo-tentative":
          return json({ ok: true, ...await undoTentativePaymentConfirmation(env, principal, String(payload.receivedPaymentId ?? "")) }, 200, { "Cache-Control": "no-store" });
        case "payment-credit.refund":
          return json({ ok: true, ...await markPaymentCreditRefunded(env, principal, String(payload.creditId ?? "")) }, 200, { "Cache-Control": "no-store" });
        case "payment.checked-not-found":
          await recordCheckedNotFound(env, principal, String(payload.paymentRequestId ?? ""));
          return json({ ok: true }, 200, { "Cache-Control": "no-store" });
        case "payment.release-seat":
          return json({ ok: true, ...await releaseUnpaidSeat(env, principal, String(payload.paymentRequestId ?? "")) }, 200, { "Cache-Control": "no-store" });
        case "promotion.use-existing-student":
          return json({ ok: true, ...await resolvePromotionIdentity(env, principal,
            String(payload.draftChildId ?? ""), { kind: "existing", studentId: String(payload.studentId ?? "") }) }, 200, { "Cache-Control": "no-store" });
        case "promotion.create-new-student":
          return json({ ok: true, ...await resolvePromotionIdentity(env, principal,
            String(payload.draftChildId ?? ""), { kind: "new" }) }, 200, { "Cache-Control": "no-store" });
        default:
          return error("not_found", "Хүссэн үйлдэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
      }
    } catch (caught) {
      return caught instanceof CanonicalPromotionError ? canonicalPromotionError(caught) : paymentReconciliationError(caught);
    }
  }

  if (path === "/api/staff/attendance") {
    if (request.method === "GET") {
      const denied = await requireStaffCapability(request, env, "attendance.view");
      if (denied) return denied;
      const url = new URL(request.url);
      try {
        const principal = await staffPrincipalForRequest(request, env);
        if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
        return json(await getCourseAttendanceDay(
          env,
          principal,
          url.searchParams.get("date") || undefined,
          url.searchParams.get("occurrence") || "",
        ), 200, { "Cache-Control": "no-store" });
      } catch (caught) {
        return courseAttendanceError(caught);
      }
    }
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const principal = await staffPrincipalForRequest(request, env);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    if (!hasStaffCapability(principal, "attendance.manage")) {
      return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
    }
    let payload: Record<string, unknown>;
    try {
      payload = await request.json() as Record<string, unknown>;
      if (!payload || typeof payload.action !== "string") throw new Error("invalid payload");
    } catch {
      return error("invalid_request", "Хүсэлтийн мэдээллийг шалгана уу.", 400, { "Cache-Control": "no-store" });
    }
    try {
      let result: Record<string, unknown>;
      switch (payload.action) {
        case "attendance.mark":
          result = await recordCourseAttendance(env, principal, {
            slotId: String(payload.slotId ?? ""), enrollmentId: String(payload.enrollmentId ?? ""), status: payload.status,
          });
          break;
        case "attendance.clear":
          result = await clearCourseAttendance(env, principal, {
            slotId: String(payload.slotId ?? ""), enrollmentId: String(payload.enrollmentId ?? ""),
          });
          break;
        case "attendance.bulk-present":
          result = await markUnmarkedRosterPresent(env, principal, { slotId: String(payload.slotId ?? "") });
          break;
        case "absence-notice.save":
          result = await saveCourseAbsenceNotice(env, principal, {
            slotId: String(payload.slotId ?? ""), enrollmentId: String(payload.enrollmentId ?? ""), note: payload.note,
          });
          break;
        case "absence-notice.cancel":
          result = await cancelCourseAbsenceNotice(env, principal, {
            slotId: String(payload.slotId ?? ""), enrollmentId: String(payload.enrollmentId ?? ""),
          });
          break;
        default:
          return error("not_found", "Хүссэн үйлдэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
      }
      return json({ ok: true, ...result }, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      return courseAttendanceError(caught);
    }
  }

  if (path === "/api/staff/makeups") {
    if (request.method === "GET") {
      const denied = await requireStaffCapability(request, env, "makeup.view");
      if (denied) return denied;
      const principal = await staffPrincipalForRequest(request, env);
      if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
      const url = new URL(request.url);
      try {
        return json(await getCourseMakeupOverview(env, principal, {
          enrollmentId: url.searchParams.get("enrollment") || "",
          classSessionId: url.searchParams.get("class") || "",
          curriculumLessonId: url.searchParams.get("lesson") || "",
        }), 200, { "Cache-Control": "no-store" });
      } catch (caught) {
        return courseMakeupError(caught);
      }
    }
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const principal = await staffPrincipalForRequest(request, env);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    if (!hasStaffCapability(principal, "makeup.manage")) {
      return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
    }
    try {
      const payload = await request.json() as Record<string, unknown>;
      let result: Record<string, unknown> = {};
      switch (payload.action) {
        case "makeup.no-makeup":
          result = await resolveCourseMakeupAsNotNeeded(env, principal, payload);
          break;
        case "makeup.no-makeup-reopen":
          await reopenCourseMakeupResolution(env, principal, payload);
          break;
        case "makeup.assign-normal":
          result = await assignCourseMakeupToNormalClass(env, principal, payload);
          break;
        case "makeup.assign-special":
          result = await assignCourseMakeupToSpecialOccurrence(env, principal, payload);
          break;
        case "makeup.special-create":
          result = await createSpecialCourseMakeupOccurrence(env, principal, payload);
          break;
        case "makeup.assignment-cancel":
          await cancelCourseMakeupAssignment(env, principal, payload);
          break;
        case "makeup.special-cancel":
          await cancelSpecialCourseMakeupOccurrence(env, principal, payload);
          break;
        default:
          return error("not_found", "Хүссэн үйлдэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
      }
      return json({ ok: true, ...result }, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      return courseMakeupError(caught);
    }
  }

  if (path === "/api/staff/day-changes") {
    if (request.method === "GET") {
      const denied = await requireStaffCapability(request, env, "calendar.manage");
      if (denied) return denied;
      const principal = await staffPrincipalForRequest(request, env);
      if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
      try {
        return json(await getDailyChangesOverview(
          env, principal, new URL(request.url).searchParams.get("date") || undefined,
        ), 200, { "Cache-Control": "no-store" });
      } catch (caught) {
        return dayChangeError(caught);
      }
    }
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const principal = await staffPrincipalForRequest(request, env);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    if (!hasStaffCapability(principal, "calendar.manage")) {
      return error("forbidden", "Энэ үйлдлийг хийх эрх алга.", 403, { "Cache-Control": "no-store" });
    }
    try {
      const payload = await request.json() as Record<string, unknown>;
      if (payload.action === "day-change.preview") {
        return json({ ok: true, ...await previewDailyChange(env, principal, payload) }, 200, { "Cache-Control": "no-store" });
      }
      if (payload.action === "day-change.apply") {
        return json({ ok: true, ...await applyDailyChange(env, principal, payload) }, 200, { "Cache-Control": "no-store" });
      }
      return error("not_found", "Хүссэн үйлдэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
    } catch (caught) {
      return dayChangeError(caught);
    }
  }

  if (path === "/api/staff/registration-windows") {
    if (request.method === "GET") {
      const denied = await requireStaffCapability(request, env, "registration.manage");
      if (denied) return denied;
      try {
        return json(await getRegistrationWindowOverview(env), 200, { "Cache-Control": "no-store" });
      } catch (caught) {
        return registrationWindowError(caught);
      }
    }
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const principal = await staffPrincipalForRequest(request, env);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    try {
      const payload = await request.json() as Record<string, unknown>;
      if (!payload || typeof payload.action !== "string") throw new RegistrationWindowError("invalid");
      if (payload.action === "registration-detail.get") {
        return json(await registrationCorrectionDetail(env, principal, String(payload.childId ?? "")), 200, { "Cache-Control": "no-store" });
      } else if (payload.action === "registration-detail.save") {
        return json({ ok: true, detail: await saveRegistrationCorrection(env, principal, String(payload.childId ?? ""), payload) }, 200, { "Cache-Control": "no-store" });
      } else if (payload.action === "registration-window.save") {
        await saveRegistrationWindow(env, principal, {
          id: typeof payload.id === "string" ? payload.id : undefined,
          expectedUpdatedAt: typeof payload.expectedUpdatedAt === "string" ? payload.expectedUpdatedAt : undefined,
          name: payload.name,
          startsOn: payload.startsOn,
          endsOn: payload.endsOn,
          offeringIds: payload.offeringIds,
        });
      } else if (payload.action === "registration-window.delete") {
        await deleteRegistrationWindow(env, principal, {
          id: String(payload.id ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
        });
      } else {
        return error("not_found", "Хүссэн үйлдэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
      }
      return json({ ok: true }, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      return registrationWindowError(caught);
    }
  }

  if (path === "/api/staff/program-calendar") {
    if (request.method === "GET") {
      const denied = await requireStaffCapability(request, env, "calendar.view");
      if (denied) return denied;
      try {
        return json(await getProgramCalendarOverview(env), 200, { "Cache-Control": "no-store" });
      } catch (caught) {
        return programCalendarError(caught);
      }
    }
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    try {
      requireSameOrigin(request, env);
    } catch (caught) {
      return staffSecurityError(caught) ?? error("forbidden", "Хүсэлтийг зөвшөөрсөнгүй.", 403);
    }
    const principal = await staffPrincipalForRequest(request, env);
    if (!principal) return error("unauthorized", "Нэвтрэх шаардлагатай.", 401, { "Cache-Control": "no-store" });
    let payload: Record<string, unknown>;
    try {
      payload = await request.json() as Record<string, unknown>;
      if (!payload || typeof payload.action !== "string") throw new Error("invalid payload");
    } catch {
      return error("invalid_request", "Хүсэлтийн мэдээллийг шалгана уу.", 400, { "Cache-Control": "no-store" });
    }
    try {
      switch (payload.action) {
        case "offering.save":
          await saveActivityOffering(env, principal, {
            id: typeof payload.id === "string" ? payload.id : undefined,
            expectedUpdatedAt: typeof payload.expectedUpdatedAt === "string" ? payload.expectedUpdatedAt : undefined,
            eventExpectedUpdatedAt: typeof payload.eventExpectedUpdatedAt === "string" ? payload.eventExpectedUpdatedAt : undefined,
            kind: String(payload.kind ?? ""), title: typeof payload.title === "string" ? payload.title : undefined,
            academicYearId: typeof payload.academicYearId === "string" ? payload.academicYearId : null,
            stageCode: typeof payload.stageCode === "string" ? payload.stageCode : null,
            levelLabel: typeof payload.levelLabel === "string" ? payload.levelLabel : null,
            startsOn: typeof payload.startsOn === "string" ? payload.startsOn : null,
            endsOn: typeof payload.endsOn === "string" ? payload.endsOn : null,
            programFamilyId: typeof payload.programFamilyId === "string" ? payload.programFamilyId : null,
            annualStageCode: typeof payload.annualStageCode === "string" ? payload.annualStageCode : null,
            useAcademicYearBreaks: typeof payload.useAcademicYearBreaks === "boolean" ? payload.useAcademicYearBreaks : undefined,
            chargeMode: typeof payload.chargeMode === "string" ? payload.chargeMode : undefined,
            facebookGroupUrl: typeof payload.facebookGroupUrl === "string" ? payload.facebookGroupUrl : null,
            note: typeof payload.note === "string" ? payload.note : null,
            eventDate: typeof payload.eventDate === "string" ? payload.eventDate : null,
            eventStartTime: typeof payload.eventStartTime === "string" ? payload.eventStartTime : null,
            eventEndTime: typeof payload.eventEndTime === "string" ? payload.eventEndTime : null,
            eventCapacity: Number(payload.eventCapacity),
            eventRegistrationOpen: typeof payload.eventRegistrationOpen === "boolean" ? payload.eventRegistrationOpen : false,
            defaultClassDurationMinutes: Number(payload.defaultClassDurationMinutes),
            initialClasses: Array.isArray(payload.initialClasses) ? payload.initialClasses : undefined,
          });
          break;
        case "offering-facebook.save":
          await saveOfferingFacebookGroup(env, principal, {
            offeringId: String(payload.offeringId ?? ""),
            expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
            facebookGroupUrl: typeof payload.facebookGroupUrl === "string" ? payload.facebookGroupUrl : null,
          });
          break;
        case "offering-break.save":
          await saveOfferingBreak(env, principal, {
            id: typeof payload.id === "string" ? payload.id : undefined,
            expectedUpdatedAt: typeof payload.expectedUpdatedAt === "string" ? payload.expectedUpdatedAt : undefined,
            offeringId: String(payload.offeringId ?? ""), label: String(payload.label ?? ""),
            startsOn: String(payload.startsOn ?? ""), endsOn: String(payload.endsOn ?? ""),
            note: typeof payload.note === "string" ? payload.note : null,
          });
          break;
        case "offering-break.remove":
          await removeOfferingBreak(env, principal, {
            breakId: String(payload.breakId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
          });
          break;
        case "offering-event.delete":
          await deleteUnusedEventOffering(env, principal, {
            offeringId: String(payload.offeringId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
          });
          break;
        case "program.create-summer":
          await createSummerProgramFamilyDraft(env, principal, { displayName: String(payload.displayName ?? "") });
          break;
        case "program.edit":
          await startProgramFamilyDraft(env, principal, { programFamilyId: String(payload.programFamilyId ?? "") });
          break;
        case "program.public-information.save":
          await saveProgramFamilyPublicInformation(env, principal, {
            programFamilyId: String(payload.programFamilyId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
            recommendedGradeMin: payload.recommendedGradeMin, recommendedGradeMax: payload.recommendedGradeMax,
            publicShortDescription: payload.publicShortDescription, publicLongDescription: payload.publicLongDescription,
          });
          break;
        case "program.rename":
          await renameProgramDraft(env, principal, {
            programId: String(payload.programId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
            displayName: String(payload.displayName ?? ""),
          });
          break;
        case "program.lesson.rename":
          await renameProgramDraftLesson(env, principal, {
            programId: String(payload.programId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
            lessonId: String(payload.lessonId ?? ""), title: String(payload.title ?? ""),
          });
          break;
        case "program.lesson.insert":
          await insertProgramDraftLesson(env, principal, {
            programId: String(payload.programId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
            beforeLessonId: typeof payload.beforeLessonId === "string" ? payload.beforeLessonId : undefined,
            title: String(payload.title ?? ""),
          });
          break;
        case "program.lesson.move":
          await moveProgramDraftLesson(env, principal, {
            programId: String(payload.programId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
            lessonId: String(payload.lessonId ?? ""), direction: String(payload.direction ?? ""),
          });
          break;
        case "program.lesson.delete":
          await deleteProgramDraftLesson(env, principal, {
            programId: String(payload.programId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
            lessonId: String(payload.lessonId ?? ""),
          });
          break;
        case "program.publish":
          await publishProgramFamilyDraft(env, principal, { programId: String(payload.programId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? "") });
          break;
        case "program.discard":
          await discardProgramFamilyDraft(env, principal, {
            programFamilyId: String(payload.programFamilyId ?? ""),
            expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
          });
          break;
        case "program.delete-summer":
          await deleteSummerProgramFamilyDraft(env, principal, { programFamilyId: String(payload.programFamilyId ?? "") });
          break;
        case "class.save":
          await saveClassSession(env, principal, {
            id: typeof payload.id === "string" ? payload.id : undefined,
            expectedUpdatedAt: typeof payload.expectedUpdatedAt === "string" ? payload.expectedUpdatedAt : undefined,
            academicYearId: String(payload.academicYearId ?? ""), stageCode: String(payload.stageCode ?? ""), weekday: String(payload.weekday ?? ""), startTime: String(payload.startTime ?? ""), endTime: String(payload.endTime ?? ""), capacity: Number(payload.capacity), registrationOpen: typeof payload.registrationOpen === "boolean" ? payload.registrationOpen : undefined,
            offeringId: typeof payload.offeringId === "string" ? payload.offeringId : undefined,
            recurrenceKind: typeof payload.recurrenceKind === "string" ? payload.recurrenceKind : undefined,
            firstDate: typeof payload.firstDate === "string" ? payload.firstDate : undefined,
            lastDate: typeof payload.lastDate === "string" ? payload.lastDate : null,
            weeklyWeekday: typeof payload.weeklyWeekday === "string" ? payload.weeklyWeekday : null,
          });
          break;
        case "class.delete":
          await deleteClassSession(env, principal, { classSessionId: String(payload.classSessionId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? "") });
          break;
        case "break.save":
          await saveAcademicYearBreak(env, principal, {
            id: typeof payload.id === "string" ? payload.id : undefined,
            expectedUpdatedAt: typeof payload.expectedUpdatedAt === "string" ? payload.expectedUpdatedAt : undefined,
            academicYearId: String(payload.academicYearId ?? ""), label: String(payload.label ?? ""), startsOn: String(payload.startsOn ?? ""), endsOn: String(payload.endsOn ?? ""),
            excludeFromGeneration: typeof payload.excludeFromGeneration === "boolean" ? payload.excludeFromGeneration : undefined,
            warnOnOverlap: typeof payload.warnOnOverlap === "boolean" ? payload.warnOnOverlap : undefined,
          });
          break;
        case "break.remove":
          await removeAcademicYearBreak(env, principal, { breakId: String(payload.breakId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? "") });
          break;
        case "calendar.generate":
          if ("programId" in payload || "firstCandidateDate" in payload) throw new ProgramCalendarError("invalid");
          await generateCalendarDraft(env, principal, { classSessionId: String(payload.classSessionId ?? "") });
          break;
        case "calendar.change-draft":
          await createCalendarChangeDraft(env, principal, { classSessionId: String(payload.classSessionId ?? "") });
          break;
        case "calendar.change":
          await changeCalendarDraft(env, principal, {
            revisionId: String(payload.revisionId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""), kind: String(payload.kind ?? "") as "exclude" | "restore" | "extra", localDate: String(payload.localDate ?? ""), startTime: typeof payload.startTime === "string" ? payload.startTime : undefined, endTime: typeof payload.endTime === "string" ? payload.endTime : undefined, reasonLabel: typeof payload.reasonLabel === "string" ? payload.reasonLabel : null,
          });
          break;
        case "calendar.cancel":
          await cancelFutureCalendarSlot(env, principal, {
            revisionId: String(payload.revisionId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""), slotId: String(payload.slotId ?? ""),
          });
          break;
        case "calendar.publish":
          await publishCalendarDraft(env, principal, { revisionId: String(payload.revisionId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? "") });
          break;
        case "calendar.discard":
          await discardCalendarDraft(env, principal, { revisionId: String(payload.revisionId ?? ""), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? "") });
          break;
        case "annual-course-start-default.save":
          await updateAnnualCourseStartDefault(env, principal, {
            month: Number(payload.month), day: Number(payload.day), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
          });
          break;
        case "public-qr-redirect-settings.save":
          await updatePublicQrRedirectSettings(env, principal, {
            nDestinationUrl: payload.nDestinationUrl,
            tDestinationUrl: payload.tDestinationUrl,
            expectedUpdatedAt: payload.expectedUpdatedAt,
          });
          break;
        case "teacher-dashboard-preferences.save":
          await updateTeacherDashboardPreferences(env, principal, payload);
          break;
        case "offering-course-pricing.save":
          await saveCoursePricing(env, principal, {
            offeringId: String(payload.offeringId ?? ""),
            oneTimeAmountMnt: Number(payload.oneTimeAmountMnt),
            twoInstallmentEnabled: Boolean(payload.twoInstallmentEnabled),
            firstInstallmentAmountMnt: payload.firstInstallmentAmountMnt == null ? null : Number(payload.firstInstallmentAmountMnt),
            secondInstallmentAmountMnt: payload.secondInstallmentAmountMnt == null ? null : Number(payload.secondInstallmentAmountMnt),
            secondInstallmentDueOn: typeof payload.secondInstallmentDueOn === "string" ? payload.secondInstallmentDueOn : null,
            expectedUpdatedAt: typeof payload.expectedUpdatedAt === "string" ? payload.expectedUpdatedAt : null,
          });
          break;
        case "payment-collection-settings.save":
          await updatePaymentCollectionSettings(env, principal, {
            bankName: typeof payload.bankName === "string" ? payload.bankName : null,
            accountHolderName: typeof payload.accountHolderName === "string" ? payload.accountHolderName : null,
            accountNumber: typeof payload.accountNumber === "string" ? payload.accountNumber : null,
            iban: typeof payload.iban === "string" ? payload.iban : null,
            transferInstruction: typeof payload.transferInstruction === "string" ? payload.transferInstruction : null,
            expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
          });
          break;
        case "payment-confirmation-grace.save":
          await updatePaymentConfirmationGraceSetting(env, principal, {
            graceMinutes: Number(payload.graceMinutes), expectedUpdatedAt: String(payload.expectedUpdatedAt ?? ""),
          });
          break;
        case "public-center-information.save":
          await updatePublicCenterInformation(env, principal, payload);
          break;
        case "course-rule.save":
          await saveCourseRule(env, principal, { code: payload.code, bodyText: payload.bodyText, expectedUpdatedAt: payload.expectedUpdatedAt });
          break;
        default:
          return error("not_found", "Хүссэн үйлдэл олдсонгүй.", 404, { "Cache-Control": "no-store" });
      }
      return json({ ok: true }, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      if (caught instanceof AnnualCourseStartDefaultError) {
        const status = caught.code === "forbidden" ? 403 : caught.code === "conflict" ? 409 : 400;
        return error(caught.code === "forbidden" ? "forbidden" : "invalid_request",
          caught.code === "forbidden" ? "Энэ тохиргоог өөрчлөх эрх алга."
            : caught.code === "conflict" ? "Энэ тохиргоо өөр газраас шинэчлэгдсэн байна. Хуудсыг шинэчлээд шалгана уу."
              : "Эхлэх өдрийн утгыг шалгана уу.", status, { "Cache-Control": "no-store" });
      }
      if (caught instanceof PublicQrRedirectSettingsError) {
        const status = caught.code === "forbidden" ? 403 : caught.code === "conflict" ? 409 : 400;
        return error(caught.code === "forbidden" ? "forbidden" : "invalid_request",
          caught.code === "forbidden" ? "Энэ тохиргоог өөрчлөх эрх алга."
            : caught.code === "conflict" ? "Энэ тохиргоо өөр газраас шинэчлэгдсэн байна. Хуудсыг шинэчлээд шалгана уу."
              : "QR холбоосыг https:// хаягаар оруулна уу.", status, { "Cache-Control": "no-store" });
      }
      if (caught instanceof TeacherDashboardPreferencesError) {
        const status = caught.code === "forbidden" ? 403 : caught.code === "conflict" ? 409 : 400;
        return error(caught.code === "forbidden" ? "forbidden" : "invalid_request",
          caught.code === "forbidden" ? "Энэ тохиргоог өөрчлөх эрх алга." : caught.code === "conflict" ? "Тохиргоо өөрчлөгдсөн байна. Хуудсыг шинэчлээд шалгана уу." : "Тохиргооны утгыг шалгана уу.", status, { "Cache-Control": "no-store" });
      }
      if (caught instanceof CoursePricingError) {
        const status = caught.code === "forbidden" ? 403 : caught.code === "conflict" ? 409 : 400;
        const message = caught.code === "forbidden" ? "Энэ төлбөрийн мэдээллийг өөрчлөх эрх алга."
          : caught.code === "conflict" ? "Төлбөрийн мэдээлэл өөрчлөгдсөн байна. Хуудсыг шинэчлээд шалгана уу."
            : caught.code === "payment_settings_incomplete" ? "Бүртгэл нээхийн өмнө банкны шилжүүлгийн мэдээллийг бүрэн тохируулна уу."
              : caught.code === "not_ready" ? "Бүртгэл нээхийн өмнө төлбөрийн нөхцөлийг бүрэн тохируулна уу."
                : "Төлбөрийн нөхцөлийн мэдээллийг шалгана уу.";
        return error(caught.code === "forbidden" ? "forbidden" : "invalid_request", message, status, { "Cache-Control": "no-store" });
      }
      if (caught instanceof PublicContentError) {
        const status = caught.code === "forbidden" ? 403 : caught.code === "conflict" ? 409 : 400;
        return error(caught.code === "forbidden" ? "forbidden" : "invalid_request",
          caught.code === "forbidden" ? "Энэ мэдээллийг өөрчлөх эрх алга." : caught.code === "conflict" ? "Мэдээлэл өөрчлөгдсөн байна. Хуудсыг шинэчлээд шалгана уу." : "Оруулсан мэдээллийг шалгана уу.", status, { "Cache-Control": "no-store" });
      }
      return programCalendarError(caught);
    }
  }

  if (path === "/api/staff/proof/admin") {
    if (request.method !== "GET") return methodNotAllowed();
    const denied = await requireStaffCapability(request, env, "admin.staff.manage");
    return denied ?? json({ ok: true, capability: "admin.staff.manage" }, 200, { "Cache-Control": "no-store" });
  }

  return authNotFound();
}
