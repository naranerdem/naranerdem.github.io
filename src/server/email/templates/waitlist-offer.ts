function escape(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character); }

function mongolianDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const day = Number(parts.day);
  const suffix = [1, 4, 9].includes(day % 10) && ![11, 14, 19].includes(day) ? "ний" : "ны";
  return `${parts.year} оны ${Number(parts.month)}-р сарын ${day}-${suffix} ${parts.hour}:${parts.minute} цаг`;
}

export function waitlistOfferTemplate(input: { childName: string; classLabel: string; respondByAt: string; url: string }) {
  const deadline = mongolianDateTime(input.respondByAt);
  return {
    subject: "Наран Эрдэм — Танд суудал гарлаа",
    html: `<!doctype html><html lang="mn"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border:1px solid #dfe4ec;border-radius:8px"><h1 style="margin:0 0 16px;color:#052b83;font-size:24px">Танд суудал гарлаа</h1><p><strong>${escape(input.childName)}</strong> хүүхдэд <strong>${escape(input.classLabel)}</strong> ангид суудал гарлаа.</p><p>Боломжтой бол ${escape(deadline)} хүртэл шийдвэрээ мэдэгдэнэ үү. Хэрэв энэ хугацаанд хариу өгөх боломжгүй бол бид тантай дахин холбогдоно.</p><p><a href="${escape(input.url)}" style="display:inline-block;padding:12px 18px;background:#052b83;color:#fff;text-decoration:none;border-radius:6px">Сонголтоо мэдэгдэх</a></p><p>Хэрэв энэ хүсэлтийг та гаргаагүй бол энэ и-мэйлийг үл тоомсорлож болно.</p></div></body></html>`,
    text: `Наран Эрдэм — Танд суудал гарлаа\n\n${input.childName} хүүхдэд ${input.classLabel} ангид суудал гарлаа.\n\nБоломжтой бол ${deadline} хүртэл шийдвэрээ мэдэгдэнэ үү. Хэрэв энэ хугацаанд хариу өгөх боломжгүй бол бид тантай дахин холбогдоно.\n\n${input.url}`,
  };
}

export function waitlistPaymentInstructionsTemplate(input: { childName: string; amountMnt: number; deadline: string; bankName: string; accountHolder: string; accountNumber: string; transferDescription: string }) {
  const amount = `${new Intl.NumberFormat("en-US").format(input.amountMnt)} ₮`;
  const due = new Date(input.deadline).toLocaleString("mn-MN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Ulaanbaatar" });
  return { subject: "Наран Эрдэм — Төлбөрийн мэдээлэл", html: `<!doctype html><html lang="mn"><body><h1>Төлбөрийн мэдээлэл</h1><p>${escape(input.childName)} хүүхдийн суудал хадгалагдлаа.</p><p>Төлөх дүн: <strong>${escape(amount)}</strong><br>Хугацаа: <strong>${escape(due)}</strong></p><p>${escape(input.bankName)}<br>${escape(input.accountNumber)}<br>${escape(input.accountHolder)}<br>Гүйлгээний утга: <strong>${escape(input.transferDescription)}</strong></p></body></html>`, text: `Наран Эрдэм — Төлбөрийн мэдээлэл\n\n${input.childName} хүүхдийн суудал хадгалагдлаа.\nТөлөх дүн: ${amount}\nХугацаа: ${due}\n${input.bankName}\n${input.accountNumber}\n${input.accountHolder}\nГүйлгээний утга: ${input.transferDescription}` };
}
