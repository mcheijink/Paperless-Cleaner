# Paperless Cleaner — Specification

> Working document. Edit freely before implementation begins.

---

## 1. Purpose

Paperless Cleaner is a self-hosted web application that sits alongside a Paperless-NGX instance and helps users improve the metadata quality of their document library — titles, tags, correspondents, and document types — through sorting, scoring, and bulk suggestion workflows.

---

## 2. Architecture overview

```
Browser  ←→  FastAPI (port 8080)  ←→  Paperless-NGX API
                                  ←→  Ollama API (optional)
```

- **Backend**: Python / FastAPI. Stateless except for `app/settings.json`.
- **Frontend**: Vanilla HTML/CSS/JavaScript. Two pages: main (`/`) and settings (`/settings`).
- **No database**. All document data is fetched live from Paperless-NGX.
- **Docker Compose** for deployment. Single service, port 8080.

---

## 3. Data models

### 3.1 Settings

Persisted in `app/settings.json`. Seeded from environment variables on first run if the file is absent.

| Field | Type | Default | Env var |
|---|---|---|---|
| `paperless_base_url` | string | `http://paperless-ngx:8000` | `PAPERLESS_BASE_URL` |
| `paperless_token` | string | `""` | `PAPERLESS_TOKEN` |
| `ollama_base_url` | string | `http://ollama:11434` | `OLLAMA_BASE_URL` |
| `ollama_model` | string | `llama3.1` | `OLLAMA_MODEL` |
| `suggestion_provider` | `"ollama"` \| `"heuristic"` | `"ollama"` | `SUGGESTION_PROVIDER` |

### 3.2 Entry (document as seen by the UI)

```
id                      int
title                   string
correspondent           string | null   — resolved name (not ID); displayed as "—" if null
document_type           string | null   — resolved name (not ID); displayed as "—" if null
date                    string | null   — ISO date (created date from Paperless)
tags                    string[]        — resolved tag names (not IDs)
heuristic_quality       int             — 0–100, see §5 tier 1
llm_quality             int | null      — 0–100, see §5 tier 2; null until LLM has been run
metadata_completeness   int             — 0–100, see §5 tier 3
suggestion_status       string          — "none" | "pending" | "ready" | "done"
metadata_reviewed       string | null   — ISO date when metadata was last changed by this tool; null if never touched
```

**`suggestion_status` values:**
- `"none"` — no suggestion has been requested for this document
- `"pending"` — document is queued or currently being processed by Ollama
- `"ready"` — suggestion generated; at least one suggested field is still undecided (neither applied nor rejected)
- `"done"` — all suggested fields have been resolved (applied or rejected); no further attention needed

Status transitions to `"done"` automatically when the last undecided field is either applied or rejected. It does not distinguish between "everything applied" and "everything rejected" — both mean the document is fully reviewed.

### 3.3 SuggestedTag

```
name          string   — tag name
confidence    float    — 0.0–1.0, self-reported by the LLM
is_new        bool     — true if the tag does not exist in Paperless-NGX
```

### 3.4 SuggestedField

A single-value suggestion with a confidence score. Used for correspondent and document type.

```
name          string   — suggested value (must be an existing name in Paperless-NGX)
confidence    float    — 0.0–1.0, self-reported by the LLM
```

### 3.5 Suggestion

```
id                         int                — document ID
title_quality              int | null         — LLM's assessment of the current title quality (0–100);
                                                null for heuristic provider (no semantic scoring)
suggested_title            string
suggested_correspondent    SuggestedField | null   — null if LLM has no suggestion or is confident current value is correct
suggested_document_type    SuggestedField | null   — null if LLM has no suggestion or is confident current value is correct
suggested_tags             SuggestedTag[]
reason                     string
```

### 3.6 ApplyItem

```
id                int
title             string | null    — if null, title is not updated
correspondent     string | null    — if null, correspondent is not updated
document_type     string | null    — if null, document type is not updated
tags              string[] | null  — if null, tags are not updated
tags_new          string[]         — names of new tags to create and apply; ignored entirely if tags is null
```

All fields except `id` are nullable. Only non-null fields are included in the Paperless-NGX PATCH payload. This supports per-field apply from both the table comparison view and the document review pane.

---

## 4. API endpoints

All endpoints are served by FastAPI. Request and response bodies are JSON.

### 4.1 `GET /`
Returns the main page (HTML).

### 4.2 `GET /settings`
Returns the settings page (HTML).

### 4.3 `GET /api/settings`
Returns the current settings object. The `paperless_token` value is masked — the actual token is never transmitted to the browser.

**Response**
```json
{
  "paperless_base_url": "http://...",
  "paperless_token": "***",
  "ollama_base_url": "http://...",
  "ollama_model": "llama3.1",
  "suggestion_provider": "ollama"
}
```

The settings page uses the masked value solely to indicate that a token is configured. Submitting the settings form only updates the token if the submitted value is not `"***"`.

### 4.4 `POST /api/settings`
Saves new settings to `app/settings.json`.

**Request body**: same shape as `GET /api/settings` response.

**Response**
```json
{ "status": "ok" }
```

### 4.5 `GET /api/entries?sort_by=<name|tags|quality>`
Fetches all documents from Paperless-NGX, resolves tag IDs to names, computes quality scores, and returns a sorted list.

**Query parameter**: `sort_by` — `name` (default, A→Z), `tags` (descending), `quality` (ascending, worst first — uses `llm_quality` if available, otherwise `heuristic_quality`).

**Response**: array of Entry objects (see §3.2).

**Error**: `502` if Paperless-NGX is unreachable or returns an error.

### 4.6 `POST /api/suggestions`
Generates metadata suggestions for the given document IDs.

**Request body**
```json
{ "ids": [1, 2, 3] }
```

**Response**: array of Suggestion objects (see §3.5).

**Behaviour**:
- Fetches fresh document data, full tag map, correspondent map, and document type map from Paperless-NGX.
- For each ID, calls the configured suggestion provider.
- Each SuggestedTag `is_new` flag is determined by case-insensitive name match against the Paperless-NGX tag map.
- `suggested_correspondent` and `suggested_document_type` are only set to a name that already exists in Paperless-NGX (case-insensitive match). The LLM cannot create new correspondents or document types.
- The returned `title_quality` score is stored in `settings.json` keyed by document ID so subsequent `GET /api/entries` calls can return it as `llm_quality`.
- If provider is `"ollama"` and the Ollama call fails, falls back to heuristic. The UI shows a warning indicator on that document's row to indicate the fallback occurred.
- Documents not found in Paperless-NGX are skipped (no error).
- Sets `suggestion_status` to `"ready"` for each successfully processed document.

**Error**: `502` if Paperless-NGX is unreachable.

### 4.7 `GET /api/suggestions/status?job_id=<id>`
Returns the current state of a suggestion job.

**Response**
```json
{ "job_id": "abc123", "total": 5, "completed": 2, "results": [ ...Suggestion objects... ] }
```

### 4.8 `DELETE /api/suggestions/queue`
Cancels all pending (not yet started) items in the suggestion queue. The document currently being processed by Ollama completes normally.

**Response**
```json
{ "status": "ok", "cancelled": 3 }
```

### 4.9 `POST /api/apply`
Applies a list of approved changes back to Paperless-NGX, optionally creating new tags first. Supports per-field updates — set `title` or `tags` to `null` to leave that field unchanged.

**Request body**
```json
{
  "entries": [
    {
      "id": 1,
      "title": "New Title",
      "tags": ["tag-a", "tag-b"],
      "tags_new": ["acme-corp"]
    }
  ]
}
```

**Behaviour**:
- Fetches the current tag map from Paperless-NGX to resolve tag names → IDs.
- Resolves the `"Metadata reviewed"` custom field ID (see §9.1); creates the field if it does not exist.
- For each name in `tags_new`, creates the tag via `POST /api/tags/` and adds the new ID to the set to apply.
- Tags in `tags` not found in Paperless-NGX are dropped (should not occur if the UI is correct).
- Only includes non-null fields in the `PATCH` payload per document.
- Always includes `"Metadata reviewed"` set to today's ISO date in the `PATCH` payload, regardless of which fields were changed.
- Updates `suggestion_status` to `"done"` for each successfully updated document.

**Response**
```json
{ "status": "ok", "updated": 3, "tags_created": ["acme-corp"] }
```

**Error**: `502` if any Paperless-NGX request fails.

### 4.10 `GET /api/documents/{id}/thumb`
Proxies the document thumbnail from Paperless-NGX. The Paperless token is added server-side; the browser never needs direct access to Paperless.

**Response**: JPEG image stream, content-type `image/jpeg`.

### 4.11 `GET /api/documents/{id}/preview`
Proxies the full document preview (PDF) from Paperless-NGX, streamed to avoid loading the entire file into memory.

**Response**: PDF stream, content-type `application/pdf`.

---

## 5. Quality scoring

Quality is tracked as three separate scores per document, each measuring a different dimension.

### 5.1 Heuristic quality score (tier 1)

Computed locally on every page load. No LLM call required. Range: 0–100.

**Word count** (primary signal — a good title is 3–6 words):

| Word count | Points |
|---|---|
| 3–6 words | 60 |
| 2 words | 35 |
| 7+ words | 35 |
| 1 word | 15 |
| 0 words / empty | 0 |

**Casing** (sentence case is the target convention):

| Criterion | Points |
|---|---|
| Sentence case (first word capitalised, rest lowercase) | 15 |
| At least one capital letter | 5 |
| All lowercase | 0 |

**Tags** (presence of tags is a signal of a processed document):

| Criterion | Points |
|---|---|
| Tags: 9 pts × tag count, capped at 3 tags | 0–27 |

**Penalties** (applied after summing; score floors at 0):

| Pattern | Penalty |
|---|---|
| Filename-like: underscores with no spaces, or matches `scan\d+` / `doc_` / `IMG_` / all-digit string | −30 |
| High digit ratio: >40% of characters are digits | −20 |

Maximum score: 102 (rounded to 100). A 3–6 word sentence-case title with 3+ tags and no bad patterns scores 100.

### 5.2 LLM quality score (tier 2)

Returned by the LLM when generating suggestions (see §6.1). Stored in `settings.json` keyed by document ID. Range: 0–100, `null` until the LLM has been run for that document.

Reflects semantic quality: does the title actually describe the content of the document in 3–6 words, in sentence case, without redundant metadata?

**Sort order**: when sorting by quality, `llm_quality` is used if available; otherwise `heuristic_quality` is used as the fallback.

### 5.3 Metadata completeness score (tier 3)

Computed locally on every page load. Measures how many of the five key Paperless-NGX metadata fields are filled. Range: 0–100.

| Field | Points | Condition |
|---|---|---|
| Title | 20 | Non-empty and not a filename pattern (heuristic_quality > 0) |
| Tags | 20 | At least one tag assigned |
| Correspondent | 20 | Not null |
| Document type | 20 | Not null |
| Date | 20 | Not null |

A document with all five fields populated scores 100. This score is complementary to the quality scores — a document can have a perfect title quality score but still score 40% on completeness if correspondent and document type are missing.

---

## 6. Title convention

A well-formed title in this library:

- Is in **sentence case** — first word capitalised, rest lowercase (e.g. `Kfz versicherungsschein renewal`, not `KFZ Versicherungsschein Renewal`)
- Is **3–6 words** — concise enough to scan at a glance
- Describes the **specific subject** of the document — what it is about, not what type it is
- Contains **no redundant metadata** — correspondent, document type, and date are all stored as separate fields in Paperless-NGX and displayed alongside the title; they must not be repeated in the title
- Contains **no reference numbers, policy numbers, or scanner-generated strings** — these are present in the OCR-extracted content and are fully searchable without appearing in the title
- Is written in the **language of the document**

Examples:

| Current (bad) | Improved |
|---|---|
| `scan0047` | `Electricity bill January` |
| `Versicherungsschein_Kfz-Versicherung_AD-9512372748_2026-03-20` | `Kfz versicherungsschein renewal` |
| `20231015123456` | `Salary statement October` |
| `IMG_20240302_invoice_final_v2` | `Freelance invoice Q1` |

---

## 7. Suggestion providers

### 7.1 Ollama

- Calls `POST {ollama_base_url}/api/generate` with `stream: false` and `format: "json"`.

**Prompt context** — the following are passed to the model for each document:
  - Current title
  - Correspondent name (resolved; or `"unknown"` if unset)
  - Document type name (resolved; or `"unknown"` if unset)
  - Created date (ISO format; or `"unknown"` if unset)
  - Currently applied tag names
  - Full list of all tag names that exist in Paperless-NGX
  - First 500 characters of OCR-extracted content (`content` field from Paperless API)

**Prompt context** — the following are also passed so the model can suggest correspondent and document type:
  - Full list of all correspondent names that exist in Paperless-NGX
  - Full list of all document type names that exist in Paperless-NGX

**Prompt instruction** (summary):
> You improve document metadata for a Paperless-NGX archive. Generate a sentence case title of 3–6 words describing only the specific subject of the document — do not include the correspondent, document type, or date as these are stored separately. Prefer existing tags over creating new ones. If the current correspondent or document type appears incorrect or missing, suggest the best match from the provided lists only — do not invent new ones. Express confidence in each suggestion.

**Expected JSON response**:
  ```json
  {
    "title_quality": 45,
    "suggested_title": "string",
    "suggested_correspondent": { "name": "string", "confidence": 0.0 },
    "suggested_document_type": { "name": "string", "confidence": 0.0 },
    "suggested_tags": [
      { "name": "string", "confidence": 0.0 }
    ],
    "reason": "string"
  }
  ```

- `title_quality` (0–100): the model's assessment of how good the *current* title is. Stored as `llm_quality`.
- `suggested_correspondent` and `suggested_document_type`: omit (or set to `null`) if the current value is already correct or the model is not confident. The backend validates that the suggested name exists in Paperless-NGX (case-insensitive); invalid suggestions are discarded.
- `confidence` per tag (0.0–1.0): self-reported. The prompt instructs the model to prefer existing tags (high confidence) and only propose new ones when genuinely warranted.
- The backend marks each tag as `is_new: true` if its name is absent from the Paperless-NGX tag map (case-insensitive).
- Falls back to heuristic on any error (network, non-200, malformed JSON). The UI shows a warning indicator on the affected row.

### 7.2 Heuristic

Local, offline. No external calls.

- **Title**: capitalises each word and replaces underscores with spaces. Word boundaries are spaces only — hyphens are not treated as separators.
- **Tags**: not modified — returns the document's existing tags unchanged. Tag improvements require an LLM with access to document content.
- **Correspondent**: not modified — no suggestion.
- **Document type**: not modified — no suggestion.
- **`title_quality`**: returns `null` — the heuristic has no semantic understanding of title quality.
- **Reason**: fixed string `"Title normalized. Correspondent, document type, and tag suggestions require an LLM provider."`

---

## 8. Frontend pages

### 8.1 Main page (`/`)

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│  Paperless Cleaner                          [Settings]   │
├─────────────────────────────────────────────────────────┤
│  [Refresh]  [Generate suggestions ▸]                    │
│  [Show suggestions (3 ready)]  [Apply all approved (2)] │
├─────────────────────────────────────────────────────────┤
│  Active filters: Correspondent: ADAC ×   Quality < 50 × │
├──┬────────┬────────────┬───────────────┬─────┬──────────┤
│☑ │Status ▾│Title      ▾│Correspondent ▾│Tags▾│Quality  ▾│
├──┼────────┼────────────┼───────────────┼─────┼──────────┤
│  │  🟢   │ scan0047   │ ADAC          │ ... │  12      │
│  │  🟡   │ 20231015.. │ Belasting..   │ ... │   8      │
│  │  ⚪   │ Contract.. │ ING           │ ... │  75      │
└──┴────────┴────────────┴───────────────┴─────┴──────────┘
                                                           │
                                        [Document pane]   │
```

**Columns**: ☑ (select) | Status | Title | Correspondent | Document type | Date | Tags | Quality | Completeness | Reviewed

- **Quality** shows `llm_quality` if available, otherwise `heuristic_quality`.
- **Completeness** shows `metadata_completeness` (0–100).
- **Reviewed** shows the `metadata_reviewed` date (or empty if never touched by this tool).
- `null` values for correspondent, document type, and date are displayed as `—`.

When "Show suggestions" is active, two additional columns appear between the originals and Quality: **Suggested title** | **Suggested tags**.

#### Column header controls (Excel-style)

Clicking any column header opens a dropdown containing:

- **Sort ascending / Sort descending** — clicking again toggles direction; an arrow indicator on the header shows the active sort
- **Column-specific filter**:
  - *Title*: free text search (substring match)
  - *Correspondent, Document type, Status*: checkbox list of all values present in the current data
  - *Tags*: checkbox list of all tag names — a document matches if it has any of the checked tags
  - *Quality*: range slider (min / max)
  - *Date*: date range picker (from / to)
  - *Reviewed*: date range picker, plus a "Never reviewed" checkbox to show only untouched documents
- **Clear filter** — removes the filter for this column

Active filters are shown as removable chips in a filter bar above the table. A "Clear all filters" button removes all at once. Filtering and sorting are applied client-side on the loaded dataset — no re-fetch required.

#### Suggestion status indicator

Each row has a coloured status dot in the Status column:

| Dot | Status | Meaning |
|---|---|---|
| ⚪ Grey | `none` | No suggestion requested |
| 🟡 Yellow | `pending` | Queued or being processed by Ollama |
| 🟢 Green | `ready` | Suggestion generated; at least one field still undecided |
| 🔵 Blue | `done` | All suggested fields resolved (applied or rejected); no attention needed |
| ⚠️ Orange | — | Ollama failed; heuristic fallback was used |

#### Show suggestions toggle

A toolbar button **"Show suggestions (N ready)"** where N is the count of documents with `suggestion_status = "ready"`. When active:
- The table gains **Suggested title**, **Suggested correspondent**, **Suggested document type**, and **Suggested tags** columns.
- Each suggestion cell shows the suggested value with a per-field **Apply** button and a **Reject** (✕) button.
- Rows without a ready suggestion show an empty cell in those columns.
- Applied fields show a ✓ indicator; rejected fields show a strikethrough. Once all fields in a row are applied or rejected the row status updates to 🔵 "done" automatically.

#### Document review pane

Clicking any table row opens a right-side panel:

- **Left**: document thumbnail (from `GET /api/documents/{id}/thumb`) with a link to open the full PDF preview in a new tab (`GET /api/documents/{id}/preview`).
- **Right**: metadata fields in a layout similar to the Paperless-NGX document view:
  - Each field shows the current value.
  - If a suggestion is ready and not yet resolved, the suggested value is shown directly below in a distinct style with **Apply** and **Reject** buttons for that field.
  - Fields: Title, Correspondent, Document type, Tags (as badges; new suggested tags show confidence and a "Create & apply" toggle).
  - Applied fields show a ✓; rejected fields show a strikethrough and no longer display their Apply/Reject buttons.
  - **Apply all remaining** button at the top applies all still-undecided suggested fields in one action.
  - **Reject all remaining** button rejects all still-undecided fields.
  - Closing the pane returns to the full table; field states are preserved in client-side memory for the duration of the session (lost on page refresh).
- Approval state (which fields are applied/rejected) is shared between the table and the review pane.

#### Approval and apply workflow

- Each document with a ready suggestion has an **approve checkbox** — visible in the table (when "Show suggestions" is on) and in the review pane. Approval state is shared between both views.
- **"Apply all approved"** button: disabled until at least one document is approved; applies all approved documents in a single `POST /api/apply` call. On success, approved rows update to `suggestion_status = "applied"` (🔵) and the button resets.
- **Per-field apply** (from table or pane): sends a `POST /api/apply` with only the relevant field set; the other field is `null`.

#### Loading states

- **Paperless calls** (< 2 s): the triggering button is disabled and shows a spinner label (e.g. "Refreshing…"). A new request to the same endpoint is blocked until the previous one completes.
- **Ollama queue** (10–30 s per document): the "Generate suggestions" button is disabled while the queue is non-empty. A progress bar and "Processing N of M…" label update as each document completes. The "Show suggestions" badge count updates in real time as results arrive.
- **Apply**: the "Apply all approved" button is disabled while the apply request is in flight.

#### Error handling

- Failed page load: inline error message in the table body.
- Failed suggestion (single document): that row's status shows an error indicator; other rows are unaffected.
- Failed apply (single document): inline error shown below the table; successfully applied documents are still updated.

### 8.2 Request handling and task queue architecture

Different external calls have very different latency profiles and must be handled accordingly.

#### Paperless-NGX requests (fast, < 2 s expected)

- Triggered directly in response to user actions (page load, refresh, apply).
- Concurrent requests to the same endpoint are blocked — a new request cannot start until the previous one resolves.
- UI buttons are disabled for the duration; a spinner label indicates activity.
- Errors surface immediately as inline messages.

#### Ollama requests (slow, 10–30 s per document)

Ollama can only process one document at a time (single GPU, serial inference). Sending multiple requests concurrently would queue them inside Ollama anyway, with no benefit. The architecture therefore uses an explicit **backend task queue**:

**Backend (FastAPI)**
- `POST /api/suggestions` no longer blocks until all documents are processed. Instead it enqueues the requested document IDs and returns immediately with a `job_id`.
- A background worker (Python `asyncio` task) pulls one document ID at a time from the queue, calls Ollama, and stores the result.
- Two new endpoints expose queue state:
  - `GET /api/suggestions/status?job_id=<id>` — returns `{ total, completed, results: [...] }` where `results` grows as documents finish.
  - `DELETE /api/suggestions/queue` — cancels all pending items (does not interrupt the in-flight Ollama call).

**Frontend**
- After POSTing to `/api/suggestions`, the frontend polls `GET /api/suggestions/status` every 2 seconds.
- Each completed result is rendered as a suggestion card immediately (progressive rendering).
- The progress indicator shows `"Processing N of M…"` and updates with each poll.
- Polling stops when `completed == total` or the user navigates away.
- The "Generate suggestions" button is disabled while `completed < total`.

#### Apply requests (fast, one PATCH per document)

- Sent as a single `POST /api/apply` with all approved entries.
- The apply button is disabled until at least one card is approved and while the request is in flight.
- Errors are shown inline; the document list is refreshed on success.

#### Graceful shutdown

When the container receives SIGTERM (e.g. `docker compose stop`):
1. The pending queue is cleared immediately — no new Ollama calls are started.
2. The in-flight Ollama HTTP request is cancelled via httpx task cancellation. Ollama stops receiving the connection and halts generation.
3. FastAPI completes the shutdown sequence.

The Docker Compose `stop_grace_period` must be set to at least the Ollama timeout (60 s) to allow this to complete cleanly before Docker sends SIGKILL. The default 10 s is not sufficient.

---

### 8.3 Settings page (`/settings`)

**Layout**
- Header with page title and Back link.
- Form: one field per setting (see §3.1), Save button.
- Status line below form.

**Behaviour**
- On load: fetches current settings and populates form fields.
- On submit: POSTs form values, shows "Settings saved." or error.

---

## 9. External integrations

### 9.1 Paperless-NGX

- **Auth**: `Authorization: Token <paperless_token>` header. Omitted if token is empty.
- **Pagination**: follows `next` URL in paginated responses until exhausted.
- **Endpoints used**:
  - `GET /api/documents/` — fetch all documents (includes `content`, `correspondent`, `document_type`, `created` fields)
  - `GET /api/tags/` — fetch all tags
  - `GET /api/correspondents/` — fetch all correspondents (to resolve IDs → names)
  - `GET /api/document_types/` — fetch all document types (to resolve IDs → names)
  - `POST /api/tags/` — create a new tag
  - `GET /api/custom_fields/` — fetch all custom fields to resolve the "Metadata reviewed" field ID (case-insensitive name match; if a field with that name exists but has the wrong data type, a new field named "Metadata reviewed (cleaner)" is created instead)
  - `POST /api/custom_fields/` — create the "Metadata reviewed" date field if it does not exist
  - `PATCH /api/documents/{id}/` — update a document (includes custom field value)
  - `GET /api/documents/{id}/thumb/` — proxied for thumbnail display (see §4.10)
  - `GET /api/documents/{id}/preview/` — proxied for PDF preview (see §4.11)

### 9.2 Ollama

- **Endpoint**: `POST /api/generate`
- **Timeout**: 60 seconds (longer than Paperless calls due to inference time).
- **Expected response field**: `response` (string containing JSON).

---

## 10. Deployment

- Docker image based on `python:3.12-slim`.
- Single `paperless-cleaner` service, port `8080`.
- `app/settings.json` bind-mounted from host for persistence. **Must be created (`touch app/settings.json`) before first `docker compose up`.**
- `llm_quality` scores and `suggestion_status` are persisted in `settings.json` keyed by document ID so they survive restarts. Structure:
  ```json
  {
    "paperless_base_url": "...",
    "paperless_token": "...",
    "ollama_base_url": "...",
    "ollama_model": "...",
    "suggestion_provider": "...",
    "document_state": {
      "123": { "llm_quality": 45, "suggestion_status": "done" },
      "124": { "llm_quality": null, "suggestion_status": "ready" }
    }
  }
  ```
- Field-level apply/reject state (which fields are applied or rejected per document) is **not** persisted — it is held in client-side memory only and is lost on page refresh. Only the final `suggestion_status` transition to `"done"` is persisted.
- `stop_grace_period: 70s` — allows the in-flight Ollama request (60 s timeout) to be cancelled cleanly before Docker sends SIGKILL.
- Auto-restart unless stopped.

---

## 11. Resolved decisions

1. **Task queue persistence** — losing queued jobs on container restart is acceptable. Graceful shutdown ensures Ollama stops promptly (see §8.2).
2. **Paperless-NGX token security** — token masked in `GET /api/settings`; plaintext storage accepted; network-level restriction is the user's responsibility.
3. **Filtering** — promoted to core feature (see §8.1).
4. **Loading states** — resolved via loading states spec and task queue architecture (see §8.1, §8.2).
5. **Batch Ollama calls** — resolved via serial task queue with progressive frontend rendering (see §8.2).

---

## 12. Future nice-to-haves

These are out of scope for the current implementation but worth revisiting later.

1. **App-level authentication**: a password configured in settings that gates access to the entire UI. Useful if the app is reachable beyond a trusted local network.
2. **Select all filtered**: a checkbox to select all currently visible (filtered) rows at once for bulk suggestion generation.
3. **Task queue persistence**: survive container restarts without losing queued suggestion jobs.
