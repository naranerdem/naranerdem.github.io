import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildAnnualTimetableReport,
  buildClassScheduleReport,
  buildProgramReport,
  reportTableHtml,
  reportToTsv,
} from "../src/scripts/staff-reports.js";

const program = buildProgramReport(
  { displayName: "1-р шат" },
  { displayName: "1-р шатны хөтөлбөр", lessons: [
    { sequenceNumber: 1, title: "Соронз" },
    { sequenceNumber: 2, title: "=FORMULA()" },
  ] },
  "1-р шат",
);
assert.equal(program.rows.length, 2);
assert.match(reportToTsv(program), /^1-р шат\n1-р шатны хөтөлбөр\n2 хичээл\n\n№\tХичээл/m);
assert.match(reportToTsv(program), /'\=FORMULA\(\)/, "TSV neutralizes spreadsheet formulas");
assert.match(reportTableHtml(program), /<td>Соронз<\/td>/);

const calendar = { slots: [
  { localDate: "2026-10-03", startTime: "10:00", endTime: "11:20", status: "scheduled", lessonSequence: 1, lessonTitle: "Соронз" },
  { localDate: "2026-10-10", startTime: "10:00", endTime: "11:20", status: "no_class", reasonLabel: "Амралт" },
] };
const classReport = buildClassScheduleReport({ title: "2026–27 · 1-р шат" }, { displayLabel: "Бямба 10:00" }, calendar);
assert.equal(classReport.rows[0].state, "Хичээлтэй");
assert.equal(classReport.rows[1].state, "Хичээлгүй · Амралт");

const annual = buildAnnualTimetableReport({
  years: [{ id: "current", label: "2026–27", isCurrent: 1 }, { id: "old", label: "2025–26", isCurrent: 0 }],
  offerings: [
    { id: "annual-current", kind: "annual_course", status: "active", academicYearId: "current" },
    { id: "annual-old", kind: "annual_course", status: "active", academicYearId: "old" },
  ],
  classes: [
    { id: "class-1", offeringId: "annual-current", stageCode: "stage_1", displayLabel: "Бямба 10:00", weekday: "Бямба", startTime: "10:00", endTime: "11:20" },
    { id: "class-old", offeringId: "annual-old", stageCode: "stage_2", displayLabel: "Хуучин", weekday: "Ням", startTime: "10:00", endTime: "11:20" },
    { id: "class-4", offeringId: "annual-current", stageCode: "stage_4", displayLabel: "Дөрөв", weekday: "Ням", startTime: "12:00", endTime: "13:00" },
  ],
  revisions: [{ classSessionId: "class-1", status: "published", slots: calendar.slots }],
});
assert.equal(annual.rows.length, 1, "consolidated report uses current annual Stage 1–3 classes only");
assert.equal(annual.rows[0].stage, "1-р шат");
assert.equal(annual.rows[0].lessons, 1);

const programsSource = readFileSync("src/pages/staff/programs.astro", "utf8");
const scheduleSource = readFileSync("src/pages/staff/schedule.astro", "utf8");
const css = readFileSync("src/styles/global.css", "utf8");
assert.match(programsSource, /Хэвлэх \/ PDF/);
assert.match(programsSource, /Excel-д хуулах/);
assert.match(scheduleSource, /Жилийн хуваарь хэвлэх \/ PDF/);
assert.match(scheduleSource, /buildClassScheduleReport/);
assert.match(css, /@media print/);
assert.match(css, /body\.staff-print-mode/);

console.log("ok private staff Program, class schedule, annual timetable, print, and TSV reports");
