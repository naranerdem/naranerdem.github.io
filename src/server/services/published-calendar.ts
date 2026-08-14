import type { AppEnvironment, D1Database } from "../env";

interface PublishedCalendarRow {
  academicYearId: string;
  academicYearLabel: string;
  calendarId: string;
  classSessionId: string;
  stageCode: "stage_1" | "stage_2" | "stage_3";
  weekday: string;
  startTime: string;
  endTime: string;
  timezone: "Asia/Ulaanbaatar";
  slotId: string;
  localDate: string;
  slotStartTime: string;
  slotEndTime: string;
  slotStatus: "scheduled" | "no_class" | "cancelled";
  reasonLabel: string | null;
  isTest: number;
}

export interface PublishedCalendarResponse {
  calendars: Array<{
    id: string;
    academicYear: { id: string; label: string };
    classSession: {
      id: string;
      label: string;
      stageCode: PublishedCalendarRow["stageCode"];
      weekday: string;
      startTime: string;
      endTime: string;
    };
    timezone: "Asia/Ulaanbaatar";
    entries: Array<{
      id: string;
      localDate: string;
      startTime: string;
      endTime: string;
      status: PublishedCalendarRow["slotStatus"];
      reasonLabel: string | null;
    }>;
  }>;
}

function generatedClassLabel(stageCode: PublishedCalendarRow["stageCode"], weekday: string, startTime: string): string {
  const stage = ({ stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" })[stageCode];
  return `${stage} · ${weekday} ${startTime}`;
}

const stagingSql = `
  SELECT
    academic_year.id AS academicYearId,
    academic_year.public_label AS academicYearLabel,
    class_calendar.id AS calendarId,
    class_session.id AS classSessionId,
    class_session.stage_code AS stageCode,
    class_session.weekday AS weekday,
    class_session.start_time AS startTime,
    class_session.end_time AS endTime,
    class_calendar.timezone AS timezone,
    class_calendar_slot.id AS slotId,
    class_calendar_slot.local_date AS localDate,
    class_calendar_slot.start_time AS slotStartTime,
    class_calendar_slot.end_time AS slotEndTime,
    class_calendar_slot.status AS slotStatus,
    class_calendar_slot.reason_label AS reasonLabel,
    class_calendar_slot.is_test AS isTest
  FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
  INNER JOIN class_calendar_revision
    ON class_calendar_revision.class_calendar_id = class_calendar.id
    AND class_calendar_revision.status = 'published'
  INNER JOIN class_calendar_slot
    ON class_calendar_slot.class_calendar_revision_id = class_calendar_revision.id
  WHERE academic_year.is_current = 1
    AND class_calendar.status = 'active'
  ORDER BY class_session.stage_code, class_session.weekday, class_session.start_time,
    class_calendar_slot.local_date, class_calendar_slot.start_time
`;

const productionSql = `
  SELECT
    academic_year.id AS academicYearId,
    academic_year.public_label AS academicYearLabel,
    class_calendar.id AS calendarId,
    class_session.id AS classSessionId,
    class_session.stage_code AS stageCode,
    class_session.weekday AS weekday,
    class_session.start_time AS startTime,
    class_session.end_time AS endTime,
    class_calendar.timezone AS timezone,
    class_calendar_slot.id AS slotId,
    class_calendar_slot.local_date AS localDate,
    class_calendar_slot.start_time AS slotStartTime,
    class_calendar_slot.end_time AS slotEndTime,
    class_calendar_slot.status AS slotStatus,
    class_calendar_slot.reason_label AS reasonLabel,
    class_calendar_slot.is_test AS isTest
  FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
  INNER JOIN class_calendar_revision
    ON class_calendar_revision.class_calendar_id = class_calendar.id
    AND class_calendar_revision.status = 'published'
  INNER JOIN class_calendar_slot
    ON class_calendar_slot.class_calendar_revision_id = class_calendar_revision.id
  WHERE academic_year.is_current = 1
    AND academic_year.is_test = 0
    AND class_session.is_test = 0
    AND class_session.is_test_only = 0
    AND class_calendar.status = 'active'
    AND class_calendar.is_test = 0
    AND class_calendar_revision.is_test = 0
    AND class_calendar_slot.is_test = 0
  ORDER BY class_session.stage_code, class_session.weekday, class_session.start_time,
    class_calendar_slot.local_date, class_calendar_slot.start_time
`;

export async function getPublishedCalendars(
  database: D1Database,
  environment: AppEnvironment,
): Promise<PublishedCalendarResponse> {
  const result = await database.prepare(environment === "staging" ? stagingSql : productionSql).all<PublishedCalendarRow>();
  const calendars = new Map<string, PublishedCalendarResponse["calendars"][number]>();

  for (const row of result.results) {
    let calendar = calendars.get(row.calendarId);
    if (!calendar) {
      calendar = {
        id: row.calendarId,
        academicYear: { id: row.academicYearId, label: row.academicYearLabel },
        classSession: {
          id: row.classSessionId,
          label: generatedClassLabel(row.stageCode, row.weekday, row.startTime),
          stageCode: row.stageCode,
          weekday: row.weekday,
          startTime: row.startTime,
          endTime: row.endTime,
        },
        timezone: row.timezone,
        entries: [],
      };
      calendars.set(row.calendarId, calendar);
    }

    calendar.entries.push({
      id: row.slotId,
      localDate: row.localDate,
      startTime: row.slotStartTime,
      endTime: row.slotEndTime,
      status: row.slotStatus,
      reasonLabel: row.reasonLabel,
    });
  }

  return { calendars: [...calendars.values()] };
}
