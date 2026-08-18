-- Presentation-only teacher dashboard preferences. These never grant or remove capabilities.
CREATE TABLE teacher_dashboard_preferences (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  show_setup_section INTEGER NOT NULL DEFAULT 1 CHECK (show_setup_section IN (0, 1)),
  show_registration INTEGER NOT NULL DEFAULT 1 CHECK (show_registration IN (0, 1)),
  show_information INTEGER NOT NULL DEFAULT 1 CHECK (show_information IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO teacher_dashboard_preferences (
  singleton, show_setup_section, show_registration, show_information, updated_at
) VALUES (1, 1, 1, 1, '2026-08-17T00:00:00.000Z');
