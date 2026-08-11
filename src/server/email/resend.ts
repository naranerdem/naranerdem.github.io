import { EmailProviderError, type EmailMessage, type EmailProvider, type EmailSendOptions } from "./provider";

interface ResendResponse {
  id?: string;
}

export function createResendProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EmailProvider {
  return {
    async send(message: EmailMessage, options: EmailSendOptions) {
      let response: Response;
      try {
        response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": options.idempotencyKey,
            "User-Agent": "NaranErdemWorker/1.0",
          },
          body: JSON.stringify(message),
        });
      } catch {
        throw new EmailProviderError("network_error", true);
      }

      if (!response.ok) {
        throw new EmailProviderError("provider_rejected", response.status === 429 || response.status >= 500);
      }

      const payload = (await response.json()) as ResendResponse;
      if (!payload.id) throw new EmailProviderError("invalid_provider_response", false);
      return { providerMessageId: payload.id };
    },
  };
}
