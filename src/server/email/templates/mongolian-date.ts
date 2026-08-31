export function mongolianDateTime(value: string): string {
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
