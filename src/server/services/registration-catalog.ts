import type { AppEnvironment, D1Database } from "../env";
import { activeWindowForOfferingSql, mongoliaCivilDate } from "./registration-windows";
import { getClassCapacityProjections } from "./class-capacity";

interface CatalogRow {
  academicYearId: string;
  academicYearLabel: string;
  classSessionId: string;
  stageCode: "stage_1" | "stage_2" | "stage_3";
  displayLabel: string;
  weekday: string;
  startTime: string;
  endTime: string;
  activeHoldCount: number;
  operationallyRegisterable: number;
  oneTimeAmountMnt: number | null;
  twoInstallmentEnabled: number | null;
  firstInstallmentAmountMnt: number | null;
  secondInstallmentAmountMnt: number | null;
  secondInstallmentDueOn: string | null;
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
      activeHoldCount: number;
      remainingSeats: number;
      availability: "available" | "full" | "unavailable";
      paymentOptions: Array<{
        code: "single" | "two_installment";
        totalAmountMnt: number;
        initialAmountMnt: number;
        secondAmountMnt?: number;
        secondDueOn?: string;
      }>;
    }>;
  }>;
  paymentPlans: [];
}

function generatedClassLabel(stageCode: CatalogRow["stageCode"], weekday: string, startTime: string): string {
  const stage = ({ stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" })[stageCode];
  return `${stage} · ${weekday} ${startTime}`;
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
    pricing.one_time_amount_mnt AS oneTimeAmountMnt,
    pricing.two_installment_enabled AS twoInstallmentEnabled,
    pricing.first_installment_amount_mnt AS firstInstallmentAmountMnt,
    pricing.second_installment_amount_mnt AS secondInstallmentAmountMnt,
    pricing.second_installment_due_on AS secondInstallmentDueOn,
    COALESCE(active_holds.count, 0) + COALESCE(draft_holds.count, 0) AS activeHoldCount,
    CASE
      WHEN class_session.status = 'closed' OR offering.kind NOT IN ('annual_course', 'summer_course')
        OR NOT ${activeWindowForOfferingSql("offering.id")}
        OR pricing.one_time_amount_mnt IS NULL
        OR payment_settings.bank_name IS NULL OR payment_settings.account_holder_name IS NULL OR payment_settings.account_number IS NULL THEN 0
      ELSE 1
    END AS operationallyRegisterable
  FROM academic_year
  INNER JOIN class_session ON class_session.academic_year_id = academic_year.id
  LEFT JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
  LEFT JOIN offering_course_pricing AS pricing ON pricing.activity_offering_id = offering.id
  LEFT JOIN payment_collection_settings AS payment_settings ON payment_settings.singleton = 1
  LEFT JOIN (
    SELECT enrollment.class_session_id, COUNT(*) AS count
    FROM enrollment
    INNER JOIN application_child ON application_child.id = enrollment.application_child_id
    INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
    WHERE enrollment.status = 'awaiting_initial_payment'
      AND application_child.status = 'hold_created'
      AND pre_registration.status IN ('submitted', 'under_review', 'awaiting_assignment')
      AND pre_registration.deleted_at IS NULL
    GROUP BY enrollment.class_session_id
  ) AS active_holds ON active_holds.class_session_id = class_session.id
  LEFT JOIN (
    SELECT class_session_id, COUNT(*) AS count
    FROM registration_capacity_hold
    WHERE status = 'active'
      AND (hold_type = 'initial_payment' OR deadline_at > ?)
    GROUP BY class_session_id
  ) AS draft_holds ON draft_holds.class_session_id = class_session.id
  WHERE ${activeWindowForOfferingSql("offering.id")}
    AND class_session.status IN ('available', 'full', 'closed')
  ORDER BY academic_year.starts_on, academic_year.public_label,
    CASE class_session.stage_code WHEN 'stage_1' THEN 1 WHEN 'stage_2' THEN 2 WHEN 'stage_3' THEN 3 ELSE 9 END,
    CASE class_session.weekday WHEN 'Даваа' THEN 1 WHEN 'Мягмар' THEN 2 WHEN 'Лхагва' THEN 3 WHEN 'Пүрэв' THEN 4 WHEN 'Баасан' THEN 5 WHEN 'Бямба' THEN 6 WHEN 'Ням' THEN 7 ELSE 9 END,
    class_session.start_time, class_session.id
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
    pricing.one_time_amount_mnt AS oneTimeAmountMnt,
    pricing.two_installment_enabled AS twoInstallmentEnabled,
    pricing.first_installment_amount_mnt AS firstInstallmentAmountMnt,
    pricing.second_installment_amount_mnt AS secondInstallmentAmountMnt,
    pricing.second_installment_due_on AS secondInstallmentDueOn,
    COALESCE(active_holds.count, 0) + COALESCE(draft_holds.count, 0) AS activeHoldCount,
    CASE
      WHEN class_session.status = 'closed' OR offering.kind NOT IN ('annual_course', 'summer_course')
        OR NOT ${activeWindowForOfferingSql("offering.id")}
        OR pricing.one_time_amount_mnt IS NULL
        OR payment_settings.bank_name IS NULL OR payment_settings.account_holder_name IS NULL OR payment_settings.account_number IS NULL THEN 0
      ELSE 1
    END AS operationallyRegisterable
  FROM academic_year
  INNER JOIN class_session ON class_session.academic_year_id = academic_year.id
  LEFT JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
  LEFT JOIN offering_course_pricing AS pricing ON pricing.activity_offering_id = offering.id
  LEFT JOIN payment_collection_settings AS payment_settings ON payment_settings.singleton = 1
  LEFT JOIN (
    SELECT enrollment.class_session_id, COUNT(*) AS count
    FROM enrollment
    INNER JOIN application_child ON application_child.id = enrollment.application_child_id
    INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
    WHERE enrollment.status = 'awaiting_initial_payment'
      AND enrollment.is_test = 0
      AND application_child.is_test = 0
      AND pre_registration.is_test = 0
      AND application_child.status = 'hold_created'
      AND pre_registration.status IN ('submitted', 'under_review', 'awaiting_assignment')
      AND pre_registration.deleted_at IS NULL
    GROUP BY enrollment.class_session_id
  ) AS active_holds ON active_holds.class_session_id = class_session.id
  LEFT JOIN (
    SELECT registration_capacity_hold.class_session_id, COUNT(*) AS count
    FROM registration_capacity_hold
    INNER JOIN registration_draft_child
      ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
    INNER JOIN registration_draft
      ON registration_draft.id = registration_draft_child.registration_draft_id
    WHERE registration_capacity_hold.status = 'active'
      AND (registration_capacity_hold.hold_type = 'initial_payment'
        OR registration_capacity_hold.deadline_at > ?)
      AND registration_capacity_hold.is_test = 0
      AND registration_draft_child.is_test = 0
      AND registration_draft.is_test = 0
    GROUP BY registration_capacity_hold.class_session_id
  ) AS draft_holds ON draft_holds.class_session_id = class_session.id
  WHERE ${activeWindowForOfferingSql("offering.id")}
    AND academic_year.is_test = ?
    AND class_session.is_test = ?
    AND class_session.is_test_only = ?
    AND class_session.status IN ('available', 'full', 'closed')
  ORDER BY academic_year.starts_on, academic_year.public_label,
    CASE class_session.stage_code WHEN 'stage_1' THEN 1 WHEN 'stage_2' THEN 2 WHEN 'stage_3' THEN 3 ELSE 9 END,
    CASE class_session.weekday WHEN 'Даваа' THEN 1 WHEN 'Мягмар' THEN 2 WHEN 'Лхагва' THEN 3 WHEN 'Пүрэв' THEN 4 WHEN 'Баасан' THEN 5 WHEN 'Бямба' THEN 6 WHEN 'Ням' THEN 7 ELSE 9 END,
    class_session.start_time, class_session.id
`;

export async function getRegistrationCatalog(
  database: D1Database,
  environment: AppEnvironment,
  nowDate = new Date(),
): Promise<RegistrationCatalog> {
  const now = nowDate.toISOString();
  const localDate = mongoliaCivilDate(nowDate);
  const statement = environment === "staging"
    ? database.prepare(stagingCatalogSql).bind(now, localDate, localDate, localDate, localDate)
    : database.prepare(productionCatalogSql).bind(now, localDate, localDate, localDate, localDate, 0, 0, 0);
  const result = await statement.all<CatalogRow>();
  const projectionByClassId = new Map((await getClassCapacityProjections(database, environment, nowDate))
    .map((projection) => [projection.classSessionId, projection]));
  const years = new Map<string, RegistrationCatalog["academicYears"][number]>();

  for (const row of result.results) {
    const projection = projectionByClassId.get(row.classSessionId);
    const remainingSeats = projection?.freeSeats ?? 0;
    const availability = row.operationallyRegisterable
      ? remainingSeats > 0 ? "available" : "full"
      : "unavailable";
    let year = years.get(row.academicYearId);
    if (!year) {
      year = { id: row.academicYearId, label: row.academicYearLabel, classSessions: [] };
      years.set(row.academicYearId, year);
    }

    const paymentOptions: RegistrationCatalog["academicYears"][number]["classSessions"][number]["paymentOptions"] = [];
    if (row.oneTimeAmountMnt && row.oneTimeAmountMnt > 0) {
      paymentOptions.push({ code: "single", totalAmountMnt: row.oneTimeAmountMnt, initialAmountMnt: row.oneTimeAmountMnt });
      if (row.twoInstallmentEnabled && row.firstInstallmentAmountMnt && row.secondInstallmentAmountMnt && row.secondInstallmentDueOn) {
        paymentOptions.push({ code: "two_installment", totalAmountMnt: row.firstInstallmentAmountMnt + row.secondInstallmentAmountMnt,
          initialAmountMnt: row.firstInstallmentAmountMnt, secondAmountMnt: row.secondInstallmentAmountMnt, secondDueOn: row.secondInstallmentDueOn });
      }
    }
    year.classSessions.push({
      id: row.classSessionId,
      stageCode: row.stageCode,
      label: generatedClassLabel(row.stageCode, row.weekday, row.startTime),
      weekday: row.weekday,
      startTime: row.startTime,
      endTime: row.endTime,
      activeHoldCount: projection
        ? projection.reservedInitialPaymentCount + projection.legacyReservationCount
        : 0,
      remainingSeats,
      availability,
      paymentOptions,
    });
  }

  return { academicYears: [...years.values()], paymentPlans: [] };
}
