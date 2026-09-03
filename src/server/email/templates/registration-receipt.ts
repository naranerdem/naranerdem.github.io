import { mongolianDateTime } from "./mongolian-date";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character] ?? character);
}

function amount(value: number): string {
  return `${new Intl.NumberFormat("en-US").format(value)} ₮`;
}

export interface RegistrationReceiptItem {
  childName: string;
  classLabel: string;
  initialAmountMnt: number;
  paymentDeadlineAt: string;
}

export function registrationReceiptTemplate(input: {
  items: RegistrationReceiptItem[];
  transferDescription: string | null;
  bankName: string | null;
  accountHolderName: string | null;
  accountNumber: string | null;
  iban: string | null;
  transferInstruction: string | null;
}) {
  const itemsHtml = input.items.map((item) => `<li><strong>${escape(item.childName)}</strong><br>${escape(item.classLabel)}<br>Одоо төлөх: <strong>${escape(amount(item.initialAmountMnt))}</strong><br>Хугацаа: <strong>${escape(mongolianDateTime(item.paymentDeadlineAt))}</strong></li>`).join("");
  const itemsText = input.items.map((item) => `${item.childName}\n${item.classLabel}\nОдоо төлөх: ${amount(item.initialAmountMnt)}\nХугацаа: ${mongolianDateTime(item.paymentDeadlineAt)}`).join("\n\n");
  const bankHtml = input.bankName && input.accountHolderName && input.accountNumber
    ? `<p>${escape(input.bankName)} · <strong>${escape(input.accountNumber)}</strong><br>${escape(input.accountHolderName)}${input.iban ? `<br>IBAN: ${escape(input.iban)}` : ""}${input.transferInstruction ? `<br>${escape(input.transferInstruction)}` : ""}</p>`
    : "";
  const bankText = input.bankName && input.accountHolderName && input.accountNumber
    ? `\n${input.bankName} · ${input.accountNumber}\n${input.accountHolderName}${input.iban ? `\nIBAN: ${input.iban}` : ""}${input.transferInstruction ? `\n${input.transferInstruction}` : ""}`
    : "";
  const transferHtml = input.transferDescription ? `<p>Гүйлгээний утга: <strong>${escape(input.transferDescription)}</strong></p>` : "";
  const transferText = input.transferDescription ? `\nГүйлгээний утга: ${input.transferDescription}` : "";

  return {
    subject: "Наран Эрдэм — Бүртгэлийн мэдээллийг хүлээн авлаа",
    html: `<!doctype html><html lang="mn"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border:1px solid #dfe4ec;border-radius:8px"><h1 style="margin:0 0 16px;color:#052b83;font-size:24px">Бүртгэлийн мэдээллийг хүлээн авлаа</h1><p>Таны хүүхдийн бүртгэл хүлээн авагдаж, эхний төлбөрийг хүлээж байна.</p><ul>${itemsHtml}</ul>${transferHtml}${bankHtml}<p>Төлбөрийн мэдээллийг бүртгэл илгээсний дараах дэлгэцээс мөн харж болно.</p></div></body></html>`,
    text: `Наран Эрдэм — Бүртгэлийн мэдээллийг хүлээн авлаа\n\nТаны хүүхдийн бүртгэл хүлээн авагдаж, эхний төлбөрийг хүлээж байна.\n\n${itemsText}${transferText}${bankText}\n\nТөлбөрийн мэдээллийг бүртгэл илгээсний дараах дэлгэцээс мөн харж болно.`,
  };
}
