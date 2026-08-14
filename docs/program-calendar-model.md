# Program, Offering, Class, And Calendar Model

## Durable Hierarchy

The operational hierarchy is:

```text
Program family -> CurriculumProgram revision -> ActivityOffering -> ClassSession -> ClassCalendar
```

`curriculum_program_family` is the stable logical Program identity a teacher
recognizes. Its current published `curriculum_program` pointer selects one
immutable revision; older revisions remain history with the Offerings that use
them. A revision is the ordered collection of named `curriculum_lesson` rows.
An event may have no program at all.

`activity_offering` is one concrete run offered by the center. Its typed kind is
`annual_course`, `summer_course`, or `event`. It owns the run's period, optional
year/stage compatibility context, selected published program, `free`/`paid`
charge mode, calendar guidance, and optional Facebook group URL.
`activity_offering.facebook_group_url` is the sole operational communication
authority: it is optional at creation, can be changed later in Offering details,
and is shared by every class in that Offering. Legacy class/stage values are
compatibility/history only.

`class_session` remains the concrete registration cohort/time option within a
course Offering. Existing annual stage/year and weekday/time columns remain for
registration compatibility. New staff and calendar code treats
`activity_offering_id` and the one-to-one `class_meeting_rule` as authoritative.

`class_calendar` is the operational calendar for one course class. A published
revision contains explicit dated `class_calendar_slot` rows. Those rows, not a
recurrence rule, are the source of truth after publication.

A programless event does not invent a curriculum lesson or class calendar.
`offering_event_occurrence` stores its one date, time, capacity, registration
state, and lifecycle directly.

All teaching dates and times are civil `Asia/Ulaanbaatar` values. System audit
timestamps remain UTC ISO strings. Schedule code must not convert a local class
date into UTC and accidentally move it by a day.

## Offering Kinds

An annual course teacher form contains only `Шат`, an editable prepopulated
start date, and an optional Facebook group URL. The start date defaults from
the admin-only typed `annual_course_start_default` month/day rule (initially
October 1), while the server resolves the logical annual Program family's
current published revision and derives the Offering's academic-year context
from the selected date. Raw revision IDs and year selectors are never normal
browser choices. The annual families are exactly `1-р шат`, `2-р шат`, and
`3-р шат`; there is no Stage 4. Annual courses are always paid and apply
school-calendar guidance automatically. Their actual final lesson date is
derived from the explicit class calendar, not entered as an Offering end date.

A summer course has a human title, planned period, and existing published summer
Program from the dedicated `Хөтөлбөр` tool. It is always paid and does not apply
school-calendar periods by default. Its internal academic-year/stage
compatibility context is never a redundant teacher choice.

An event has a human title and a narrow occurrence record. It defaults to free,
starts with registration closed, and does not require a program. The teacher
may choose paid for an event, but this creates no price or payment obligation.
The Offering is the sole charge authority; its occurrence owns only date, time,
capacity, and registration state. An unused closed event may be hard-deleted.

New course classes and event occurrences always start with registration closed.

## Meeting Rules

`class_meeting_rule` supports three deliberately small recurrence kinds:

- `weekly`: one named weekday, normally used by annual courses
- `weekdays`: Monday through Friday
- `daily`: every local calendar date

It also stores first date, an optional compatibility planned end date, and
authoritative local start/end time. Normal teacher setup does not ask for a
class end date: the summer Offering's planned end is its soft planning
guardrail, while an annual course ends when its explicit calendar ends. New
summer classes default to `daily`, including Saturday and Sunday; `weekdays`
remains available. Legacy `class_session` weekday/time values are mirrored only for
existing registration and catalog compatibility. The service generates human
labels such as `1-р шат · Бямба 10:00–11:20` and
`6/1–6/16 · 10:00–11:30`; teachers do not type class names or see duplicate
labels when two classes share a start time.

## Planning And Publishing

Planning has three deliberately separate inputs. An `academic_year_break` is a
named inclusive school-calendar period for annual courses. It has two
independent flags: `exclude_from_generation` skips habitual candidates in an
initial draft, while `warn_on_overlap` marks any final teaching slot inside the
period for teacher review. School-calendar periods do not automatically apply
to summer courses or events. The older `generation_behavior` enum is retained
only as compatibility/history data and is no longer authoritative.

An `activity_offering_break` is a course-specific inclusive period, such as a
summer break on June 8-9. It excludes each class in that Offering without
duplicating a date decision into every class. A class can still exclude another
date, restore one otherwise skipped school date, or add an explicit extra
occurrence. An Offering break remains an Offering-level rule and cannot be
overridden by a class restore.

The teacher reaches this rare all-class control from the Schedule screen under
`Тусгай өөрчлөлт`. A one-class change remains with that class's schedule, while
school-calendar periods remain in Holidays.

The checked-in 2026–2027 operational template is based on Ministry of
Education Order A/211 (2026-07-08), Annex 1, the Ulaanbaatar VI–IX row. It
imports six inclusive periods with both initial exclusion and overlap warnings:
autumn break,
winter break beginning on December 26, the Tsagaan Sar self-study period,
spring break, Republic Day on November 26, and International Women's Day on
March 8. The school self-study and break labels have the same initial planning
effect for the center. There is deliberately no generic summer-vacation period
or guessed lunar holiday. A teacher can restore any skipped date for one class;
the named warning remains visible.

Templates are imported explicitly into D1 and recorded with stable markers.
They never run during deployment, never overwrite an imported period later
edited by a teacher, and never retroactively alter an already generated or
published calendar. Changing exclusion guides only future generation; changing
the warning flag changes current warning presentation without rewriting any
calendar slots. The template is provenance and initialization input; D1 is the
operational authority after import.

School-calendar setup is annual planning. A planned one-class exception stays
on that class's Schedule. A future weather, illness, or building cancellation
will be entered from a daily teacher attention surface, but it will reuse the
same safe structural calendar-change service and immutable history rather than
introducing a second cancellation meaning.

A calendar revision is drafted from the class's Offering-pinned program and meeting
rule, then finalized internally. The caller cannot substitute another program
or start date during generation. Published programs, lessons, calendar
revisions, slots, and overrides remain immutable. A later operational change
uses a new draft revision based on the published one and finalizing it
supersedes the earlier revision rather than rewriting it. Teacher UI calls this
ordinary `Хадгалах`: it never presents a revision number, a start-draft step,
or publish terminology.

Program and calendar editing are durable working batches. Small edits update the
working revision immediately so a reload or accidental navigation can resume the
same work. `Хадгалах` is the single final action: it advances the appropriate
current pointer or published calendar only when the batch materially differs
from its base. A page-level `Болих` first asks before discarding the entire
working batch; an inline `Болих` only closes the unfinished inline form. This
prevents both accidental loss and duplicate no-op revisions.

Existing Offerings and calendars never move when a newer Program revision is
published. They remain valid with their pinned historical revision, including
when a first explicit calendar is generated later. A direct calendar-change
revision may continue the same historical program, but can never substitute an
arbitrary one.

`class_calendar_slot` records `scheduled`, `no_class`, and `cancelled` entries,
so a missing row never has to mean a holiday, cancellation, or incomplete
setup.

## Generator

The recurrence rule is a draft-planning convenience only:

1. Read the class's Offering, associated published program, and meeting rule.
2. Generate weekly, weekday, or daily local candidates from the rule.
3. Apply course-specific Offering breaks and applicable school-calendar
   guidance for annual courses.
4. Apply class exclusions/restores and explicit extra slots.
5. Sort active slots chronologically.
6. Assign ordered program lessons one-to-one.
7. Continue habitual candidates until all lessons fit.

The summer Offering's advertised/planned end date is planning guidance, not a
silent lesson-dropping limit. When lessons extend past it, the draft remains
complete and shows a concise overrun warning. The teacher can then accept the
plan, adjust the summer period or recurrence, add a break or extra slot, or
revise an unpublished program. Annual courses have no comparable entered end
date. The low-level generator still supports an explicit hard technical bound
where a caller truly needs one; normal staff setup does not use it for an
advertised course end date.

Two cohorts can share one curriculum lesson while teaching it on different
dates. There is no shared lesson-week abstraction.

## Cancellation And Historical Protection

Ordinary post-publication changes automatically protect at least the greater of:

- the revision's existing internal `locked_through_sequence`
- the highest lesson sequence on a published teaching date already in the past

This does not claim a past lesson was attended or delivered. It only prevents
normal future schedule edits from rewriting published history until attendance
provides a stronger operational source. The teacher UI does not expose a
completed-lesson number, raw sequence lock, or confirmation checkbox.

The active teaching sequence is always chronological. Ordered Program lessons
pair one-to-one with those active slots; teachers do not assign a lesson number
to a date. Cancelling a safe future scheduled slot retains the original date as
a `cancelled` entry with the lesson number/title snapshot, removes it from the
active sequence, and reflows later lessons. Adding an extra slot inserts it
into the same ordered sequence. A restored school-holiday slot is active again
but keeps its named holiday warning. Past corrections, if later required,
belong to an exceptional audited admin workflow rather than the normal teacher
surface.

## Staff Setup Surface

The protected Mongolian setup is organized around concrete work:

- `/staff/offerings/` (`Сургалт, арга хэмжээ`) creates and edits annual courses,
  summer courses, and events.
- `/staff/programs/` opens as a neutral annual/summer Program list. `Нээх`
  explicitly selects a Program and shows its detail below both lists; `Хаах`
  returns to the list-only view. `Засах` opens existing work or copies the current content
  internally; `Хадгалах` atomically advances the family pointer and rejects
  stale work. Teachers edit titles inline and insert-before, append, delete,
  or move lessons without sequence numbers. Only unreferenced summer drafts
  can be deleted.
- `/staff/schedule/` opens as a compact overview of available classes and
  calendar spans. `Нээх` explicitly selects one class and shows its compact
  chronological calendar, summary, and concise warnings below that overview.
  A future lesson's `⋯` menu can make it no-class; a restorable school/class
  skip can make that date teaching again. There is no ordinary arbitrary
  date/time reassignment. The internal change draft is created or resumed
  automatically, while `Хадгалах` preserves immutable-revision semantics
  without exposing them. Extra lessons and offering-wide `Тусгай өөрчлөлт`
  remain secondary controls; the latter clearly affects every class in the
  Offering.
- `/staff/holidays/` records annual school-calendar periods with either an
  initial exclusion or a warning-only behavior, and lists only real dated
  school years rather than internal compatibility records.
- `/staff/settings/` stores genuinely global typed settings: the admin-only
  annual-start month/day default and separate admin authentication settings.

Unused classes expose `Анги устгах` only in their edit/details view. Durable
references suppress the action and server checks remain authoritative. Every
meaningful Offering, program, class/rule, publication, and future-cancellation
operation is audited. Accountants have no mutation access.

Migration 0009's `academic_year_stage_setting` remains compatibility/history.
Migration 0010 copies its existing annual Facebook URLs into the corresponding
annual Offerings where safe. New behavior reads and writes only the Offering
value, so there is no dual authority. Migration 0011 preserves direct
change-revision continuity for pre-Offering published calendars without
weakening current-program inheritance for new calendars. Migration 0012 adds
Program kind, Offering-specific breaks, school-calendar generation behavior,
and stable operational-default import markers. It also makes the paid-course and
annual school-guidance rules database-enforced rather than merely UI defaults.
Migration 0013 adds logical Program families, groups old revisions beneath the
right annual stage or separate summer identity, and keeps concrete Offering and
calendar rows pinned to their historical revision.
Migration 0014 adds only the typed singleton annual start-date default; it is
not a generic settings registry and does not alter existing Offerings.

## Public And Future Use

The current public registration/catalog remains annual and stage/class based.
Existing `class_session` IDs, capacity rules, holds, and FIFO waitlists remain
valid. This change does not expose summer/event registration.

Future course registration should target `ActivityOffering + ClassSession`;
future event registration should target `ActivityOffering +
OfferingEventOccurrence`. Both can share guardian/student identity, verified
email, capacity, and an appropriate FIFO waitlist. Courses are always paid and
will require common future pricing/payment machinery. A free event can
eventually confirm after email verification and capacity confirmation without a
payment-only 24-hour hold.

A paid Offering may be created, scheduled, and kept registration-closed before
pricing exists. Future fee configuration belongs in Offering detail under
`Төлбөрийн нөхцөл`, not in compact Offering creation. Public registration must
not open for a paid Offering until valid pricing basis and required payment-plan
terms exist.

`GET /api/calendar/published` continues to expose only published course
schedule details and no family data. Production may safely return no rows until
real configuration is created. Staging fixtures are explicitly fake and cover
annual plus summer weekday/daily calendar behavior. Events are exercised in
isolated service tests rather than appearing as a routine staging list item.

Attendance, parent absence notices, make-up eligibility, full finance,
generalized public registration, schedule email jobs, and Facebook API
integration remain deferred.
