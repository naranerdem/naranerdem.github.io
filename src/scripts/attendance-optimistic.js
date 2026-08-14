function snapshot(entry, next) {
  return Object.fromEntries(Object.keys(next).map((key) => [key, entry[key]]));
}

export function markedRosterCount(roster) {
  return roster.filter((entry) => entry.attendanceStatus !== null && entry.attendanceStatus !== "").length;
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
