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
id        int
title     string
tags      string[]   — resolved tag names (not IDs)
quality   int        — 0–100, see §5
```

### 3.3 Suggestion

```
id                int     — document ID
suggested_title   string
suggested_tags    string[]
reason            string
```

### 3.4 ApplyItem

```
id      int
title   string
tags    string[]
```

---

## 4. API endpoints

All endpoints are served by FastAPI. Request and response bodies are JSON.

### 4.1 `GET /`
Returns the main page (HTML).

### 4.2 `GET /settings`
Returns the settings page (HTML).

### 4.3 `GET /api/settings`
Returns the current settings object (all fields).

**Response**
```json
{
  "paperless_base_url": "http://...",
  "paperless_token": "...",
  "ollama_base_url": "http://...",
  "ollama_model": "llama3.1",
  "suggestion_provider": "ollama"
}
```

### 4.4 `POST /api/settings`
Saves new settings to `app/settings.json`.

**Request body**: same shape as `GET /api/settings` response.

**Response**
```json
{ "status": "ok" }
```

### 4.5 `GET /api/entries?sort_by=<name|tags|quality>`
Fetches all documents from Paperless-NGX, resolves tag IDs to names, computes quality scores, and returns a sorted list.

**Query parameter**: `sort_by` — `name` (default, A→Z), `tags` (descending), `quality` (ascending, worst first).

**Response**: array of Entry objects (see §3.2).

**Error**: `502` if Paperless-NGX is unreachable or returns an error.

### 4.6 `POST /api/suggestions`
Generates metadata suggestions for the given document IDs.

**Request body**
```json
{ "ids": [1, 2, 3] }
```

**Response**: array of Suggestion objects (see §3.3).

**Behaviour**:
- Fetches fresh document data and tag map from Paperless-NGX.
- For each ID, calls the configured suggestion provider.
- If provider is `"ollama"` and the Ollama call fails, falls back to heuristic silently.
- Documents not found in Paperless-NGX are skipped (no error).

**Error**: `502` if Paperless-NGX is unreachable.

### 4.7 `POST /api/apply`
Applies a list of approved changes back to Paperless-NGX.

**Request body**
```json
{
  "entries": [
    { "id": 1, "title": "New Title", "tags": ["tag-a", "tag-b"] }
  ]
}
```

**Behaviour**:
- Fetches the current tag map from Paperless-NGX to resolve tag names → IDs.
- Tags not found in Paperless-NGX are silently dropped.
- Issues a `PATCH` request per document.

**Response**
```json
{ "status": "ok", "updated": 3 }
```

**Error**: `502` if any individual PATCH request fails.

---

## 5. Quality scoring

Score is an integer in the range 0–100, computed locally from title and tags.

| Criterion | Points |
|---|---|
| Title ≥ 8 characters | 50 |
| Title 3–7 characters | 25 |
| Title < 3 characters | 0 |
| Tags: 15 × tag count, capped at 3 tags | 0–45 |
| Title contains at least one uppercase letter | 5 |

> **Open question**: Are these thresholds and weights correct? Should additional signals be included (e.g. document has a date, title contains only digits/underscores)?

---

## 6. Suggestion providers

### 6.1 Ollama

- Calls `POST {ollama_base_url}/api/generate` with `stream: false` and `format: "json"`.
- Prompt instructs the model to return `{ suggested_title, suggested_tags, reason }`.
- Falls back to heuristic on any error (network, non-200, malformed JSON).

### 6.2 Heuristic

Local, offline. No external calls.

- **Title**: capitalises each word, replaces underscores with spaces.
- **Tags**: returns the document's existing tags unchanged. If none, returns `["review-needed"]`.
- **Reason**: fixed string `"Title normalized and ensured at least one meaningful tag."`

> **Open question**: The heuristic tag logic is not very useful — it suggests whatever tags already exist. Should it instead suggest tags based on title keywords, or pull from a fixed vocabulary of common tags?

---

## 7. Frontend pages

### 7.1 Main page (`/`)

**Layout**
- Header with app name and link to Settings.
- Toolbar: sort selector (`name` / `tags` / `quality`), Refresh button, Generate suggestions button.
- Document table: checkbox | Title | Tags | Quality score.
- Suggestions section: cards (one per document), Apply approved changes button.

**Behaviour**
- On load: fetches and renders the document list.
- Sort selector change: re-fetches with new sort parameter.
- Refresh button: re-fetches document list.
- Generate suggestions: POSTs selected IDs, renders suggestion cards.
- Each card: approve checkbox (checked by default), editable title input, editable tags input (comma-separated), reason text.
- Apply: collects approved cards, POSTs to `/api/apply`, shows success/error alert, refreshes document list.

**Error handling**
- Failed `GET /api/entries`: displays inline error message in the table.
- Failed `POST /api/suggestions`: displays alert.
- Failed `POST /api/apply`: displays alert.

### 7.2 Settings page (`/settings`)

**Layout**
- Header with page title and Back link.
- Form: one field per setting (see §3.1), Save button.
- Status line below form.

**Behaviour**
- On load: fetches current settings and populates form fields.
- On submit: POSTs form values, shows "Settings saved." or error.

---

## 8. External integrations

### 8.1 Paperless-NGX

- **Auth**: `Authorization: Token <paperless_token>` header. Omitted if token is empty.
- **Pagination**: follows `next` URL in paginated responses until exhausted.
- **Endpoints used**:
  - `GET /api/documents/` — fetch all documents
  - `GET /api/tags/` — fetch all tags
  - `PATCH /api/documents/{id}/` — update a document

### 8.2 Ollama

- **Endpoint**: `POST /api/generate`
- **Timeout**: 60 seconds (longer than Paperless calls due to inference time).
- **Expected response field**: `response` (string containing JSON).

---

## 9. Deployment

- Docker image based on `python:3.12-slim`.
- Single `paperless-cleaner` service, port `8080`.
- `app/settings.json` bind-mounted from host for persistence. **Must be created (`touch app/settings.json`) before first `docker compose up`.**
- Auto-restart unless stopped.

---

## 10. Open questions / future considerations

1. **Batch Ollama calls**: currently one HTTP round-trip per document. Could be parallelised with `asyncio.gather`.
2. **Tag creation**: if an Ollama-suggested tag doesn't exist in Paperless-NGX, it is silently dropped. Should the app offer to create missing tags?
3. **Heuristic tag logic**: see §6.2 — currently not useful.
4. **Quality score tuning**: see §5 — are current thresholds appropriate?
5. **Loading states**: the UI has no spinner or disabled state during API calls; rapid clicks could cause race conditions.
6. **Paperless-NGX token security**: the token is stored in plaintext in `settings.json` and returned by `GET /api/settings`. Access to the app should be restricted at the network level.
7. **Filtering**: no way to filter by tag, date range, or quality threshold — only sorting is supported.
8. **Select all**: no "select all" checkbox in the document table.
