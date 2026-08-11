import type { WorkerEnv } from "../env";
import { secureEqual } from "../auth/crypto";
import { EmailVerificationError, startEmailVerification, verifyEmailToken } from "../auth/email-verification";
import { EmailConfigurationError, EmailDeliveryError } from "../email/service";
import { getRegistrationCatalog } from "../services/registration-catalog";

type ErrorCode =
  | "configuration_error"
  | "internal_error"
  | "invalid_request"
  | "method_not_allowed"
  | "not_found"
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
      return json(await getRegistrationCatalog(env.DB, env.APP_ENV));
    } catch {
      return error("internal_error", "Бүртгэлийн мэдээллийг одоогоор авч чадсангүй.", 500);
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
    if (request.method !== "GET") return methodNotAllowed("GET");

    try {
      const result = await verifyEmailToken(env, new URL(request.url).searchParams.get("token") ?? "");
      return new Response(null, {
        status: 303,
        headers: {
          "Cache-Control": "no-store",
          Location: result.redirectUrl,
          "Set-Cookie": result.cookie,
        },
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
