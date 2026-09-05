function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function mnt(value: number): string {
  return `${new Intl.NumberFormat("mn-MN").format(value)} ₮`;
}

export interface EnrollmentConfirmationChild {
  childName: string;
  academicYearLabel: string;
  offeringLabel: string;
  classLabel: string;
  paidAmountMnt: number;
  remainingAmountMnt: number;
  remainingPaymentDueAt: string | null;
  referralCode: string | null;
}

export interface EnrollmentReferralPolicy {
  referrerBasisPoints: number;
  referredChildBasisPoints: number;
}

function percentage(basisPoints: number): string {
  return `${basisPoints / 100}%`;
}

export function enrollmentCommunicationDetails(child: EnrollmentConfirmationChild, policy: EnrollmentReferralPolicy) {
  const referralLines = child.referralCode ? [
    `Найзаа урьж бүртгүүлбэл найз нь ${percentage(policy.referredChildBasisPoints)}, танай хүүхэд ${percentage(policy.referrerBasisPoints)}-ийн төлбөрийн хөнгөлөлт эдэлнэ.`,
    `Найзаа урих код: ${child.referralCode}`,
    "Энэ кодыг найздаа илгээнэ үү.",
  ] : [];
  return {
    enrollmentLine: `${child.academicYearLabel} · ${child.offeringLabel} · ${child.classLabel}`,
    paymentLines: child.remainingAmountMnt > 0
      ? [`Төлсөн: ${mnt(child.paidAmountMnt)}`, `Үлдсэн: ${mnt(child.remainingAmountMnt)}`,
        ...(child.remainingPaymentDueAt ? [`Төлөх хугацаа: ${child.remainingPaymentDueAt.slice(0, 10)}`] : [])]
      : ["Төлбөр бүрэн төлөгдсөн."],
    referralLines,
  };
}

export function enrollmentManualMessage(input: { child: EnrollmentConfirmationChild; referralPolicy: EnrollmentReferralPolicy }) {
  const details = enrollmentCommunicationDetails(input.child, input.referralPolicy);
  return [
    `Сайн байна уу. ${input.child.childName} хүүхдийн бүртгэл баталгаажлаа.`,
    details.enrollmentLine,
    "Манай сургалтад бүртгүүлсэнд баярлалаа.",
    ...(details.referralLines.length ? ["", ...details.referralLines] : []),
    "",
    "Наран Эрдэм",
  ].join("\n");
}

export function enrollmentConfirmationTemplate(input: { children: EnrollmentConfirmationChild[]; accessUrl: string; referralPolicy: EnrollmentReferralPolicy }) {
  const items = input.children.map((child) => {
    const details = enrollmentCommunicationDetails(child, input.referralPolicy);
    const referral = details.referralLines.length ? `<p>${details.referralLines.map(escapeHtml).join("<br>")}</p>` : "";
    return `<section><p><strong>${escapeHtml(child.childName)} хүүхдийн бүртгэл баталгаажлаа.</strong><br>${escapeHtml(details.enrollmentLine)}</p><p>${details.paymentLines.map(escapeHtml).join("<br>")}</p>${referral}</section>`;
  }).join("<hr style=\"border:0;border-top:1px solid #dfe4ec;margin:20px 0\">");
  const textItems = input.children.map((child) => {
    const details = enrollmentCommunicationDetails(child, input.referralPolicy);
    return `${child.childName} хүүхдийн бүртгэл баталгаажлаа.\n${details.enrollmentLine}\n${details.paymentLines.join("\n")}${details.referralLines.length ? `\n${details.referralLines.join("\n")}` : ""}`;
  }).join("\n\n");
  const safeUrl = escapeHtml(input.accessUrl);
  return {
    subject: "Наран Эрдэм — Бүртгэл баталгаажлаа",
    html: `<!doctype html><html lang="mn"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border:1px solid #dfe4ec;border-radius:8px"><h1 style="margin:0 0 16px;color:#052b83;font-size:24px">Бүртгэл баталгаажлаа</h1><p>Манай сургалтад бүртгүүлсэнд баярлалаа.</p>${items}<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#073aaf;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Бүртгэлээ харах</a></p><p style="font-size:14px;color:#5d6575">Энэ холбоос 24 цагийн дараа хүчингүй болно.</p><p>Наран Эрдэм</p></div></body></html>`,
    text: `Наран Эрдэм — Бүртгэл баталгаажлаа\n\nМанай сургалтад бүртгүүлсэнд баярлалаа.\n\n${textItems}\n\nБүртгэлээ харах:\n${input.accessUrl}\n\nЭнэ холбоос 24 цагийн дараа хүчингүй болно.\n\nНаран Эрдэм`,
  };
}
