import type { AppEnvironment, D1Database } from "../env";

interface CatalogRow {
  academicYearId: string;
  academicYearLabel: string;
  classSessionId: string;
  stageCode: "stage_1" | "stage_2" | "stage_3";
  displayLabel: string;
  weekday: string;
  startTime: string;
  endTime: string;
  status: "available" | "full" | "closed";
}

export interface RegistrationCatalog {
  academicYears: Array<{
    id: string;
    label: string;
    classSessions: Array<{
      id: string;
      stageCode: CatalogRow["stageCode"];
      label: string;
      weekday: string;
      startTime: string;
      endTime: string;
      availability: CatalogRow["status"];
    }>;
  }>;
  paymentPlans: [];
}

const stagingCatalogSql = `
  SELECT
    academic_year.id AS academicYearId,
    academic_year.public_label AS academicYearLabel,
    class_session.id AS classSessionId,
    class_session.stage_code AS stageCode,
    class_session.display_label AS displayLabel,
    class_session.weekday AS weekday,
    class_session.start_time AS startTime,
    class_session.end_time AS endTime,
    class_session.status AS status
  FROM academic_year
  INNER JOIN class_session ON class_session.academic_year_id = academic_year.id
  WHERE academic_year.registration_status = ?
    AND class_session.status IN ('available', 'full', 'closed')
  ORDER BY academic_year.starts_on, academic_year.public_label, class_session.weekday, class_session.start_time
`;

const productionCatalogSql = `
  SELECT
    academic_year.id AS academicYearId,
    academic_year.public_label AS academicYearLabel,
    class_session.id AS classSessionId,
    class_session.stage_code AS stageCode,
    class_session.display_label AS displayLabel,
    class_session.weekday AS weekday,
    class_session.start_time AS startTime,
    class_session.end_time AS endTime,
    class_session.status AS status
  FROM academic_year
  INNER JOIN class_session ON class_session.academic_year_id = academic_year.id
  WHERE academic_year.registration_status = ?
    AND academic_year.is_test = ?
    AND class_session.is_test = ?
    AND class_session.is_test_only = ?
    AND class_session.status IN ('available', 'full', 'closed')
  ORDER BY academic_year.starts_on, academic_year.public_label, class_session.weekday, class_session.start_time
`;

export async function getRegistrationCatalog(
  database: D1Database,
  environment: AppEnvironment,
): Promise<RegistrationCatalog> {
  const statement = environment === "staging"
    ? database.prepare(stagingCatalogSql).bind("open")
    : database.prepare(productionCatalogSql).bind("open", 0, 0, 0);
  const result = await statement.all<CatalogRow>();
  const years = new Map<string, RegistrationCatalog["academicYears"][number]>();

  for (const row of result.results) {
    let year = years.get(row.academicYearId);
    if (!year) {
      year = { id: row.academicYearId, label: row.academicYearLabel, classSessions: [] };
      years.set(row.academicYearId, year);
    }

    year.classSessions.push({
      id: row.classSessionId,
      stageCode: row.stageCode,
      label: row.displayLabel,
      weekday: row.weekday,
      startTime: row.startTime,
      endTime: row.endTime,
      availability: row.status,
    });
  }

  return { academicYears: [...years.values()], paymentPlans: [] };
}
