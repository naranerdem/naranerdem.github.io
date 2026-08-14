/**
 * Source-controlled initialization templates for non-private operational data.
 *
 * These public templates are imported explicitly and never overwrite
 * teacher-edited D1 records. Private curricula are managed in D1 and
 * git-ignored private Program bundles instead of this module.
 *
 * Academic-year shape:
 * { key, label, startsOn, endsOn }
 *
 * School-period shape:
 * { key, academicYearKey, label, startsOn, endsOn,
 *   excludeFromGeneration: boolean, warnOnOverlap: boolean }
 */
export const operationalDefaults = Object.freeze({
  version: 5,
  academicYears: Object.freeze([
    Object.freeze({
      key: "2026-27",
      label: "2026–2027 хичээлийн жил",
      startsOn: "2026-09-01",
      endsOn: "2027-06-01",
    }),
  ]),
  // БШУЯ-ны 2026-07-08-ны А/211 тушаал, Хавсралт 1-ийн Улаанбаатар
  // хотын VI–IX ангийн мөрийг Наран Эрдмийн хуваарийн удирдамж болгон
  // буулгав. Эдгээр нь анхны үүсгэх үеийн удирдамж бөгөөд багш тухайн
  // ангийн өдрийг сэргээж, хадгалсан хуанлиа цаашид өөрөө удирдана.
  schoolCalendarPeriods: Object.freeze([
    Object.freeze({ key: "2026-27-autumn-break", academicYearKey: "2026-27", label: "Намрын амралт", startsOn: "2026-10-31", endsOn: "2026-11-08", excludeFromGeneration: true, warnOnOverlap: true }),
    Object.freeze({ key: "2026-27-winter-break", academicYearKey: "2026-27", label: "Өвлийн завсарлага", startsOn: "2026-12-26", endsOn: "2027-01-17", excludeFromGeneration: true, warnOnOverlap: true }),
    Object.freeze({ key: "2026-27-tsagaan-sar-study", academicYearKey: "2026-27", label: "Цагаан сарын үеийн бие даалт", startsOn: "2027-02-08", endsOn: "2027-02-12", excludeFromGeneration: true, warnOnOverlap: true }),
    Object.freeze({ key: "2026-27-spring-break", academicYearKey: "2026-27", label: "Хаврын амралт", startsOn: "2027-03-20", endsOn: "2027-03-28", excludeFromGeneration: true, warnOnOverlap: true }),
    Object.freeze({ key: "2026-27-republic-day", academicYearKey: "2026-27", label: "Бүгд Найрамдах Улс тунхагласан өдөр", startsOn: "2026-11-26", endsOn: "2026-11-26", excludeFromGeneration: true, warnOnOverlap: true }),
    Object.freeze({ key: "2026-27-womens-day", academicYearKey: "2026-27", label: "Олон улсын эмэгтэйчүүдийн өдөр", startsOn: "2027-03-08", endsOn: "2027-03-08", excludeFromGeneration: true, warnOnOverlap: true }),
  ]),
});
