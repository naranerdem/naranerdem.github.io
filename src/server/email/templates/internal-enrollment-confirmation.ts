import { enrollmentCommunicationDetails, type EnrollmentConfirmationChild, type EnrollmentReferralPolicy } from "./enrollment-confirmation";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function internalEnrollmentConfirmationTemplate(input: {
  children: EnrollmentConfirmationChild[];
  referralPolicy: EnrollmentReferralPolicy;
}) {
  const items = input.children.map((child) => {
    const details = enrollmentCommunicationDetails(child, input.referralPolicy);
    return `<li><strong>${escapeHtml(child.childName)}</strong><br>${escapeHtml(details.enrollmentLine)}<br>${details.paymentLines.map(escapeHtml).join("<br>")}</li>`;
  }).join("");
  const textItems = input.children.map((child) => {
    const details = enrollmentCommunicationDetails(child, input.referralPolicy);
    return `${child.childName}\n${details.enrollmentLine}\n${details.paymentLines.join("\n")}`;
  }).join("\n\n");
  return {
    subject: "Наран Эрдэм — Бүртгэл баталгаажлаа (дотоод мэдэгдэл)",
    html: `<!doctype html><html lang="mn"><body><h1>Бүртгэл баталгаажлаа</h1><p>Дотоод мэдэгдэл. Нэвтрэх, баталгаажуулах, эсвэл эцэг эхийн холбоос агуулаагүй.</p><ul>${items}</ul><p>Наран Эрдэм</p></body></html>`,
    text: `Наран Эрдэм — Бүртгэл баталгаажлаа\n\nДотоод мэдэгдэл. Нэвтрэх, баталгаажуулах, эсвэл эцэг эхийн холбоос агуулаагүй.\n\n${textItems}\n\nНаран Эрдэм`,
  };
}
