function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function mnt(value: number): string {
  return `${new Intl.NumberFormat("mn-MN").format(value)} ₮`;
}

export interface EnrollmentConfirmationChild {
  childName: string;
  offeringLabel: string;
  classLabel: string;
  paidAmountMnt: number;
  remainingAmountMnt: number;
  remainingPaymentDueAt: string | null;
  referralCode: string | null;
}

export function enrollmentConfirmationTemplate(input: { children: EnrollmentConfirmationChild[]; accessUrl: string }) {
  const items = input.children.map((child) => {
    const balance = child.remainingAmountMnt > 0
      ? `<p>Төлсөн: ${mnt(child.paidAmountMnt)}<br>Үлдсэн: ${mnt(child.remainingAmountMnt)}${child.remainingPaymentDueAt ? `<br>Төлөх хугацаа: ${escapeHtml(child.remainingPaymentDueAt.slice(0, 10))}` : ""}</p>`
      : `<p>Төлбөр бүрэн төлөгдсөн.</p>`;
    const referral = child.referralCode ? `<p>Найзаа урих код: <strong>${escapeHtml(child.referralCode)}</strong></p>` : "";
    return `<section><p><strong>${escapeHtml(child.childName)}</strong><br>${escapeHtml(child.offeringLabel)}<br>${escapeHtml(child.classLabel)}</p>${balance}${referral}</section>`;
  }).join("<hr style=\"border:0;border-top:1px solid #dfe4ec;margin:20px 0\">");
  const textItems = input.children.map((child) => `${child.childName}\n${child.offeringLabel}\n${child.classLabel}\nТөлсөн: ${mnt(child.paidAmountMnt)}\nҮлдсэн: ${mnt(child.remainingAmountMnt)}${child.remainingPaymentDueAt ? `\nТөлөх хугацаа: ${child.remainingPaymentDueAt.slice(0, 10)}` : ""}${child.referralCode ? `\nНайзаа урих код: ${child.referralCode}` : ""}`).join("\n\n");
  const safeUrl = escapeHtml(input.accessUrl);
  return {
    subject: "Наран Эрдэм — Бүртгэл баталгаажлаа",
    html: `<!doctype html><html lang="mn"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border:1px solid #dfe4ec;border-radius:8px"><h1 style="margin:0 0 16px;color:#052b83;font-size:24px">Бүртгэл баталгаажлаа</h1><p>Таны хүүхдийн сургалтын суудал баталгаажлаа.</p>${items}<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#073aaf;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Бүртгэлээ харах</a></p><p style="font-size:14px;color:#5d6575">Энэ холбоос 24 цагийн дараа хүчингүй болно.</p></div></body></html>`,
    text: `Наран Эрдэм — Бүртгэл баталгаажлаа\n\nТаны хүүхдийн сургалтын суудал баталгаажлаа.\n\n${textItems}\n\nБүртгэлээ харах:\n${input.accessUrl}\n\nЭнэ холбоос 24 цагийн дараа хүчингүй болно.`,
  };
}
