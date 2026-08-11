const subject = "Наран Эрдэм — И-мэйл хаягаа баталгаажуулна уу";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function emailVerificationTemplate(verificationUrl: string) {
  const safeUrl = escapeHtml(verificationUrl);
  return {
    subject,
    html: `<!doctype html>
<html lang="mn">
  <body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border:1px solid #dfe4ec;border-radius:8px">
      <h1 style="margin:0 0 16px;color:#052b83;font-size:24px">И-мэйл хаягаа баталгаажуулна уу</h1>
      <p>Энэ и-мэйл хаягийг Наран Эрдэмийн бүртгэлд ашигласан байна.</p>
      <p>Доорх товчийг дарж и-мэйл хаягаа баталгаажуулна уу. Холбоос 15 минутын дараа хүчингүй болно.</p>
      <p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#073aaf;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:bold">И-мэйл хаягаа баталгаажуулах</a></p>
      <p style="font-size:14px;color:#5d6575">Хэрэв та ийм хүсэлт гаргаагүй бол энэ и-мэйлийг үл тоомсорлож болно.</p>
    </div>
  </body>
</html>`,
    text: `Наран Эрдэм — И-мэйл хаягаа баталгаажуулна уу

Энэ и-мэйл хаягийг Наран Эрдэмийн бүртгэлд ашигласан байна.

Доорх холбоосоор и-мэйл хаягаа баталгаажуулна уу. Холбоос 15 минутын дараа хүчингүй болно.

${verificationUrl}

Хэрэв та ийм хүсэлт гаргаагүй бол энэ и-мэйлийг үл тоомсорлож болно.`,
  };
}
