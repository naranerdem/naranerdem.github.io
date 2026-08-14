function snapshot(entry, next) {
  return Object.fromEntries(Object.keys(next).map((key) => [key, entry[key]]));
}

export function effectiveAttendanceStatus(recordedStatus, occurrenceEnded) {
  if (recordedStatus === "present" || recordedStatus === "late" || recordedStatus === "absent") return recordedStatus;
  return occurrenceEnded ? "absent" : null;
}

export function attendanceCheckboxState(recordedStatus) {
  return {
    present: recordedStatus === "present" || recordedStatus === "late",
    late: recordedStatus === "late",
  };
}

export function attendanceStatusAfterToggle(recordedStatus, control, checked) {
  if (control === "late") return checked ? "late" : (recordedStatus === "late" ? "present" : recordedStatus);
  if (control === "present") return checked ? "present" : null;
  return recordedStatus;
}

export function markedRosterCount(roster) {
  return roster.filter((entry) => entry.recordedAttendanceStatus !== null && entry.recordedAttendanceStatus !== "").length;
}

export function attendanceProgressCount(roster, occurrenceEnded) {
  return occurrenceEnded ? roster.length : markedRosterCount(roster);
}

export function createOptimisticRosterMutator({ onChange, onError }) {
  const pendingEnrollmentIds = new Set();

  return {
    isPending(enrollmentId) {
      return pendingEnrollmentIds.has(enrollmentId);
    },

    async mutate(entry, next, request) {
      if (pendingEnrollmentIds.has(entry.enrollmentId)) return false;

      const previous = snapshot(entry, next);
      pendingEnrollmentIds.add(entry.enrollmentId);
      Object.assign(entry, next);
      onChange(entry);

      try {
        await request();
        return true;
      } catch (error) {
        Object.assign(entry, previous);
        onError(entry, error);
        return false;
      } finally {
        pendingEnrollmentIds.delete(entry.enrollmentId);
        onChange(entry);
      }
    },
  };
}
