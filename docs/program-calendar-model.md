# Program, Offering, Class, And Calendar Model

## Durable Hierarchy

The operational hierarchy is:

```text
CurriculumProgram -> ActivityOffering -> ClassSession -> ClassCalendar
```

`curriculum_program` is what is taught: a versioned ordered collection of named
`curriculum_lesson` rows. Lesson count is data. An annual example may have about
30 lessons and a summer example may have 10-15, but neither count is a rule.
An event may have no program at all.

`activity_offering` is one concrete run offered by the center. Its typed kind is
`annual_course`, `summer_course`, or `event`. It owns the run's period, optional
year/stage compatibility context, selected published program, `free`/`paid`
charge mode, calendar guidance, and optional Facebook group URL.

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

An annual course selects a compatible published annual Program. That Program
derives the teacher-visible stage and academic year; persisted year/stage remain
compatibility/history context. Annual courses are always paid and apply
school-calendar guidance automatically. Multiple weekly classes may share that
one Offering and therefore inherit the same program and Facebook group.

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

It also stores first date, optional planned end date, and authoritative local
start/end time. New summer classes default to `daily`, including Saturday and
Sunday; `weekdays` remains available. Legacy `class_session` weekday/time values are mirrored only for
existing registration and catalog compatibility. The service generates human
labels such as `1-р шат · Бямба 10:00–11:20` and
`6/1–6/16 · 10:00–11:30`; teachers do not type class names or see duplicate
labels when two classes share a start time.

## Planning And Publishing

Planning has three deliberately separate inputs. An `academic_year_break` is a
named inclusive school-calendar period for annual courses. Its generation
behavior is either `exclude_by_default`, which skips habitual candidates in an
initial draft, or `warn_only`, which leaves them in place and marks the overlap
for teacher review. School-calendar periods do not automatically apply to
summer courses or events.

An `activity_offering_break` is a course-specific inclusive period, such as a
summer break on June 8-9. It excludes each class in that Offering without
duplicating a date decision into every class. A class can still exclude another
date, restore one otherwise skipped school date, or add an explicit extra
occurrence. An Offering break remains an Offering-level rule and cannot be
overridden by a class restore.

A calendar revision is drafted from the class's Offering program and meeting
rule, then published. The caller cannot substitute another program or start
date during generation. Published programs, lessons, calendar revisions, slots,
and overrides remain immutable. A later operational change uses a new draft
revision based on the published one and publishing supersedes the earlier
revision rather than rewriting it.

One migration-only compatibility exception preserves calendars that were
published before Offerings existed: a direct change revision may continue the
same historical program even if a later program revision had already become
current. It cannot choose any other program. New setup blocks program changes
after a class calendar exists, so ordinary Offering behavior remains one
inherited current program.

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

The meeting rule's end date and an Offering's advertised/planned period are
planning guidance, not a silent lesson-dropping limit. When lessons extend past
that date, the draft remains complete and shows a concise overrun warning. The
teacher can then accept the plan, adjust the period or recurrence, add a break
or extra slot, or revise an unpublished program. The low-level generator still
supports an explicit hard technical bound where a caller truly needs one; the
normal staff setup does not use it for an advertised course end date.

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

Cancelling a safe future scheduled slot retains the original date as a
`cancelled` entry with the lesson number/title snapshot. Later lessons reflow
chronologically and may produce a planned-period overrun warning. Past
corrections, if later required, belong to an exceptional audited admin workflow
rather than the normal teacher surface.

## Staff Setup Surface

The protected Mongolian setup is organized around concrete work:

- `/staff/offerings/` (`Сургалт, арга хэмжээ`) creates and edits annual courses,
  summer courses, and events.
- `/staff/programs/` is the only place to create, copy, edit, and publish
  annual or summer Programs.
- `/staff/schedule/` chooses an Offering, manages its classes or event
  occurrence, and generates course calendars without asking for Program again.
- `/staff/holidays/` records annual school-calendar periods with either an
  initial exclusion or a warning-only behavior.
- `/staff/settings/` stores typed operational settings, currently the
  Offering-level Facebook group URL plus separate admin authentication settings.

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

`GET /api/calendar/published` continues to expose only published course
schedule details and no family data. Production may safely return no rows until
real configuration is created. Staging fixtures are explicitly fake and cover
annual plus summer weekday/daily calendar behavior. Events are exercised in
isolated service tests rather than appearing as a routine staging list item.

Attendance, parent absence notices, make-up eligibility, full finance,
generalized public registration, schedule email jobs, and Facebook API
integration remain deferred.
