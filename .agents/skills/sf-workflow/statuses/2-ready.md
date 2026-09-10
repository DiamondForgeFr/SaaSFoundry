---
status: Ready
banner_ai: Nothing — Ready is a waiting queue
banner_human: Assign the ticket or confirm pickup to start development
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - Specs validated in Backlog
  - Priority assigned
  - All blockers resolved
mandatory_actions:
  - Wait for explicit ticket assignment or confirmation
  - Do nothing else — this status is a waiting queue
exit_conditions:
  - Developer asks you to work on this ticket
  - OR you receive confirmation to take it
next_status: In Progress
---

# STATUS: Ready

Queue of validated tickets waiting for pickup.

## Action checklist

- [ ] Wait for the developer to assign the ticket (or ask which one to take, respecting priority order)
- [ ] Otherwise, do nothing — Ready is strictly a waiting queue

## Errors to avoid

- Taking a Ready ticket without confirmation
- Skipping higher-priority tickets
