-- Public request protection extends the existing bounded policy row. Defaults
-- preserve the currently released behavior until an administrator opts in.
ALTER TABLE usage_protection_policy ADD COLUMN public_protection_preset TEXT
  NOT NULL CHECK (public_protection_preset IN ('normal', 'heightened')) DEFAULT 'normal';
ALTER TABLE usage_protection_policy ADD COLUMN pause_public_registrations INTEGER
  NOT NULL CHECK (pause_public_registrations IN (0, 1)) DEFAULT 0;
ALTER TABLE usage_protection_policy ADD COLUMN pause_public_messages INTEGER
  NOT NULL CHECK (pause_public_messages IN (0, 1)) DEFAULT 0;
