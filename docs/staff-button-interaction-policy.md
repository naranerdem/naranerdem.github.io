# Staff Button Interaction Policy

This policy applies to authenticated staff surfaces only. Public registration
uses its own deliberately separate form treatment.

## Roles

- **Primary** is the current next action. It uses the filled blue button.
- **Secondary** is a safe alternative such as editing or `Болих`. It uses the
  outlined button.
- **Navigation** is a real link, not a button that imitates navigation.
- **Destructive confirmation** uses the red variant and names the exact action.
- **Selection controls** (time tabs, modes, and action choices) have a distinct
  selected state. They are not competing primary submissions.

Busy, success, error, and unresolved outcomes are action states. They are not
additional button roles.

## Async mutation behavior

An action marks itself busy before awaiting the request, disables only controls
that conflict with that action, and announces an action-specific Mongolian
status beside the relevant form. Labels remain readable and wrap on narrow
screens. The handler guards duplicate clicks, Enter submissions, and stale
responses as well as the visible disabled state.

Server confirmation is required before success is shown. Recoverable errors keep
entered values. A lost response after a mutation is unresolved: reuse the same
durable operation ID to reconcile it; never silently retry with a new ID.
`Saved, but refresh failed` is reported as saved, not as a failed mutation.
Closing a panel or aborting a request does not imply that a server mutation was
undone.

Existing request-token and panel-ownership rules remain authoritative: an old
response cannot update a different selected record, lesson, or panel.
