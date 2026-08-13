# Editing Public Content

Most small public wording and current-year updates should not require editing `.astro` files.

Public Mongolian wording lives in `src/content/`. Current academic-year data, sample class times, and future prices live in `src/config/academic-year.ts`. Approved logical Program curricula live in `src/config/operational-defaults.mjs` and are imported explicitly; do not add dates or school breaks unless they are separately approved. Staging-only catalog fixtures live in `scripts/staging-catalog-fixtures.sql`; never add real schedules, student data, or counts there. Keep unknown future values as `null`, empty arrays, or clearly marked placeholders rather than inventing them.

| Want to change | Edit |
| --- | --- |
| Homepage headings, buttons, program text | `src/content/homepage.ts` |
| Phone, Facebook, address/location text | `src/content/contact.ts` |
| Registration labels, helper text, buttons | `src/content/registration.ts` |
| Parent/student rules text | `src/content/rules.ts` |
| Academic year status, deadline, sample class times, future prices | `src/config/academic-year.ts` |

Do not put private student/parent data in these files. Do not put secrets, API keys, bank credentials, or passwords in these files.

Registration wording should stay short and operational on phones. Required public fields use only a red `*`; optional fields have no marker or `заавал биш` annotation. Do not add a general required-fields warning before validation. Keep conditional fields disabled while hidden, and do not add helper text that merely says an editable choice may be changed later.

Transactional email templates live under `src/server/email/templates/`. Keep them concise and Mongolian. Provider keys, staging inboxes, and test-gate keys are Cloudflare Worker secrets and must never be added to content files, `.env.example`, fixtures, or browser code.

Parent and student rule version IDs live beside the rule text in `src/content/rules.ts`. A substantive published rule change must receive a new stable version ID so saved registrations continue to identify the exact rules acknowledged; do not generate versions from the current date at runtime.

Two simple GitHub editing methods:

1. Open the file on GitHub and use the edit/pencil action.
2. While viewing the repository on GitHub, press `.` to open the GitHub web editor.

Committing to `main` triggers the existing GitHub Actions deployment workflow. After the action succeeds, small manual edits publish automatically to the static GitHub Pages fallback. The primary `naranerdem.com` deployment uses Cloudflare Workers Static Assets; ordinary public content editing stays the same.
