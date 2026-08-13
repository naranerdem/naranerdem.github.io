/**
 * Source-controlled initialization templates for non-private operational data.
 *
 * Keep the arrays empty until the owner supplies approved real program lesson
 * names and school-calendar dates. These templates are imported explicitly;
 * they never overwrite teacher-edited or published D1 records.
 *
 * Program shape:
 * { key, kind: 'annual_course' | 'summer_course', displayName, academicYear?,
 *   stageCode?, lessons: [{ title, internalNote? }] }
 *
 * School-period shape:
 * { key, academicYearKey, label, startsOn, endsOn,
 *   generationBehavior: 'exclude_by_default' | 'warn_only' }
 */
export const operationalDefaults = Object.freeze({
  version: 1,
  programs: Object.freeze([]),
  schoolCalendarPeriods: Object.freeze([]),
});
