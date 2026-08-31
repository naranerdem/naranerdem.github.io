import { mongolianDateTime } from "./mongolian-date";

function escape(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character); }
function amount(value: number): string { return `${new Intl.NumberFormat("en-US").format(value)} ₮`; }

export function paymentReminderTemplate(input: {
  milestoneType: "initial_reminder" | "initial_overdue" | "later_reminder" | "partial_balance_reminder";
  childName: string; classLabel: string; amountMnt: number; dueAt: string; parentClaimed: boolean;
  bankName: string | null; accountHolderName: string | null; accountNumber: string | null; iban: string | null; transferInstruction: string | null;
}) {
  const overdue = input.milestoneType === "initial_overdue";
  const later = input.milestoneType === "later_reminder" || input.milestoneType === "partial_balance_reminder";
  const title = overdue ? "Төлбөрийн хугацаа өнгөрсөн байна" : "Төлбөрийн сануулга";
  const lead = overdue
    ? "Төлбөрийн хугацаа өнгөрсөн тул таны хүүхдийн суудал цуцлагдаж болзошгүйг анхаарна уу."
    : later ? "Дараагийн төлбөрийн хугацаа ойртож байна." : "Эхний төлбөрийн хугацаа ойртож байна.";
  const claimed = input.parentClaimed ? "Хэрэв та төлбөрөө аль хэдийн шилжүүлсэн бол дахин төлөх шаардлагагүй. Бид орж ирсэн шилжүүлгийг шалгаж байна." : "";
  const bank = input.bankName && input.accountHolderName && input.accountNumber
    ? `${input.bankName} · ${input.accountNumber}<br>${input.accountHolderName}${input.iban ? `<br>IBAN: ${input.iban}` : ""}${input.transferInstruction ? `<br>${input.transferInstruction}` : ""}` : "";
  const textBank = input.bankName && input.accountHolderName && input.accountNumber
    ? `\n${input.bankName} · ${input.accountNumber}\n${input.accountHolderName}${input.iban ? `\nIBAN: ${input.iban}` : ""}${input.transferInstruction ? `\n${input.transferInstruction}` : ""}` : "";
  return {
    subject: `Наран Эрдэм — ${title}`,
    html: `<!doctype html><html lang="mn"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border:1px solid #dfe4ec;border-radius:8px"><h1 style="margin:0 0 16px;color:#052b83;font-size:24px">${escape(title)}</h1><p>${escape(lead)}</p><p><strong>${escape(input.childName)}</strong><br>${escape(input.classLabel)}</p><p>Одоо төлөх дүн: <strong>${escape(amount(input.amountMnt))}</strong><br>Хугацаа: <strong>${escape(mongolianDateTime(input.dueAt))}</strong></p>${bank ? `<p>${bank}</p>` : ""}${claimed ? `<p>${escape(claimed)}</p>` : ""}<p>Асуух зүйл гарвал Наран Эрдэмтэй холбогдоно уу.</p></div></body></html>`,
    text: `Наран Эрдэм — ${title}\n\n${lead}\n\n${input.childName}\n${input.classLabel}\nОдоо төлөх дүн: ${amount(input.amountMnt)}\nХугацаа: ${mongolianDateTime(input.dueAt)}${textBank}${claimed ? `\n\n${claimed}` : ""}\n\nАсуух зүйл гарвал Наран Эрдэмтэй холбогдоно уу.`,
  };
}
