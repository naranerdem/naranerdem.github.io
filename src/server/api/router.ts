import type { WorkerEnv } from "../env";
import { getRegistrationCatalog } from "../services/registration-catalog";

type ErrorCode = "internal_error" | "method_not_allowed" | "not_found";

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

function methodNotAllowed(): Response {
  return error("method_not_allowed", "Энэ хүсэлтийн арга одоогоор боломжгүй.", 405, { Allow: "GET" });
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

  return error("not_found", "Хүссэн API зам олдсонгүй.", 404);
}
