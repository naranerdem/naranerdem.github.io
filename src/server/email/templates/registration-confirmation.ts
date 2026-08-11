function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function registrationConfirmationTemplate(verificationUrl: string) {
  const safeUrl = escapeHtml(verificationUrl);
  return {
    subject: "Наран Эрдэм — Бүртгэлээ баталгаажуулна уу",
    html: `<!doctype html>
<html lang="mn">
  <body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font-family:Arial,sans-serif;line-height:1.5">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border:1px solid #dfe4ec;border-radius:8px">
      <h1 style="margin:0 0 16px;color:#052b83;font-size:24px">Бүртгэлээ баталгаажуулна уу</h1>
      <p>Наран Эрдэмийн бүртгэлийг үргэлжлүүлэхийн тулд доорх товчийг дарж и-мэйл хаягаа баталгаажуулна уу.</p>
      <p>Холбоос 24 цагийн дараа хүчингүй болно. Түр хадгалсан суудал байгаа бол холбоосыг 20 минутын дотор нээхэд суудлыг төлбөр хүлээх 24 цагийн хугацаагаар шинээр хадгална.</p>
      <p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#073aaf;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Бүртгэлээ баталгаажуулах</a></p>
      <p style="font-size:14px;color:#5d6575">Хэрэв та ийм хүсэлт гаргаагүй бол энэ и-мэйлийг үл тоомсорлож болно.</p>
    </div>
  </body>
</html>`,
    text: `Наран Эрдэм — Бүртгэлээ баталгаажуулна уу

Наран Эрдэмийн бүртгэлийг үргэлжлүүлэхийн тулд доорх холбоосоор и-мэйл хаягаа баталгаажуулна уу.

Холбоос 24 цагийн дараа хүчингүй болно. Түр хадгалсан суудал байгаа бол холбоосыг 20 минутын дотор нээхэд суудлыг төлбөр хүлээх 24 цагийн хугацаагаар шинээр хадгална.

${verificationUrl}

Хэрэв та ийм хүсэлт гаргаагүй бол энэ и-мэйлийг үл тоомсорлож болно.`,
  };
}
