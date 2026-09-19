# Paperless Cleaner — Specification

> This document reflects the current implemented state of the application.

---

## 1. Purpose

Paperless Cleaner is a self-hosted web application that sits alongside a Paperless-NGX instance and helps users improve the metadata quality of their document library — titles, tags, correspondents, and document types — through sorting, scoring, and a keyboard-driven suggestion review workflow.

---

## 2. Architecture overview

```
Browser  ←→  FastAPI (internal port 8080, exposed as 8200)  ←→  Paperless-NGX API
                                                             ←→  Ollama API (optional)
```

- **Backend**: Python / FastAPI. State: `config/settings.json` (connection config only; legacy location `app/settings.json` is migrated automatically). All document data lives in Paperless-NGX, including quality scores and suggestion status (stored as custom fields).
- **Frontend**: Vanilla HTML/CSS/JavaScript. Two pages: main (`/`) and settings (`/settings`).
- **No local database**. All document state is fetched live from Paperless-NGX.
- **Docker Compose** for deployment. Single service; host port `8200`, container port `8080`.

---

## 3. Data models

### 3.1 Settings

Persisted in `config/settings.json` (`CONFIG_DIR`, default `/app/config`; override the file with `SETTINGS_FILE`). Seeded from environment variables on first run if the file is empty. `PAPERLESS_URL` is accepted as an alias for `PAPERLESS_BASE_URL`.

| Field | Type | Default | Env var |
|---|---|---|---|
| `paperless_base_url` | string | `http://paperless-ngx:8000` | `PAPERLESS_BASE_URL` |
| `paperless_token` | string | `""` | `PAPERLESS_TOKEN` |
| `ollama_base_url` | string | `http://ollama:11434` | `OLLAMA_BASE_URL` |
| `ollama_model` | string | `llama3.1` | `OLLAMA_MODEL` |
| `suggestion_provider` | `"ollama"` \| `"heuristic"` | `"ollama"` | `SUGGESTION_PROVIDER` |
| `ollama_temperature` | float | `0.0` | `OLLAMA_TEMPERATURE` |
| `confidence_discount` | float | `0.2` | `CONFIDENCE_DISCOUNT` |
| `few_shot_min_documents` | int | `5` | `FEW_SHOT_MIN_DOCUMENTS` |

- `ollama_temperature`: `0.0` gives deterministic output. Can be raised slightly if the model produces repetitive results.
- `confidence_discount`: subtracted from all LLM-reported confidence scores. Local models are systematically overconfident.
- `few_shot_min_documents`: minimum reviewed documents before library examples are used in the prompt. Falls back to generic built-in examples below this threshold.

### 3.2 Entry (document as seen by the UI)

```
id                      int
title                   string
correspondent           string | null   — resolved name; displayed as "—" if null
document_type           string | null   — resolved name; displayed as "—" if null
date                    string | null   — ISO date (created date from Paperless)
tags                    string[]        — resolved tag names
heuristic_quality       int             — 0–100, computed locally (see §5.1)
llm_quality             int | null      — 0–100, stored in "LLM quality" custom field; null until LLM run
metadata_completeness   int             — 0–100, computed locally (see §5.3)
suggestion_status       string          — "none" | "pending" | "ready" | "done"
metadata_reviewed       string | null   — ISO date from "Metadata reviewed" custom field; null if never touched
```

**`suggestion_status` values:**
- `"none"` — no suggestion has been requested
- `"pending"` — document is queued or being processed (transient in-memory; resets on server restart)
- `"ready"` — suggestion generated; at least one field is still undecided (transient in-memory; resets on server restart)
- `"done"` — all suggested fields resolved; stored in the "Suggestion status" Paperless custom field

Status transitions to `"done"` automatically when the last undecided field is applied or rejected.

### 3.3 Paperless custom fields

Three custom fields are auto-created at startup if they do not exist:

| Field name | Data type | Purpose |
|---|---|---|
| `LLM quality` | Integer | LLM's assessment of the title (0–100) |
| `Suggestion status` | String | `"done"` once fully reviewed (persistent across restarts) |
| `Metadata reviewed` | Date | ISO date of the last apply operation |

### 3.4 SuggestedTag

```
name          string   — tag name
confidence    float    — 0.0–1.0, self-reported by the LLM; reduced by confidence_discount
is_new        bool     — true if tag does not exist in Paperless-NGX
```

### 3.5 SuggestedField

Used for correspondent and document type.

```
name          string   — must be an existing value in Paperless-NGX (case-insensitive match)
confidence    float    — 0.0–1.0
```

### 3.6 Suggestion

```
id                         int
title_quality              int | null         — LLM's assessment of the current title (0–100); null for heuristic
detected_language          string | null      — e.g. "Dutch", "German"; null for heuristic
reasoning                  string | null      — LLM chain-of-thought; null for heuristic
suggested_title            string
suggested_correspondent    SuggestedField | null
suggested_document_type    SuggestedField | null
suggested_tags             SuggestedTag[]
protected_tags             string[]           — manual tag names (never shown as removals in the diff)
reason                     string             — one-sentence human-readable summary
fallback_used              bool               — true if Ollama failed and heuristic was used
```

`suggested_correspondent` and `suggested_document_type` are `null` if the LLM has no improvement to suggest or the current value is already correct. The backend discards any suggestion that matches the current value (case-insensitive), preventing no-op suggestions.

### 3.7 ApplyItem

```
id                int
title             string | null    — null = do not update
correspondent     string | null    — null = do not update
document_type     string | null    — null = do not update
tags              string[] | null  — null = do not update
tags_new          string[]         — new tag names to create before applying
```

---

## 4. API endpoints

All endpoints served by FastAPI. Request/response bodies are JSON.

### 4.1 `GET /`
Returns the main page (HTML).

### 4.2 `GET /settings`
Returns the settings page (HTML).

### 4.3 `GET /api/settings`
Returns current settings. `paperless_token` is masked as `"***"`.

### 4.4 `POST /api/settings`
Saves settings to `config/settings.json`. Token is only updated if the submitted value is not `"***"`. Re-resolves the Paperless custom fields with the new connection.

**Response**: `{ "status": "ok", "paperless_ok": true, "paperless_error": null }`

### 4.4a `POST /api/settings/test`
Checks the submitted (possibly unsaved) connection values without saving them. Token `"***"` means "use the stored token".

**Request body**: `{ "paperless_base_url", "paperless_token", "ollama_base_url", "ollama_model" }`

**Response**: `{ "paperless": { "ok": bool, "message": str }, "ollama": { "ok": bool, "message": str } }`

### 4.5 `GET /api/entries`
Fetches all documents from Paperless-NGX, resolves tag/correspondent/document_type IDs to names, reads custom field values, computes quality scores, and overlays transient in-memory status.

Custom field IDs are resolved lazily: if they could not be resolved at startup (e.g. Paperless was still booting), every request retries until they are. While they are unresolved the documents are still returned, but `review_state_ok` is `false` and `warnings` explains that review state is unknown — the UI shows this as a banner rather than presenting every document as unreviewed.

**Response**: `{ "entries": [Entry (§3.2)], "review_state_ok": bool, "warnings": [str] }`

**Errors**: `502` if Paperless-NGX is unreachable, `503` if no API token is configured. `detail` is a human-readable sentence.

### 4.6 `POST /api/suggestions`
Adds document IDs to the global suggestion queue. Deduplicates — IDs already in the queue are skipped.

**Request body**: `{ "ids": [1, 2, 3] }`

**Response**: `{ "newly_added": 2, "total": 5 }` — `total` reflects the cumulative global queue size.

**Behaviour**:
- Fetches fresh documents, tags, correspondents, and document types from Paperless-NGX.
- Adds valid IDs to the single persistent global job (`_global_job`). Multiple calls accumulate into one job.
- Marks new items as `"pending"` in transient in-memory state.
- Returns immediately; processing happens in the background worker.

### 4.7 `GET /api/suggestions/status`
Returns the current state of the global suggestion job.

**Response**
```json
{
  "total": 5,
  "completed": 3,
  "results": [ ...Suggestion objects... ],
  "items": [ { "doc_id": 1, "title": "...", "status": "done", "started_at": 1234, "finished_at": 1235 } ],
  "elapsed_seconds": 42.1,
  "avg_seconds_per_doc": 14.0,
  "eta_seconds": 28
}
```

**Error**: `404` if no job exists yet (or after cancel).

### 4.8 `DELETE /api/suggestions/queue`
Drains all pending items from the queue and resets the global job to `null`. The document currently being processed completes normally.

**Response**: `{ "status": "ok", "cancelled": 3 }`

### 4.9 `POST /api/apply`
Applies approved changes to Paperless-NGX and writes the three custom field values.

**Request body**: `{ "entries": [ ApplyItem, ... ] }`

**Behaviour**:
- For each name in `tags_new`, creates the tag via `POST /api/tags/`.
- PATCHes each document with only non-null fields plus the three custom fields: `LLM quality`, `Suggestion status` (set to `"done"`), `Metadata reviewed` (today's ISO date).
- Preserves manual tags (matching algorithm = 0) by fetching the current tag list before patching.
- Updates transient `suggestion_status` to `"done"` for each document.

**Response**: `{ "status": "ok", "updated": 3, "tags_created": ["acme-corp"] }`

### 4.10 `GET /api/documents/{id}/thumb`
Proxies the document thumbnail from Paperless-NGX. Paperless token added server-side.

**Response**: JPEG image stream.

### 4.11 `GET /api/documents/{id}/preview`
Proxies the full PDF from Paperless-NGX, streamed.

**Response**: PDF stream.

---

## 5. Quality scoring

### 5.1 Heuristic quality score

Computed locally on every load. Range 0–100.

**Word count**:

| Count | Points |
|---|---|
| 3–6 words | 60 |
| 2 or 7+ words | 35 |
| 1 word | 15 |
| 0 words / empty | 0 |

**Casing**:

| Criterion | Points |
|---|---|
| Sentence case | 15 |
| At least one capital | 5 |
| All lowercase | 0 |

**Tags**: 9 pts × tag count, capped at 3 tags (0–27 pts).

**Penalties** (applied after summing; floor at 0):

| Pattern | Penalty |
|---|---|
| Filename-like (underscores, `scan\d+`, `doc_`, `IMG_`, all-digit) | −30 |
| High digit ratio (>40% of chars are digits) | −20 |

### 5.2 LLM quality score

Returned by the LLM when generating suggestions. Stored in the "LLM quality" Paperless custom field. Range 0–100; `null` until LLM has been run.

When sorting by **Quality**, `llm_quality` is used if available; otherwise `heuristic_quality`.

### 5.3 Metadata completeness score

Computed locally. 20 pts each for: non-empty title (not filename-like), at least one tag, correspondent not null, document type not null, date not null. Range 0–100.

---

## 6. Title convention

A well-formed title:
- **Sentence case** — first word capitalised, rest lowercase
- **3–6 words** — concise
- **Describes the specific subject** — not the document type, correspondent, or date (those are separate fields)
- **No reference numbers or scanner strings** — fully searchable in Paperless OCR
- **Written in the document's language**

---

## 7. Suggestion providers

### 7.1 Ollama

Uses the **Instructor** library with Ollama's OpenAI-compatible `/v1` endpoint (`instructor.from_openai` + `AsyncOpenAI(base_url=f"{ollama_url}/v1", api_key="ollama")`). Instructor enforces the response schema and retries on malformed output.

#### Language detection

Before the main call, `langdetect` runs on the first 500 characters of OCR content. The detected language name is passed into the prompt. Falls back to `"unknown"` on failure.

#### System prompt structure

```
/no_think                          ← suppresses qwen3 thinking mode

## Output format
Respond with a single valid JSON object.

## JSON schema
{ reasoning, title_quality, suggested_title, suggested_correspondent,
  suggested_document_type, suggested_tags, reason }

## Allowed values
Tags: {AUTO_TAG_NAMES}             ← auto-matched tags only; manual tags listed separately
Correspondents: {ALL_CORRESPONDENT_NAMES}
Document types: {ALL_DOCUMENT_TYPE_NAMES}

## Protected tags (do not suggest removing these)
{MANUAL_TAG_NAMES}

## Examples
{FEW_SHOT_EXAMPLES}

## Rules
- Title: sentence case, 3–6 words, in {LANGUAGE}, subject only
- Suggest correspondent/document_type only if current value is wrong or missing
- Confidence 0.0–1.0; be conservative
- Do not invent tags/correspondents/document_types not in the lists
```

User message includes: current title, correspondent, document type, date, tags, first 500 chars of content.

#### Few-shot examples

Drawn from the user's own reviewed library if ≥ `few_shot_min_documents` documents have `suggestion_status = "done"` with at least one field applied. Otherwise uses built-in generic examples. Always 2–3 examples.

#### Backend validation

After parsing the Instructor response:
- `suggested_correspondent.name` must exist in Paperless (case-insensitive); discarded otherwise
- `suggested_document_type.name` must exist in Paperless; discarded otherwise
- Correspondent/document_type are discarded if they match the current value (no-op suppression)
- `suggested_tags` entries with `is_new: false` must exist in the tag map; invalid ones discarded
- Falls back to heuristic on any unrecoverable error; sets `fallback_used = true`

### 7.2 Heuristic

Local, offline. Capitalises each word, replaces underscores with spaces. Does not suggest tags, correspondent, or document type changes. Returns `title_quality = null`.

---

## 8. Frontend

### 8.1 Main page (`/`)

#### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Paperless Cleaner                            [?] [Settings] │
├─────────────────────────────────────────────────────────────┤
│  [Refresh] [Generate suggestions] [Show suggestions (N)]    │
│  [Accept all suggestions for N selected]  [Cancel queue]    │
├─────────────────────────────────────────────────────────────┤
│  ████████░░░░  Processing 3 of 5 · ~14 s/doc · ETA 28 s    │
├─────────────────────────────────────────────────────────────┤
│  Active filters: Correspondent: ADAC ×   Quality < 50 ×     │
├──┬────────┬────────────┬───────────┬──────┬──────┬──────────┤
│☑ │Status ▾│Title      ▾│Corresp.  ▾│Tags ▾│Qual ▾│Complete ▾│
├──┼────────┼────────────┼───────────┼──────┼──────┼──────────┤
│  │  🟢   │ scan0047   │ ADAC      │ ...  │  12  │   40     │
└──┴────────┴────────────┴───────────┴──────┴──────┴──────────┘
```

**Columns**: ☑ | Status | Title | Correspondent | Document type | Date | Tags | Quality | Completeness | Reviewed

When "Show suggestions" is active: Suggested title | Suggested correspondent | Suggested document type | Suggested tags columns are added.

#### Column header controls

Clicking a header opens a dropdown with sort and filter options. Filter types:
- *Title*: text search (substring)
- *Correspondent, Document type, Status*: checkbox list
- *Tags*: checkbox list (document matches if it has any checked tag)
- *Quality, Completeness*: min/max range
- *Date, Reviewed*: date range; Reviewed also has "Never reviewed" checkbox

Active filters show as removable chips above the table. All filtering and sorting is client-side.

#### Status dots

| Dot | Status | Meaning |
|---|---|---|
| ⚪ Grey | `none` | No suggestion requested |
| 🟡 Yellow | `pending` | Queued / processing (transient) |
| 🟢 Green | `ready` | Suggestion ready; undecided fields remain (transient) |
| 🔵 Blue | `done` | All fields resolved; stored in Paperless |
| ⚠ Orange | — | Ollama failed; heuristic fallback used |

#### Progress bar

Appears while the suggestion queue is running. Shows `completed / total`, average time per document, and ETA. Clicking the bar opens the **queue detail panel** which lists each document with its processing status and duration.

#### Document review pane

Opens as a **centred modal** when clicking any row. Contains:
- Document thumbnail (proxied from Paperless) with link to open the full PDF
- Link to open the document in Paperless-NGX (`↗`)
- Detected language label (`🌐 Dutch`)
- Each field (Title, Correspondent, Document type, Tags) with:
  - Current value
  - Suggested change (if any and undecided) with per-field **Apply** / **Reject** buttons
  - Applied fields: `✓ Applied`; rejected fields: greyed out strikethrough
- **Tag diff**: green `+` badges for additions, red strikethrough `−` badges for removals. Manual tags (matching_algorithm = 0) are listed as protected and never appear as removals.
- **Apply & Next →** — applies all remaining undecided suggestions and opens the next document with actionable suggestions (wraps; closes pane if none remain)
- **Reject & Next →** — same but rejects
- **‹ ›** nav arrows in the header — navigate without acting
- **Model reasoning** — collapsible section with the LLM's chain-of-thought
- Keyboard shortcuts hint line

#### Keyboard shortcuts (pane only)

| Key | Action |
|---|---|
| `A` | Apply all remaining & go to next |
| `R` | Reject all remaining & go to next |
| `→` / `L` | Next document |
| `←` / `H` | Previous document |
| `Esc` | Close pane |

Shortcuts are inactive when focus is in an input or textarea.

#### Help overlay

A **?** button in the header opens a full help modal documenting the workflow, columns, review pane, and keyboard shortcuts.

### 8.2 Task queue architecture

#### Paperless-NGX requests (fast)

Triggered by user actions; buttons disabled while in flight.

#### Ollama requests (slow, 10–30 s per document)

Uses a **single global background job** (`_global_job`) with an `asyncio.Queue` worker:

- `POST /api/suggestions` adds new document IDs to the existing job (deduplicating). Multiple calls accumulate into one job — no new job_id is issued.
- The frontend always polls `GET /api/suggestions/status` (no job_id parameter).
- The queue detail panel shows per-item status and timing.
- `DELETE /api/suggestions/queue` drains the queue and resets the global job to `null`.
- On page load, the frontend probes `/api/suggestions/status` and auto-reconnects if a job is in progress.
- `"pending"` and `"ready"` statuses are transient in-memory — lost on server restart.

### 8.3 Settings page (`/settings`)

Form with two sections: Paperless-NGX connection and suggestion provider config. Token shown as `***`; only updated on submit if changed.

---

## 9. External integrations

### 9.1 Paperless-NGX

- **Auth**: `Authorization: Token <paperless_token>` header; omitted if token is empty.
- **Redirects**: `follow_redirects=True` on all httpx clients (Paperless may redirect HTTP→HTTPS).
- **Pagination**: follows `next` URL until exhausted.
- **Endpoints used**:
  - `GET /api/documents/` — all documents (includes `content`, `correspondent`, `document_type`, `created`, `custom_fields`)
  - `GET /api/tags/` — all tags (includes `matching_algorithm` for manual/auto detection)
  - `GET /api/correspondents/` — resolve IDs → names
  - `GET /api/document_types/` — resolve IDs → names
  - `GET /api/custom_fields/` — resolve / create the three custom fields
  - `POST /api/custom_fields/` — create missing custom fields
  - `POST /api/tags/` — create new tags
  - `PATCH /api/documents/{id}/` — update document
  - `GET /api/documents/{id}/thumb/` — thumbnail proxy
  - `GET /api/documents/{id}/preview/` — PDF proxy

### 9.2 Ollama

- **Client**: `instructor.from_openai(AsyncOpenAI(base_url=f"{ollama_url}/v1", api_key="ollama"))`
- **Temperature**: `ollama_temperature` setting (default `0.0`).
- **Timeout**: 60 seconds per document.
- **`/no_think` prefix**: suppresses extended reasoning mode in qwen3 models.

### 9.3 Language detection

- **Library**: `langdetect` (Python, no model call).
- Runs on first 500 characters of `content`.
- Returns language name string or `"unknown"` on failure.

---

## 10. Deployment

- Docker image based on `python:3.12-slim`.
- Host port `8200`, container port `8080`.
- `./config` bind-mounted at `/app/config`; holds `settings.json`. Any deployment must mount a volume there or settings are lost on container recreation.
- When run in the same Compose project as Paperless-NGX, add `depends_on: paperless-ngx: condition: service_healthy`. The app also recovers on its own if Paperless comes up later.
- `stop_grace_period: 70s` — allows in-flight Ollama requests (60 s timeout) to be cancelled before Docker sends SIGKILL.
- `restart: unless-stopped`.

**What persists across restarts:**
- Settings (`config/settings.json`)
- LLM quality scores, suggestion status `"done"`, and review dates (Paperless custom fields)

**What does not persist:**
- `"pending"` and `"ready"` suggestion statuses (transient in-memory)
- Per-field apply/reject state (client-side memory only; lost on page refresh)
- The global suggestion queue (lost on restart; queue must be re-submitted)

---

## 11. Resolved decisions

1. **State storage** — document state (quality, status, review date) stored in Paperless-NGX custom fields rather than a local database. State is visible inside Paperless and survives tool reinstallation.
2. **Tag protection** — tags with `matching_algorithm = 0` (manual/workflow tags) are never suggested for removal. They are listed in the prompt as "protected" and excluded from the diff UI.
3. **Single global queue** — multiple "Generate suggestions" clicks add to the same job rather than creating separate jobs. Deduplication prevents the same document being queued twice.
4. **No-op suppression** — correspondent and document type suggestions that match the current value are discarded server-side before returning to the UI.
5. **Paperless token security** — token masked in `GET /api/settings`; plaintext storage in `settings.json` accepted; network-level restriction is the user's responsibility.

---

## 12. Future nice-to-haves

1. **App-level authentication** — password gating access to the UI.
2. **Queue persistence** — survive server restarts without losing the suggestion queue.
3. **Bulk tag editing** — apply tag changes across multiple documents simultaneously.
