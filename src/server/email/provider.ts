export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendOptions {
  idempotencyKey: string;
}

export interface EmailSendResult {
  providerMessageId: string;
}

export interface EmailProvider {
  send(message: EmailMessage, options: EmailSendOptions): Promise<EmailSendResult>;
}

export class EmailProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super("Transactional email delivery failed.");
    this.name = "EmailProviderError";
  }
}
