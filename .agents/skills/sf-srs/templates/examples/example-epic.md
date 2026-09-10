# Authentication & session management

> **Business value.** Users can create an account, sign in securely, and stay signed in across short interruptions without re-entering credentials.
>
> **Scope.** Covers signup with account validation, email+password signin, and signout. Session refresh is handled internally via `UserToken{type=SESSION_REFRESH}`. Does NOT cover SSO, password reset,
> or MFA (tracked as separate Epics).

> [!NOTE] This file is the canonical reference example shipped with the `sf-srs` skill. It shows what a complete Epic page looks like for the built-in SaaSFoundryAI auth module (`User` + polymorphic
> `UserToken`, endpoints `/auth/signup` `/auth/signin` `/auth/signout`). Every DS / TC / NFR seeding pattern documented in `SKILL.md` is demonstrated here. The machine-readable source lives alongside
> as `example-epic.spec.json`. ⚠️ That spec file is a bare `EpicSpec` — a page-shape reference, **not** a valid `sf srs write --spec` payload: `--spec` takes a `DraftCandidate[]`, and an epic
> candidate's inline `frs[]` only renders the FR table on the Epic page. The FR child pages that `spawn` needs are created only by separate `kind: 'fr'` candidates — see SKILL.md, section "Single-pass
> Epic + FR writes".
>
> **The stack here is illustrative, not prescriptive.** This example happens to use NestJS + Prisma + React because that is SaaSFoundryAI's default scaffold — but the `EpicSpec` format is
> stack-neutral. The `endpoint` field on an FR accepts ANY operation boundary (`POST /auth/signin`, a `login` Tauri command, a `auth login` CLI command, an `AuthService.SignIn` gRPC method); DS items
> describe any data model (Prisma, raw SQL, a Rust struct, a protobuf message); NFR signals match capabilities, not frameworks. When drafting for a Rust/Tauri, Go, Python, or mobile project, keep this
> shape and swap the stack-specific wording — see `data/clustering-rules.json` for the agnostic mapping.
>
> **Intentionally scoped down.** The real scaffolded auth module exposes additional endpoints (`/auth/request-password-reset`, `/auth/reset-password`, `/auth/me`, `/auth/guest`) — this example focuses
> on the core signup/signin/signout loop so the five-category shape stays readable. When drafting a real Epic, enumerate every endpoint your scanner surfaces.

## Traceability

```
UR (User Requirement)
  └── FR (Functional Requirement)
        ├── DS (Design Specification)
        ├── TC (Test Case)
        └── NFR (Non-Functional Requirement)
```

Each lower-level requirement traces back to a higher-level requirement, ensuring complete coverage and compliance traceability.

## Requirement Types

| Prefix | Type                       | Description                                                           | Example                                                                                 |
| ------ | -------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| UR     | User Requirement           | High-level user need describing what the user wants to achieve.       | "The user must be able to log in to access the product"                                 |
| FR     | Functional Requirement     | What the system must do to fulfill user requirements.                 | "The system displays a generic error message on login failure"                          |
| DS     | Design Specification       | How the system implements the functional requirements.                | "JWT tokens stored in httpOnly cookies"                                                 |
| TC     | Test Case                  | Verifiable steps that prove a functional requirement is satisfied.    | "Given valid credentials, when user submits login form, then 200 OK and JWT cookie set" |
| NFR    | Non-Functional Requirement | Quality attributes: performance, security, availability, scalability. | "Login response time ≤ 1 second (p95)"                                                  |

## User Requirements (UR)

| ID          | Requirement                                                                                      | Priority | Related FR  |
| ----------- | ------------------------------------------------------------------------------------------------ | -------- | ----------- |
| UR-AUTH-001 | As a new user, I can create an account with an email and a password so I can access the product. | P1       | FR-AUTH-002 |
| UR-AUTH-002 | As a returning user, I can sign in with my email and password to resume using the product.       | P1       | FR-AUTH-001 |
| UR-AUTH-003 | As a signed-in user, I can sign out on demand so my session on a shared device is terminated.    | P2       | FR-AUTH-003 |

## Functional Requirements (FR)

| ID          | Requirement                    | Priority | Related UR  | Related DS                                         |
| ----------- | ------------------------------ | -------- | ----------- | -------------------------------------------------- |
| FR-AUTH-001 | Email + password signin        | P1       | UR-AUTH-002 | DS-AUTH-001, DS-AUTH-002, DS-AUTH-004, DS-AUTH-006 |
| FR-AUTH-002 | Signup with account validation | P1       | UR-AUTH-001 | DS-AUTH-001, DS-AUTH-002, DS-AUTH-005              |
| FR-AUTH-003 | Signout                        | P2       | UR-AUTH-003 | DS-AUTH-002, DS-AUTH-004                           |

## Design Specifications (DS)

| ID               | Specification                    | Related FR                            |
| ---------------- | -------------------------------- | ------------------------------------- |
| **Data model**   |                                  |                                       |
| DS-AUTH-001      | Data model — User                | FR-AUTH-001, FR-AUTH-002              |
| DS-AUTH-002      | Data model — UserToken           | FR-AUTH-001, FR-AUTH-002, FR-AUTH-003 |
| **API contract** |                                  |                                       |
| DS-AUTH-004      | API contract — POST /auth/signin | FR-AUTH-001, FR-AUTH-003              |
| DS-AUTH-005      | API contract — POST /auth/signup | FR-AUTH-002                           |
| **UI form**      |                                  |                                       |
| DS-AUTH-006      | UI form — SignInPage             | FR-AUTH-001                           |

## Test Cases (TC)

| ID          | Title                                                                         | Expected Result                                                                          | Related FR  |
| ----------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------- |
| TC-AUTH-001 | should sign in user successfully                                              | 200 with access + refresh tokens and User.lastLoginAt updated                            | FR-AUTH-001 |
| TC-AUTH-002 | should throw UnauthorizedException if credentials are invalid                 | 401 with generic message (same shape for unknown email and wrong password)               | FR-AUTH-001 |
| TC-AUTH-003 | should create a new user successfully                                         | User row with isActive=false + UserToken{type=ACCOUNT_VALIDATION}                        | FR-AUTH-002 |
| TC-AUTH-004 | should handle existing user gracefully                                        | Duplicate-email signup returns a generic response (no user-enumeration leak)             | FR-AUTH-002 |
| TC-AUTH-005 | should create account when signing in with confirmation token                 | Consuming the token flips User.isActive=true and allows subsequent signin                | FR-AUTH-002 |
| TC-AUTH-006 | should sign out user successfully                                             | SESSION_REFRESH UserToken for the caller is revoked                                      | FR-AUTH-003 |
| TC-AUTH-007 | **TODO** — POST /auth/signup triggers email dispatch with the validation link | to write — seeded because the email dispatch path is not covered by auth.service.spec.ts | FR-AUTH-002 |

## Non-Functional Requirements (NFR)

| ID                 | Requirement                              | Target                                                                                                            | Priority | Related FR               |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------- | ------------------------ |
| **Security**       |                                          |                                                                                                                   |          |                          |
| NFR-AUTH-001       | JWT access token expiry ≤ 15 minutes     | accessToken.exp − iat ≤ 900s                                                                                      | P1       | FR-AUTH-001              |
| NFR-AUTH-002       | Refresh token rotation on every use      | SESSION_REFRESH UserToken rotated on each refresh; old token invalidated before the new one is issued             | P1       | FR-AUTH-001, FR-AUTH-003 |
| NFR-AUTH-003       | Auth endpoints rate-limited per IP       | ≤ 5 failed signin attempts per IP per 60s — proposed, needs human validation                                      | P3       | FR-AUTH-001              |
| **i18n**           |                                          |                                                                                                                   |          |                          |
| NFR-AUTH-004       | Auth error messages translated (FR + EN) | All user-facing strings resolve through i18next in FR and EN — proposed, needs human validation                   | P3       | FR-AUTH-001, FR-AUTH-002 |
| **Data lifecycle** |                                          |                                                                                                                   |          |                          |
| NFR-AUTH-005       | User deactivation flow via isActive flag | Admin can flip User.isActive=false to lock an account without deleting the row — proposed, needs human validation | P3       | FR-AUTH-001              |
| **Performance**    |                                          |                                                                                                                   |          |                          |
| NFR-AUTH-006       | Signin p95 latency ≤ 1 second            | POST /auth/signin p95 ≤ 1s under expected concurrency — proposed, needs human validation                          | P3       | FR-AUTH-001              |
