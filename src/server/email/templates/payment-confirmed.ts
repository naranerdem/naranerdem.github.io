export function paymentConfirmedTemplate(input: { facebookGroupUrl?: string | null; centerFacebookUrl?: string | null } = {}) {
  const group = input.facebookGroupUrl ? `<p><a href="${input.facebookGroupUrl}">Facebook бүлэгт нэгдэх</a></p>` : "";
  const center = input.centerFacebookUrl ? `<p>Наран Эрдэмийн <a href="${input.centerFacebookUrl}">Facebook хуудсанд</a> өөрийн Facebook хаягаасаа нэг мессеж илгээнэ үү.</p>` : "";
  const textOnboarding = `${input.facebookGroupUrl ? `\nFacebook бүлэгт нэгдэнэ үү: ${input.facebookGroupUrl}\n` : ""}${input.centerFacebookUrl ? `\nНаран Эрдэмийн Facebook хуудсанд өөрийн Facebook хаягаасаа нэг мессеж илгээнэ үү: ${input.centerFacebookUrl}\n` : ""}`;
  return {
    subject: "Наран Эрдэм — Төлбөр баталгаажлаа",
    html: `<!doctype html><html lang="mn"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border:1px solid #dfe4ec;border-radius:8px"><h1 style="margin:0 0 16px;color:#052b83;font-size:24px">Төлбөр баталгаажлаа</h1><p>Наран Эрдэм таны эхний төлбөрийг хүлээн авч баталгаажууллаа.</p><p>Хүүхэд Facebook хаягтай бол мөн бүлэгт нэгдэж болно.</p>${group}${center}</div></body></html>`,
    text: `Наран Эрдэм — Төлбөр баталгаажлаа\n\nТаны эхний төлбөрийг хүлээн авч баталгаажууллаа.\nХүүхэд Facebook хаягтай бол мөн бүлэгт нэгдэж болно.${textOnboarding}`,
  };
}
