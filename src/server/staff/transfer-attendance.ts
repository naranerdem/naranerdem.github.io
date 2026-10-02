// A completed transfer carries the learner's course progress forward. This is
// deliberately scoped to the same academic year, curriculum program, and
// canonical lesson -- it is not a title-based attendance match.
export function completedTransferredLessonSql(input: {
  enrollmentAlias: string;
  lessonAlias: string;
  programAlias: string;
  slotAlias: string;
}): string {
  const { enrollmentAlias, lessonAlias, programAlias, slotAlias } = input;
  return `EXISTS (
    WITH RECURSIVE transfer_lineage(enrollment_id) AS (
      SELECT ${enrollmentAlias}.id
      UNION
      SELECT transfer.source_enrollment_id
      FROM class_transfer AS transfer
      INNER JOIN transfer_lineage ON transfer.target_enrollment_id = transfer_lineage.enrollment_id
      WHERE transfer.status = 'completed'
    )
    SELECT 1
    FROM transfer_lineage
    INNER JOIN course_attendance AS prior_attendance
      ON prior_attendance.enrollment_id = transfer_lineage.enrollment_id
      AND prior_attendance.attendance_status IN ('present', 'late')
    INNER JOIN enrollment AS prior_enrollment ON prior_enrollment.id = prior_attendance.enrollment_id
    INNER JOIN class_session AS prior_class ON prior_class.id = prior_attendance.class_session_id
    INNER JOIN activity_offering AS prior_offering ON prior_offering.id = prior_class.activity_offering_id
    WHERE prior_enrollment.academic_year_id = ${enrollmentAlias}.academic_year_id
      AND prior_offering.curriculum_program_id = ${programAlias}.id
      AND prior_attendance.curriculum_lesson_id = ${lessonAlias}.id
      AND prior_attendance.scheduled_local_date < ${slotAlias}.local_date
  )`;
}
