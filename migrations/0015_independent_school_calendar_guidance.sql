-- School-calendar generation and overlap warnings are separate planning rules.
-- generation_behavior remains as a compatibility record for earlier revisions.

ALTER TABLE academic_year_break
  ADD COLUMN exclude_from_generation INTEGER NOT NULL DEFAULT 1
    CHECK (exclude_from_generation IN (0, 1));

ALTER TABLE academic_year_break
  ADD COLUMN warn_on_overlap INTEGER NOT NULL DEFAULT 1
    CHECK (warn_on_overlap IN (0, 1));

UPDATE academic_year_break
SET
  exclude_from_generation = CASE generation_behavior
    WHEN 'exclude_by_default' THEN 1
    WHEN 'warn_only' THEN 0
    ELSE excludes_habitual_slots
  END,
  warn_on_overlap = 1;

-- A previously interrupted defaults import could supersede a family's current
-- revision without moving its pointer. Restore that invariant without changing
-- the family's selected content or lesson history.
UPDATE curriculum_program
SET status = 'superseded'
WHERE status = 'published'
  AND EXISTS (
    SELECT 1
    FROM curriculum_program_family AS family
    INNER JOIN curriculum_program AS current_program
      ON current_program.id = family.current_published_program_id
    WHERE family.id = curriculum_program.program_family_id
      AND current_program.status = 'superseded'
      AND current_program.id != curriculum_program.id
  );

UPDATE curriculum_program
SET status = 'published'
WHERE status = 'superseded'
  AND id IN (
    SELECT current_published_program_id
    FROM curriculum_program_family
  );
