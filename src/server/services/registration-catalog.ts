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
  capacity: number;
  confirmedCount: number;
  activeHoldCount: number;
  remainingSeats: number;
  publicAvailability: "available" | "full" | "unavailable";
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
      availability: CatalogRow["publicAvailability"];
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
    class_session.capacity AS capacity,
    COALESCE(confirmed.count, 0) AS confirmedCount,
    COALESCE(active_holds.count, 0) + COALESCE(draft_holds.count, 0) AS activeHoldCount,
    MAX(class_session.capacity - COALESCE(confirmed.count, 0)
      - COALESCE(active_holds.count, 0) - COALESCE(draft_holds.count, 0), 0) AS remainingSeats,
    CASE
      WHEN class_session.status = 'closed' OR offering.kind NOT IN ('annual_course', 'summer_course')
        OR pricing.one_time_amount_mnt IS NULL
        OR payment_settings.bank_name IS NULL OR payment_settings.account_holder_name IS NULL OR payment_settings.account_number IS NULL THEN 'unavailable'
      WHEN class_session.capacity - COALESCE(confirmed.count, 0)
        - COALESCE(active_holds.count, 0) - COALESCE(draft_holds.count, 0) > 0 THEN 'available'
      ELSE 'full'
    END AS publicAvailability
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
    WHERE enrollment.status = 'confirmed'
      AND application_child.status = 'enrolled'
      AND pre_registration.status IN ('submitted', 'under_review', 'awaiting_assignment', 'completed')
      AND pre_registration.deleted_at IS NULL
    GROUP BY enrollment.class_session_id
  ) AS confirmed ON confirmed.class_session_id = class_session.id
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
    pricing.one_time_amount_mnt AS oneTimeAmountMnt,
    pricing.two_installment_enabled AS twoInstallmentEnabled,
    pricing.first_installment_amount_mnt AS firstInstallmentAmountMnt,
    pricing.second_installment_amount_mnt AS secondInstallmentAmountMnt,
    pricing.second_installment_due_on AS secondInstallmentDueOn,
    class_session.capacity AS capacity,
    COALESCE(confirmed.count, 0) AS confirmedCount,
    COALESCE(active_holds.count, 0) + COALESCE(draft_holds.count, 0) AS activeHoldCount,
    MAX(class_session.capacity - COALESCE(confirmed.count, 0)
      - COALESCE(active_holds.count, 0) - COALESCE(draft_holds.count, 0), 0) AS remainingSeats,
    CASE
      WHEN class_session.status = 'closed' OR offering.kind NOT IN ('annual_course', 'summer_course')
        OR pricing.one_time_amount_mnt IS NULL
        OR payment_settings.bank_name IS NULL OR payment_settings.account_holder_name IS NULL OR payment_settings.account_number IS NULL THEN 'unavailable'
      WHEN class_session.capacity - COALESCE(confirmed.count, 0)
        - COALESCE(active_holds.count, 0) - COALESCE(draft_holds.count, 0) > 0 THEN 'available'
      ELSE 'full'
    END AS publicAvailability
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
    WHERE enrollment.status = 'confirmed'
      AND enrollment.is_test = 0
      AND application_child.is_test = 0
      AND pre_registration.is_test = 0
      AND application_child.status = 'enrolled'
      AND pre_registration.status IN ('submitted', 'under_review', 'awaiting_assignment', 'completed')
      AND pre_registration.deleted_at IS NULL
    GROUP BY enrollment.class_session_id
  ) AS confirmed ON confirmed.class_session_id = class_session.id
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
  const now = new Date().toISOString();
  const statement = environment === "staging"
    ? database.prepare(stagingCatalogSql).bind(now, "open")
    : database.prepare(productionCatalogSql).bind(now, "open", 0, 0, 0);
  const result = await statement.all<CatalogRow>();
  const years = new Map<string, RegistrationCatalog["academicYears"][number]>();

  for (const row of result.results) {
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
      activeHoldCount: row.activeHoldCount,
      remainingSeats: row.remainingSeats,
      availability: row.publicAvailability,
      paymentOptions,
    });
  }

  return { academicYears: [...years.values()], paymentPlans: [] };
}
