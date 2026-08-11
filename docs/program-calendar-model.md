# Program And Academic-Year Calendar Model

## Three Separate Concepts

`curriculum_program` is what a stage teaches in one academic year. It is a
versioned ordered collection of named `curriculum_lesson` rows. A lesson has no
date or class time. A new year can copy a prior program into a draft, edit it,
then publish it without rewriting a historical lesson identity.

`class_session` is the cohort a family chooses at registration: stage, habitual
weekday, start/end time, capacity, and academic year. It is not itself an
occurrence schedule.

`class_calendar` is the operational calendar for one `class_session`. Its
published revision contains explicit dated `class_calendar_slot` rows. Those
rows, not a weekly recurrence, are the source of truth for a parent schedule.

All teaching dates and times are civil `Asia/Ulaanbaatar` values. System audit
timestamps remain UTC ISO strings. Schedule code must not convert a local class
date into UTC and accidentally move it by a day.

## Planning And Publishing

An `academic_year_break` is a named planning input, with an inclusive date
range and default habitual-slot exclusion. Break rows retain their identity so
later operations can identify the last class before, and first class after, a
long break.

A calendar revision is drafted from a program and then published. Published
programs, their lessons, published revisions, slots, and overrides are
immutable. A later operational change is a new draft revision based on the
published one; publishing it supersedes the earlier revision rather than
silently rewriting history.

`class_calendar_revision_override` can exclude a habitual candidate for one
class or restore one inside a global break. `class_calendar_slot` records both
active `scheduled` slots and intentional `no_class`/`cancelled` entries, so a
missing row never has to mean a holiday, cancellation, or incomplete setup.

## Generator

The generator is a draft-planning convenience only:

1. Start at a configured local first candidate date.
2. Generate the class session's habitual weekday/time candidates.
3. Record applicable global breaks and class exclusions as explicit no-class
   rows; a class restore wins over a break.
4. Add explicit manual extra slots.
5. Sort the active slots chronologically.
6. Assign the ordered program lessons one-to-one.
7. Continue generating habitual candidates until every program lesson has an
   active slot.

Two cohorts can therefore share Stage 2 Lesson 7 while teaching it on a Sunday
and the following Tuesday. There is no shared lesson-week abstraction.

## Cancellation And Reflow

Only a manually chosen `locked_through_sequence` prefix is treated as delivered
history. The system does not infer that boundary from wall-clock time because
attendance is not implemented yet. A cancellation can only reflow lessons after
the lock.

Cancelling a future scheduled slot preserves that date as a `cancelled` entry
with the cancelled lesson number and title snapshot. It removes one active
teaching slot. Without a replacement, the generator appends new habitual
candidates at the tail and reassigns only the future lesson sequence. With a
replacement before the next habitual slot, that replacement absorbs the missed
lesson and later assignments remain unchanged where chronology permits.

The domain service returns a preview suitable for a later teacher action:
cancelled occurrence, next lesson, number of future lesson assignments changed,
and new final lesson date. No teacher editor or public mutation endpoint exists
yet.

## Public And Future Use

`GET /api/calendar/published` exposes only current published class-level
schedule details: class, local date/time, lesson number/title, status, and a
public reason label. It never exposes drafts, lesson internal notes, or family
data. Production safely returns an empty array until real configuration is
published. The unlinked `/schedule-preview/` route is a staging-facing read-only
rendering of deliberately fake fixture data.

Attendance, parent absence notices, make-up eligibility/invitations, staff
authentication/editor UI, and schedule email jobs are deferred. When schedule
communications are added, a published cancellation or material reschedule is
one meaningful event; shifted lesson mappings are not individual email events.
