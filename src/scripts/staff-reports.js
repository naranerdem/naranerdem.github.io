const STAGES = { stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" };

function escape(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[character]);
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = String(value).split("-");
  return `${year}.${month}.${day}`;
}

function stageLabel(value) {
  return STAGES[value] || value || "";
}

function publishedCalendar(data, classSessionId) {
  return (data.revisions || []).find((entry) => entry.classSessionId === classSessionId && entry.status === "published") || null;
}

function report(title, subtitles, columns, rows) {
  return { title, subtitles: subtitles.filter(Boolean), columns, rows };
}

export function buildProgramReport(family, program, visibleName) {
  return report(
    visibleName || family?.displayName || program?.displayName || "Хөтөлбөр",
    [program?.displayName && program.displayName !== visibleName ? program.displayName : "", `${program?.lessons?.length || 0} хичээл`],
    [{ key: "number", label: "№" }, { key: "lesson", label: "Хичээл" }],
    (program?.lessons || []).map((lesson) => ({ number: lesson.sequenceNumber, lesson: lesson.title })),
  );
}

export function buildClassScheduleReport(offering, classSession, calendar) {
  const rows = (calendar?.slots || []).map((slot) => {
    const scheduled = slot.status === "scheduled";
    const reason = slot.reasonLabel || "";
    return {
      number: slot.lessonSequence || slot.cancelledLessonSequence || "",
      date: formatDate(slot.localDate),
      time: `${slot.startTime || ""}${slot.endTime ? `–${slot.endTime}` : ""}`,
      lesson: scheduled ? slot.lessonTitle || "" : slot.cancelledLessonTitle || "",
      state: scheduled ? "Хичээлтэй" : `Хичээлгүй${reason ? ` · ${reason}` : ""}`,
    };
  });
  return report(
    "Хичээлийн хуваарь",
    [offering?.title || "", classSession?.displayLabel || ""],
    [
      { key: "number", label: "№" },
      { key: "date", label: "Огноо" },
      { key: "time", label: "Цаг" },
      { key: "lesson", label: "Хичээл" },
      { key: "state", label: "Төлөв" },
    ],
    rows,
  );
}

export function buildAnnualTimetableReport(data) {
  const currentYear = (data.years || []).find((entry) => entry.isCurrent);
  const offeringIds = new Set((data.offerings || [])
    .filter((entry) => entry.kind === "annual_course"
      && entry.status === "active"
      && (!currentYear || entry.academicYearId === currentYear.id))
    .map((entry) => entry.id));
  const rows = (data.classes || [])
    .filter((entry) => offeringIds.has(entry.offeringId) && STAGES[entry.stageCode])
    .map((entry) => {
      const calendar = publishedCalendar(data, entry.id);
      const active = (calendar?.slots || []).filter((slot) => slot.status === "scheduled");
      return {
        stage: stageLabel(entry.stageCode),
        className: entry.displayLabel,
        meeting: `${entry.weekday || entry.weeklyWeekday || ""} ${entry.startTime || ""}–${entry.endTime || ""}`.trim(),
        lessons: active.length || "Хуваарь үүсгээгүй",
        span: active.length ? `${formatDate(active[0].localDate)} – ${formatDate(active.at(-1).localDate)}` : "",
      };
    })
    .sort((left, right) => `${left.stage}|${left.meeting}|${left.className}`.localeCompare(`${right.stage}|${right.meeting}|${right.className}`, "mn"));
  return report(
    "Жилийн сургалтын нэгдсэн хуваарь",
    [currentYear?.label || ""],
    [
      { key: "stage", label: "Шат" },
      { key: "className", label: "Анги" },
      { key: "meeting", label: "Гараг, цаг" },
      { key: "lessons", label: "Хичээл" },
      { key: "span", label: "Хугацаа" },
    ],
    rows,
  );
}

function tsvCell(value) {
  const clean = String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(clean) ? `'${clean}` : clean;
}

export function reportToTsv(value) {
  return [
    [value.title],
    ...(value.subtitles || []).map((subtitle) => [subtitle]),
    [],
    value.columns.map((column) => column.label),
    ...value.rows.map((row) => value.columns.map((column) => row[column.key])),
  ].map((row) => row.map(tsvCell).join("\t")).join("\n");
}

export function reportTableHtml(value) {
  return `<header><p>Наран Эрдэм</p><h1>${escape(value.title)}</h1>${(value.subtitles || []).map((subtitle) => `<p>${escape(subtitle)}</p>`).join("")}</header><table><thead><tr>${value.columns.map((column) => `<th>${escape(column.label)}</th>`).join("")}</tr></thead><tbody>${value.rows.map((row) => `<tr>${value.columns.map((column) => `<td>${escape(row[column.key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export async function copyReportToClipboard(value) {
  const tsv = reportToTsv(value);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(tsv);
    return;
  }
  const field = document.createElement("textarea");
  field.value = tsv;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = Reflect.get(document, "execCommand").call(document, "copy");
  field.remove();
  if (!copied) throw new Error("clipboard_unavailable");
}

/** Download the same Excel-friendly UTF-8 TSV used by the staff copy actions. */
export function downloadReportTsv(value, filename) {
  const blob = new Blob(["\uFEFF", reportToTsv(value)], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function buildRegistrationPaymentReport(data) {
  const items = data?.rows || [];
  return report(
    "Бүртгэл, төлбөрийн жагсаалт",
    [data?.generatedAt || ""],
    [
      { key: "status", label: "Төлөв" },
      { key: "child", label: "Хүүхэд" },
      { key: "birthDate", label: "Төрсөн огноо" },
      { key: "grade", label: "Анги" },
      { key: "school", label: "Сургууль" },
      { key: "guardian", label: "Асран хамгаалагч" },
      { key: "relationship", label: "Харилцаа" },
      { key: "phone", label: "Утас" },
      { key: "secondaryPhone", label: "Нэмэлт утас" },
      { key: "email", label: "И-мэйл" },
      { key: "emailStatus", label: "И-мэйл" },
      { key: "address", label: "Хаяг" },
      { key: "academicYear", label: "Хичээлийн жил" },
      { key: "offering", label: "Сургалт" },
      { key: "className", label: "Анги, цаг" },
      { key: "paymentPlan", label: "Төлбөрийн нөхцөл" },
      { key: "price", label: "Төлөх дүн" },
      { key: "discount", label: "Хөнгөлөлт" },
      { key: "paid", label: "Төлөгдсөн" },
      { key: "creditApplied", label: "Кредитээр тооцсон" },
      { key: "remaining", label: "Үлдсэн" },
      { key: "dueAt", label: "Дараагийн хугацаа" },
      { key: "ownReferral", label: "Найзаа урих код" },
      { key: "usedReferral", label: "Ашигласан урилгын код" },
      { key: "registeredAt", label: "Бүртгүүлсэн" },
    ],
    items.map((item) => ({
      ...item,
      // Excel otherwise removes a leading zero. The apostrophe is an Excel text marker.
      phone: item.phone ? `'${item.phone}` : "",
      secondaryPhone: item.secondaryPhone ? `'${item.secondaryPhone}` : "",
    })),
  );
}

export function printReport(value) {
  document.querySelector(".staff-print-report")?.remove();
  const container = document.createElement("section");
  container.className = "staff-print-report";
  container.innerHTML = reportTableHtml(value);
  document.body.append(container);
  document.body.classList.add("staff-print-mode");
  const cleanup = () => {
    document.body.classList.remove("staff-print-mode");
    container.remove();
  };
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
}
