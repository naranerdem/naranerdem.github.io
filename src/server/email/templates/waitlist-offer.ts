import { mongolianDateTime } from "./mongolian-date";

function escape(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character); }

export function waitlistOfferTemplate(input: { childName: string; classLabel: string; respondByAt: string; url: string }) {
  const deadline = mongolianDateTime(input.respondByAt);
  return {
    subject: "Наран Эрдэм — Танд суудал гарлаа",
    html: `<!doctype html><html lang="mn"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border:1px solid #dfe4ec;border-radius:8px"><h1 style="margin:0 0 16px;color:#052b83;font-size:24px">Танд суудал гарлаа</h1><p><strong>${escape(input.childName)}</strong> хүүхдэд <strong>${escape(input.classLabel)}</strong> ангид суудал гарлаа.</p><p>Боломжтой бол ${escape(deadline)} хүртэл шийдвэрээ мэдэгдэнэ үү.</p><p><a href="${escape(input.url)}" style="display:inline-block;padding:12px 18px;background:#052b83;color:#fff;text-decoration:none;border-radius:6px">Сонголтоо мэдэгдэх</a></p><p>Хэрэв энэ хүсэлтийг та гаргаагүй бол энэ и-мэйлийг үл тоомсорлож болно.</p></div></body></html>`,
    text: `Наран Эрдэм — Танд суудал гарлаа\n\n${input.childName} хүүхдэд ${input.classLabel} ангид суудал гарлаа.\n\nБоломжтой бол ${deadline} хүртэл шийдвэрээ мэдэгдэнэ үү.\n\n${input.url}`,
  };
}

export function waitlistPaymentInstructionsTemplate(input: { childName: string; amountMnt: number; deadline: string; bankName: string; accountHolder: string; accountNumber: string; iban: string | null; transferInstruction: string | null; transferDescription: string }) {
  const amount = `${new Intl.NumberFormat("en-US").format(input.amountMnt)} ₮`;
  const due = mongolianDateTime(input.deadline);
  const instruction = input.transferInstruction ? `<br>${escape(input.transferInstruction)}` : "";
  const textInstruction = input.transferInstruction ? `\n${input.transferInstruction}` : "";
  return { subject: "Наран Эрдэм — Төлбөрийн мэдээлэл", html: `<!doctype html><html lang="mn"><body><h1>Төлбөрийн мэдээлэл</h1><p>${escape(input.childName)} хүүхдийн суудал хадгалагдлаа.</p><p>Төлөх дүн: <strong>${escape(amount)}</strong><br>Хугацаа: <strong>${escape(due)}</strong></p><p>${escape(input.bankName)}<br>${escape(input.accountNumber)}<br>${escape(input.accountHolder)}${input.iban ? `<br>IBAN: ${escape(input.iban)}` : ""}${instruction}<br>Гүйлгээний утга: <strong>${escape(input.transferDescription)}</strong></p></body></html>`, text: `Наран Эрдэм — Төлбөрийн мэдээлэл\n\n${input.childName} хүүхдийн суудал хадгалагдлаа.\nТөлөх дүн: ${amount}\nХугацаа: ${due}\n${input.bankName}\n${input.accountNumber}\n${input.accountHolder}${input.iban ? `\nIBAN: ${input.iban}` : ""}${textInstruction}\nГүйлгээний утга: ${input.transferDescription}` };
}
