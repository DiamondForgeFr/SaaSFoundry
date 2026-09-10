<!--
Why this example
================
Shows:
- Behavior observed = FACTS only (what actually happens). No hypothesis, no diagnosis.
- Expected Behavior = what should happen, with the contract it violates.
- Steps to Reproduce = deterministic, numbered, copy-pasteable.
- Environment = versions, browsers, OS that matter for this bug.
- Impact / Severity = concrete user/business effect; severity explicit.
- Evidence = screenshots, logs, request IDs, code pointers — things reviewers can click or grep.

Avoid:
- Mixing diagnosis into "Behavior observed" (save it for a comment).
- Vague "doesn't work" — every bug has a precise input + a precise wrong output.
- Missing severity — unassigned means triage will be wrong.

Title convention:
  [BUG] <English> — <French>
  e.g. [BUG] Register form swallows E_EMAIL_TAKEN — Le formulaire d'inscription masque E_EMAIL_TAKEN

Domain chosen: a front-end bug in the generated app — archetypal "handler ignores response code".
Content is fictional — import the pattern, not the facts.
-->

## Behavior observed

When a registered user submits the `/register` form with an email that already exists, the backend responds `409 Conflict` with `{ code: "E_EMAIL_TAKEN" }` — but the React form shows a generic
`"Something went wrong, please retry"` banner. The specific code is never rendered, no `email` field error appears under the input, and the password field is cleared.

## Expected Behavior

Per the API contract (`docs/api-errors.md`) and the design of `RegisterForm`, a `409 / E_EMAIL_TAKEN` response must:

1. Surface an inline error _on the email field_: "This email is already registered — sign in instead?" with a link to `/login`.
2. NOT trigger the generic banner.
3. Keep the password field value intact so the user doesn't have to re-type.

## Steps to Reproduce / Trigger Conditions

1. Register normally with `user@example.com` / `P@ssw0rd!` — succeeds.
2. Log out.
3. Navigate to `/register`.
4. Submit the same email `user@example.com` with any password.
5. Observe: generic banner appears at the top; email field has no error; password field is cleared.

## Environment / Configuration

- Affected: `web/` frontend, `RegisterForm.tsx`
- Versions: `saasfoundryai-cli 1.0.0-beta`, generated project uses `react 19.0.0`, `react-hook-form 7.56.0`
- Browsers: reproduced on Chrome 133, Firefox 138, Safari 18 — not browser-specific
- API: NestJS backend, `409 / E_EMAIL_TAKEN` confirmed correct via `curl`

## Impact / Severity

**Severity: medium**

- Returning users can't tell why they can't register — 18% bounce rate on duplicate-email attempts (Amplitude funnel, last 30 days).
- Support tickets tagged `signup-confused` up 40% since the 1.0.0-beta cut.
- No data integrity or security risk — purely UX.

## Evidence / Data

- Request ID: `req_7f3a91c2` (Sentry: [event 445812](https://sentry.io/fake/445812))
- Screenshot comparing the generic banner vs. expected inline error: [attachment](https://img.example.com/issue-evidence.png)
- Network tab capture confirming backend response: `{"statusCode": 409, "code": "E_EMAIL_TAKEN", "message": "Email already in use"}`
- Relevant code: `src/components/auth/RegisterForm.tsx:87` — the `onError` handler only checks `err.response.status` and ignores `err.response.data.code`.
