# Paperless Cleaner

A self-hosted web application that sits alongside [Paperless-NGX](https://docs.paperless-ngx.com/) and helps you improve document metadata quality — titles, tags, correspondents, and document types — through quality scoring, LLM-powered suggestions, and a keyboard-driven review workflow.

## Features

- Lists all documents from Paperless-NGX with heuristic and LLM quality scores
- Column-level filtering and sorting (Excel-style dropdown per column)
- Generates title, tag, correspondent, and document type suggestions using Ollama (local LLM) or a built-in heuristic
- Suggestions run in a persistent background queue — add more documents at any time without waiting for the current batch to finish
- Modal review pane with thumbnail, per-field apply/reject, and tag diff (additions in green, removals in red)
- Manual tags (matching algorithm = none) are never suggested for removal
- Keyboard-driven review: `A` apply & next, `R` reject & next, `←`/`→` navigate
- Pushes accepted changes to Paperless-NGX via its REST API
- Stores LLM quality scores, suggestion status, and review dates as Paperless-NGX **custom fields** — visible inside Paperless itself
- Settings page for all connection and model parameters; token masked in API responses

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/)
- A running [Paperless-NGX](https://docs.paperless-ngx.com/) instance with an API token
- (Optional) A running [Ollama](https://ollama.com/) instance for AI-powered suggestions

## Quick start

1. Settings are stored in `config/settings.json`, in the `./config` directory that `docker-compose.yml` mounts at `/app/config`. Docker creates the directory on first run — nothing to prepare. When you deploy the image elsewhere, mount a volume at `/app/config`, otherwise settings (including the API token) are lost whenever the container is recreated.

2. Start the container:

   ```bash
   docker compose up --build -d
   ```

3. Open `http://localhost:8200`, go to **Settings**, and configure your Paperless-NGX URL and API token.

On first start the app auto-creates three Paperless-NGX custom fields: **LLM quality**, **Suggestion status**, and **Metadata reviewed**.

## Configuration

Open `/settings` and fill in the fields below. Settings are saved to `config/settings.json` and take effect immediately without a restart. They can also be seeded from environment variables on first run.

| Field | Description | Default | Env var |
|---|---|---|---|
| `Paperless Base URL` | URL of your Paperless-NGX instance | `http://paperless-ngx:8000` | `PAPERLESS_BASE_URL` |
| `Paperless API Token` | API token from Paperless-NGX admin | _(empty)_ | `PAPERLESS_TOKEN` |
| `Ollama Base URL` | URL of your Ollama instance | `http://ollama:11434` | `OLLAMA_BASE_URL` |
| `Ollama Model` | Model name to use for suggestions | `llama3.1` | `OLLAMA_MODEL` |
| `Suggestion Provider` | `ollama` or `heuristic` | `ollama` | `SUGGESTION_PROVIDER` |
| `Temperature` | Ollama sampling temperature | `0.0` | `OLLAMA_TEMPERATURE` |
| `Confidence discount` | Subtracted from LLM confidence scores | `0.2` | `CONFIDENCE_DISCOUNT` |
| `Few-shot min documents` | Min reviewed docs before library examples are used | `5` | `FEW_SHOT_MIN_DOCUMENTS` |

**Recommended Ollama model**: `qwen3:8b` (fast, good structured output). Use the `/no_think` directive or set temperature to 0 to suppress long reasoning chains.

## Workflow

1. **Refresh** — loads all documents and quality scores.
2. **Select** — tick checkboxes, or use **Select 25 worst unreviewed**. Ticking only selects; it never writes anything.
3. **Generate suggestions** — queues documents for LLM processing. The progress bar shows ETA and per-document timing. Click the bar to see the full queue. You can add more documents while the queue is running.
4. **Review N suggestions** — appears when results are ready and opens the review pane on the first one. Use **Apply & Next →** or **Reject & Next →** (or keyboard shortcuts) to move through the queue; the header shows "3 of 8 to review". Every Apply writes to Paperless-NGX immediately and offers **Undo**.
5. **Show suggestions in table** — optional toggle that adds suggestion columns with per-field ✓ / ✕.
6. **Accept all suggestions for N selected** — bulk shortcut that writes every undecided suggestion of the ticked documents, after a confirmation.

The line above the toolbar always shows what is loaded, how many documents are waiting for review, and how many are queued. If review state cannot be read from Paperless, a warning banner says so instead of silently showing every document as unreviewed.

## Quality scores

Three complementary scores per document:

| Score | Source | Range | Description |
|---|---|---|---|
| `quality` | Heuristic (local) | 0–100 | Word count, casing, penalty for filename-like titles |
| `llm_quality` | LLM (per run) | 0–100 | Semantic quality; `null` until LLM has been run |
| `completeness` | Heuristic (local) | 0–100 | 20 pts each for: title, tags, correspondent, doc type, date |

When sorting by **Quality**, `llm_quality` is used if available, otherwise `heuristic_quality`.

## Suggestion providers

### Ollama

Uses the [Instructor](https://github.com/jxnl/instructor) library with Ollama's OpenAI-compatible endpoint for schema-enforced structured output. Language is auto-detected from OCR content (via `langdetect`) and passed to the model so titles are written in the document's own language.

The model is asked to suggest a 3–6 word sentence-case title, and optionally a correspondent, document type, and tags — all constrained to values that already exist in Paperless-NGX. New tags can be suggested and created on apply.

Falls back to the heuristic provider on any failure; affected rows show a ⚠️ indicator.

### Heuristic

Local, offline. Capitalises each word and replaces underscores with spaces. Does not suggest correspondent, document type, or tag changes.

## Keyboard shortcuts (review pane)

| Key | Action |
|---|---|
| `A` | Apply all remaining suggestions & go to next |
| `R` | Reject all remaining & go to next |
| `→` / `L` | Next document (without acting) |
| `←` / `H` | Previous document (without acting) |
| `Esc` | Close pane |

The **?** button in the header opens a full help overlay.

## Development

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

## Project structure

```
app/
  main.py           # FastAPI backend — API routes, Paperless/Ollama integration, background queue
  static/
    app.js          # Main page — document list, filtering, suggestions, review pane
    settings.js     # Settings page
    style.css       # Dark-theme stylesheet
  templates/
    index.html      # Main page template
    settings.html   # Settings page template
Dockerfile
docker-compose.yml  # Exposes port 8200 → container 8080
requirements.txt
```

## Security notes

- `config/settings.json` contains your Paperless API token. `config/` is gitignored and excluded from the Docker build context — never commit it.
- The token is masked (`***`) in all API responses to the browser.
- The app is designed for trusted local network use. There is no built-in authentication.
