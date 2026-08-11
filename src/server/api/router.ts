import type { WorkerEnv } from "../env";
import { secureEqual } from "../auth/crypto";
import { EmailVerificationError, startEmailVerification, verifyEmailToken } from "../auth/email-verification";
import { VERIFIED_EMAIL_COOKIE } from "../auth/email-verification";
import { EmailConfigurationError, EmailDeliveryError } from "../email/service";
import { getRegistrationCatalog } from "../services/registration-catalog";
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
  registrationStatusForSession,
  type RegistrationSubmissionInput,
} from "../services/registration-submission";
import { TurnstileError, verifyTurnstile } from "../security/turnstile";

type ErrorCode =
  | "configuration_error"
  | "internal_error"
  | "invalid_request"
  | "method_not_allowed"
  | "not_found"
  | "registration_unavailable"
  | "verification_failed";

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
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

function registrationWritesAvailable(env: WorkerEnv): boolean {
  return env.APP_ENV === "staging"
    && env.REGISTRATION_WRITE_ENABLED === "true"
    && env.EMAIL_ENABLED === "true"
    && env.AUTH_EMAIL_ENABLED === "true";
}

function registrationError(caught: unknown): Response {
  if (caught instanceof TurnstileError) {
    return error("invalid_request", "Хамгаалалтын шалгалтыг дахин хийнэ үү.", 400);
  }
  if (caught instanceof RegistrationSubmissionError) {
    if (caught.code === "capacity_changed") {
      return error("registration_unavailable", "Сонгосон ангийн суудал саяхан дүүрлээ. Анги, цагаа дахин сонгоно уу.", 409);
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

export async function handleApiRequest(request: Request, env: WorkerEnv): Promise<Response> {
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
          hasProvisionalHold: draft.hasProvisionalHold,
          provisionalDeadlineAt: draft.provisionalDeadlineAt,
        }, 202, { "Cache-Control": "no-store", "Set-Cookie": draft.accessCookie });
      }
      return json({
        ok: true,
        emailSent: true,
        email: draft.email,
        hasProvisionalHold: draft.hasProvisionalHold,
        provisionalDeadlineAt: draft.provisionalDeadlineAt,
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
      const status = await registrationStatusForSession(env.DB, readCookie(request, VERIFIED_EMAIL_COOKIE));
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
      await joinOriginalClassWaitlist(env.DB, readCookie(request, VERIFIED_EMAIL_COOKIE), childId);
      return json({ ok: true }, 200, { "Cache-Control": "no-store" });
    } catch (caught) {
      return registrationError(caught);
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

  return authNotFound();
}
