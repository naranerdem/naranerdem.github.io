function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function staffLoginTemplate(loginUrl: string) {
  const safeUrl = escapeHtml(loginUrl);
  return {
    subject: "Наран Эрдэм — Ажилтны нэвтрэх холбоос",
    html: `<!doctype html>
<html lang="mn">
  <body style="margin:0;padding:24px;background:#f5f7fa;color:#172033;font-family:Arial,sans-serif;line-height:1.55">
    <main style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dce2ea;padding:28px">
      <h1 style="margin:0 0 16px;font-size:22px">Ажилтны нэвтрэх холбоос</h1>
      <p>Наран Эрдэмийн ажилтны хэсэгт нэвтрэх хүсэлт ирлээ.</p>
      <p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#073aaf;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700">Нэвтрэх хүсэлтийг баталгаажуулах</a></p>
      <p>Энэ холбоос 15 минутын дараа хүчингүй болно. Нэг удаа ашиглана.</p>
      <p>Та энэ хүсэлтийг гаргаагүй бол и-мэйлийг үл хэрэгсээрэй.</p>
    </main>
  </body>
</html>`,
    text: `Ажилтны нэвтрэх холбоос

Наран Эрдэмийн ажилтны хэсэгт нэвтрэх хүсэлт ирлээ.

${loginUrl}

Энэ холбоос 15 минутын дараа хүчингүй болно. Нэг удаа ашиглана.
Та энэ хүсэлтийг гаргаагүй бол и-мэйлийг үл хэрэгсээрэй.`,
  };
}
