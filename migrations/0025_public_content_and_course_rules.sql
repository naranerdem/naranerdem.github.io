-- Narrow public-information ownership: stable Program-family descriptions,
-- one center-information singleton, and two immutable ordinary-course rules.

ALTER TABLE curriculum_program_family ADD COLUMN recommended_grade_min TEXT;
ALTER TABLE curriculum_program_family ADD COLUMN recommended_grade_max TEXT;
ALTER TABLE curriculum_program_family ADD COLUMN public_short_description TEXT;
ALTER TABLE curriculum_program_family ADD COLUMN public_long_description TEXT;

CREATE TABLE public_center_information (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  phone TEXT,
  public_email TEXT,
  facebook_page_url TEXT,
  physical_address TEXT,
  homepage_intro TEXT,
  about_center_text TEXT,
  teacher_bio TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO public_center_information (
  singleton, phone, public_email, facebook_page_url, physical_address,
  homepage_intro, about_center_text, teacher_bio, updated_at
) VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-08-17T00:00:00.000Z');

CREATE TABLE course_rule_document (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code IN ('guardian', 'student')),
  title TEXT NOT NULL,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE course_rule_version (
  id TEXT PRIMARY KEY,
  course_rule_document_id TEXT NOT NULL REFERENCES course_rule_document(id) ON DELETE RESTRICT,
  body_text TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (course_rule_document_id, body_hash)
);

CREATE INDEX idx_course_rule_version_document ON course_rule_version(course_rule_document_id, created_at DESC);

CREATE TRIGGER prevent_course_rule_version_update
BEFORE UPDATE ON course_rule_version
BEGIN SELECT RAISE(ABORT, 'course rule versions are immutable'); END;
CREATE TRIGGER prevent_course_rule_version_delete
BEFORE DELETE ON course_rule_version
BEGIN SELECT RAISE(ABORT, 'course rule versions are immutable'); END;
CREATE TRIGGER validate_course_rule_document_current_version
BEFORE UPDATE OF current_version_id ON course_rule_document
WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM course_rule_version WHERE id = NEW.current_version_id AND course_rule_document_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'course rule current version must belong to document'); END;

INSERT INTO course_rule_document (id, code, title, current_version_id, created_at, updated_at) VALUES
  ('course-rule-guardian', 'guardian', 'Эцэг эхийн журам', NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
  ('course-rule-student', 'student', 'Сурагчийн журам', NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');

-- These preserve the existing checked-in registration-rule identities.
INSERT INTO course_rule_version (id, course_rule_document_id, body_text, body_hash, created_at)
SELECT 'parent-rules-v1', 'course-rule-guardian',
  'Хөтөлбөрийн зорилго, хүрээг ойлгож, хичээлийн жилийн турш тогтмол хамрагдахад анхаарна.' || char(10) || char(10) || 'Төлбөр, хуваарь, амралтын өдрүүд, цагийн өөрчлөлтийн мэдээллийг цаг тухайд нь шалгана.' || char(10) || char(10) || 'Ангийн мэдээлэл, зарлал, харилцааг Facebook групп зэрэг албан сувгаар тогтмол хянана.',
  '0512754a3bc1a68069bda5c02ed0dc5f23ad2934a1c935be818c28442e16041b', '2026-08-17T00:00:00.000Z'
UNION ALL SELECT 'student-rules-v1', 'course-rule-student',
  'Хүүхэд хичээлд идэвхтэй, дуртай оролцож, багшийн зааврыг дагана.' || char(10) || char(10) || 'Туршилтын аюулгүй байдлыг мөрдөж, бусадтай хүндэтгэлтэй харилцана.' || char(10) || char(10) || 'Тэмдэглэл хөтөлж, багаар хийх туршилтад бусад хүүхдэд оролцох боломж олгоно.' || char(10) || char(10) || 'Цаг баримталж, хэрэглэсэн хэрэгсэл, материалыг цэвэрлэж буцаана.',
  '3181c1149bb58e046519ef7e67d3699a64af80dd7e1ace3a29d0eddf7174b0eb', '2026-08-17T00:00:00.000Z';

UPDATE course_rule_document
SET current_version_id = CASE code WHEN 'guardian' THEN 'parent-rules-v1' ELSE 'student-rules-v1' END;
