CREATE TABLE public_site_font_setting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  font TEXT NOT NULL CHECK (font IN ('sans', 'serif')),
  updated_at TEXT NOT NULL
);

INSERT INTO public_site_font_setting (singleton, font, updated_at)
VALUES (1, 'sans', CURRENT_TIMESTAMP);
