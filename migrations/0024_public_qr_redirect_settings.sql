-- Two stable public QR destinations. This is intentionally a narrow typed setting,
-- not a generic configuration store. No row is required: checked-in defaults remain
-- available until an administrator saves an override.

CREATE TABLE public_qr_redirect_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  n_destination_url TEXT NOT NULL,
  t_destination_url TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
