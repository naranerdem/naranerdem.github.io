function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function mnt(value: number): string {
  return `${new Intl.NumberFormat("mn-MN").format(value)} ₮`;
}

export interface PaymentConfirmedChild {
  childName: string;
  classLabel: string;
  receivedAmountMnt: number;
  totalPaidAmountMnt: number;
  remainingAmountMnt: number;
  nextPaymentAmountMnt: number | null;
  nextPaymentDueAt: string | null;
  seatConfirmed: boolean;
  facebookGroupUrl?: string | null;
}

export function paymentConfirmedTemplate(input: {
  children: PaymentConfirmedChild[];
  centerFacebookUrl?: string | null;
}) {
  const items = input.children.map((child) => {
    const next = child.remainingAmountMnt > 0 && child.nextPaymentAmountMnt != null && child.nextPaymentDueAt
      ? `<br>Дараагийн төлбөр: ${escapeHtml(mnt(child.nextPaymentAmountMnt))}<br>Төлөх хугацаа: ${escapeHtml(child.nextPaymentDueAt.slice(0, 10))}`
      : "";
    const group = child.facebookGroupUrl ? `<p><a href="${escapeHtml(child.facebookGroupUrl)}">Facebook бүлэгт нэгдэх</a></p>` : "";
    return `<section><p><strong>${escapeHtml(child.childName)}</strong><br>Анги: ${escapeHtml(child.classLabel)}<br>Хүлээн авсан төлбөр: <strong>${escapeHtml(mnt(child.receivedAmountMnt))}</strong><br>Нийт төлсөн: ${escapeHtml(mnt(child.totalPaidAmountMnt))}<br>Үлдсэн төлбөр: <strong>${escapeHtml(mnt(child.remainingAmountMnt))}</strong>${next}</p><p><strong>${child.seatConfirmed ? "Суудал баталгаажсан." : "Суудал хараахан баталгаажаагүй байна."}</strong></p>${group}</section>`;
  }).join('<hr style="border:0;border-top:1px solid #dfe4ec;margin:20px 0">');
  const textItems = input.children.map((child) => {
    const next = child.remainingAmountMnt > 0 && child.nextPaymentAmountMnt != null && child.nextPaymentDueAt
      ? `\nДараагийн төлбөр: ${mnt(child.nextPaymentAmountMnt)}\nТөлөх хугацаа: ${child.nextPaymentDueAt.slice(0, 10)}`
      : "";
    const group = child.facebookGroupUrl ? `\nFacebook бүлэгт нэгдэнэ үү: ${child.facebookGroupUrl}` : "";
    return `${child.childName}\nАнги: ${child.classLabel}\nХүлээн авсан төлбөр: ${mnt(child.receivedAmountMnt)}\nНийт төлсөн: ${mnt(child.totalPaidAmountMnt)}\nҮлдсэн төлбөр: ${mnt(child.remainingAmountMnt)}${next}\n${child.seatConfirmed ? "Суудал баталгаажсан." : "Суудал хараахан баталгаажаагүй байна."}${group}`;
  }).join("\n\n");
  const center = input.centerFacebookUrl ? `<p>Наран Эрдэмийн <a href="${escapeHtml(input.centerFacebookUrl)}">Facebook хуудсанд</a> өөрийн Facebook хаягаасаа нэг мессеж илгээнэ үү.</p>` : "";
  const textOnboarding = input.centerFacebookUrl ? `\n\nНаран Эрдэмийн Facebook хуудсанд өөрийн Facebook хаягаасаа нэг мессеж илгээнэ үү: ${input.centerFacebookUrl}` : "";
  return {
    subject: "Наран Эрдэм — Төлбөр баталгаажлаа",
    html: `<!doctype html><html lang="mn"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border:1px solid #dfe4ec;border-radius:8px"><h1 style="margin:0 0 16px;color:#052b83;font-size:24px">Төлбөр баталгаажлаа</h1><p>Наран Эрдэм таны төлбөрийг хүлээн авч баталгаажууллаа.</p>${items}<p>Хүүхэд Facebook хаягтай бол мөн бүлэгт нэгдэж болно.</p>${center}</div></body></html>`,
    text: `Наран Эрдэм — Төлбөр баталгаажлаа\n\nТаны төлбөрийг хүлээн авч баталгаажууллаа.\n\n${textItems}\n\nХүүхэд Facebook хаягтай бол мөн бүлэгт нэгдэж болно.${textOnboarding}`,
  };
}
