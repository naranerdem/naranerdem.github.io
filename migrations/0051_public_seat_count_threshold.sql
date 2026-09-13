-- NULL preserves the legacy public presentation: show every available count.
-- Zero has an intentional, different meaning: never show a numeric count.
CREATE TABLE public_seat_count_threshold_setting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  remaining_seat_threshold INTEGER CHECK (remaining_seat_threshold IS NULL OR remaining_seat_threshold BETWEEN 0 AND 1000),
  updated_at TEXT NOT NULL
);

INSERT INTO public_seat_count_threshold_setting (singleton, remaining_seat_threshold, updated_at)
VALUES (1, NULL, '2026-09-13T00:00:00.000Z');
