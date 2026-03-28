# Paperless Cleaner — Specification

> Working document. Edit freely before implementation begins.

---

## 1. Purpose

Paperless Cleaner is a self-hosted web application that sits alongside a Paperless-NGX instance and helps users improve the metadata quality of their document library — specifically titles and tags — through sorting, scoring, and bulk suggestion workflows.

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
id               int
title            string
correspondent    string | null   — resolved name (not ID)
document_type    string | null   — resolved name (not ID)
date             string | null   — ISO date (created date from Paperless)
tags             string[]        — resolved tag names (not IDs)
heuristic_quality  int           — 0–100, see §5 tier 1
llm_quality        int | null    — 0–100, see §5 tier 2; null until LLM has been run for this document
```

### 3.3 SuggestedTag

```
name          string   — tag name
confidence    float    — 0.0–1.0, self-reported by the LLM
is_new        bool     — true if the tag does not exist in Paperless-NGX
```

### 3.4 Suggestion

```
id                int             — document ID
title_quality     int             — LLM's assessment of the current title quality (0–100)
suggested_title   string
suggested_tags    SuggestedTag[]
reason            string
```

### 3.5 ApplyItem

```
id          int
title       string
tags        string[]   — names of existing tags to apply
tags_new    string[]   — names of new tags to create and apply
```

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

**Response**: array of Suggestion objects (see §3.4).

**Behaviour**:
- Fetches fresh document data, full tag map, correspondent map, and document type map from Paperless-NGX.
- For each ID, calls the configured suggestion provider.
- Each SuggestedTag includes `is_new: true` if the tag name is not in the Paperless-NGX tag map.
- The returned `title_quality` score is stored against the document so subsequent calls to `GET /api/entries` can return it as `llm_quality`.
- If provider is `"ollama"` and the Ollama call fails, falls back to heuristic silently.
- Documents not found in Paperless-NGX are skipped (no error).

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
Applies a list of approved changes back to Paperless-NGX, optionally creating new tags first.

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
- For each name in `tags_new`, creates the tag via `POST /api/tags/` and adds the new ID to the set to apply.
- Tags in `tags` not found in Paperless-NGX are dropped (should not occur if the UI is correct).
- Issues a `PATCH` request per document.

**Response**
```json
{ "status": "ok", "updated": 3, "tags_created": ["acme-corp"] }
```

**Error**: `502` if any Paperless-NGX request fails.

---

## 5. Quality scoring

Quality is tracked as two separate scores per document.

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

**Prompt instruction** (summary):
> You improve document metadata for a Paperless-NGX archive. The correspondent, document type, and date are already stored as separate fields — do not include them in the title. Generate a sentence case title of 3–6 words describing only the specific subject of the document. Prefer existing tags over creating new ones; only suggest a new tag if no existing tag is adequate.

**Expected JSON response**:
  ```json
  {
    "title_quality": 45,
    "suggested_title": "string",
    "suggested_tags": [
      { "name": "string", "confidence": 0.0 }
    ],
    "reason": "string"
  }
  ```

- `title_quality` (0–100): the model's assessment of how good the *current* title is. This is stored as `llm_quality` on the document entry.
- `confidence` per tag (0.0–1.0): self-reported. The prompt instructs the model to prefer existing tags (high confidence) and only propose new ones when genuinely warranted (which should result in lower confidence scores for invented tags).
- The backend marks each tag as `is_new: true` if its name is absent from the Paperless-NGX tag map (case-insensitive).
- Falls back to heuristic on any error (network, non-200, malformed JSON).

### 7.2 Heuristic

Local, offline. No external calls.

- **Title**: capitalises each word, replaces underscores with spaces.
- **Tags**: not modified — returns the document's existing tags unchanged. Tag improvements require an LLM with access to document content; the heuristic provider does not attempt them.
- **Reason**: fixed string `"Title normalized. Tag suggestions require an LLM provider."`

---

## 8. Frontend pages

### 8.1 Main page (`/`)

**Layout**
- Header with app name and link to Settings.
- Toolbar: sort selector (`name` / `tags` / `quality`), Refresh button, Generate suggestions button.
- Document table: checkbox | Title | Correspondent | Document type | Tags | Quality score (LLM score shown if available, heuristic otherwise).
- Suggestions section: cards (one per document), Apply approved changes button.

**Behaviour**
- On load: fetches and renders the document list.
- Sort selector change: re-fetches with new sort parameter.
- Refresh button: re-fetches document list.
- Generate suggestions: adds selected IDs to the suggestion task queue (see §8.3); suggestion cards render progressively as results arrive.
- Each card: approve checkbox (checked by default), editable title input, tag list with per-tag controls, reason text.
- Each tag in the card is shown as a badge. New tags (`is_new: true`) are visually distinct (e.g. dashed border or different colour).
- New tags with confidence ≥ 0.8 show a "Create & apply" toggle (on by default). New tags with confidence < 0.8 show the same toggle but default to off.
- Existing tags are always applied as normal when the card is approved.
- Apply: collects approved cards, builds `tags` (existing) and `tags_new` (new tags with "Create & apply" toggled on) per entry, POSTs to `/api/apply`, shows success/error alert including any tags created, then refreshes document list.

**Loading states**
- **Paperless-NGX calls** (expected < 2 s): buttons that trigger a Paperless request are disabled and show a spinner label (e.g. "Refreshing…") for the duration. A new request cannot be triggered until the previous one completes.
- **Ollama calls** (may take 10–30 s per document): handled via the task queue (§8.3). The "Generate suggestions" button is disabled while the queue is non-empty. A progress indicator shows "Processing 2 of 5…" updating as each document completes.
- **Apply**: the "Apply approved changes" button is disabled until at least one suggestion card is approved, and again while the apply request is in flight.

**Error handling**
- Failed `GET /api/entries`: displays inline error message in the table.
- Failed suggestion (single document): the card for that document shows an error state; other cards are unaffected.
- Failed `POST /api/apply`: displays inline error; successfully applied entries are still reflected on refresh.

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
  - `PATCH /api/documents/{id}/` — update a document

### 9.2 Ollama

- **Endpoint**: `POST /api/generate`
- **Timeout**: 60 seconds (longer than Paperless calls due to inference time).
- **Expected response field**: `response` (string containing JSON).

---

## 10. Deployment

- Docker image based on `python:3.12-slim`.
- Single `paperless-cleaner` service, port `8080`.
- `app/settings.json` bind-mounted from host for persistence. **Must be created (`touch app/settings.json`) before first `docker compose up`.**
- `llm_quality` scores are persisted in `settings.json` keyed by document ID so they survive restarts.
- Auto-restart unless stopped.

---

## 11. Open questions / future considerations

1. **Task queue persistence**: the backend task queue (§8.2) lives in memory. If the container restarts mid-run, queued jobs are lost. Should the queue be persisted to `settings.json`, or is losing in-progress suggestions on restart acceptable?
2. **Paperless-NGX token security**: the token is stored in plaintext in `settings.json`. `GET /api/settings` masks the value as `"***"` so it is never transmitted to the browser. Access to the app itself should be restricted at the network level — do not expose port 8080 beyond a trusted local network.
3. **Filtering**: no way to filter by tag, date range, or quality threshold — only sorting is supported.
4. **Select all**: no "select all" checkbox in the document table.

---

## 12. Future nice-to-haves

These are out of scope for the current implementation but worth revisiting later.

1. **App-level authentication**: a password configured in settings that gates access to the entire UI. Useful if the app is reachable beyond a trusted local network.
2. **Filtering**: filter the document list by tag, correspondent, document type, quality threshold, or date range.
3. **Select all**: a "select all" checkbox to queue the entire visible document list for suggestion generation.
4. **Task queue persistence**: survive container restarts without losing queued suggestion jobs.
