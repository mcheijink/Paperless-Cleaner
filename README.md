# Paperless Cleaner

A web application for reviewing and improving document metadata quality in [Paperless-NGX](https://docs.paperless-ngx.com/). It surfaces low-quality documents, generates title and tag suggestions (via Ollama or a local heuristic), and lets you review and apply changes in bulk.

## Features

- List all documents from Paperless-NGX, sortable by name, tag count, or quality score
- Quality scoring algorithm to surface documents that need attention
- Select one or more documents for bulk metadata improvement
- Generate title and tag suggestions using Ollama (local LLM) or a built-in heuristic
- Review suggestions in a card UI: approve, reject, or edit before applying
- Push accepted changes back to Paperless-NGX via its API
- Settings page for all connection and model parameters

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/)
- A running [Paperless-NGX](https://docs.paperless-ngx.com/) instance with an API token
- (Optional) A running [Ollama](https://ollama.com/) instance for AI-powered suggestions

## Quick start (Docker)

1. Create the settings file (required before first run):

   ```bash
   touch app/settings.json
   ```

2. Start the container:

   ```bash
   docker compose up --build
   ```

3. Open `http://localhost:8080`, go to **Settings**, and configure your Paperless-NGX connection.

> **Note:** The `app/settings.json` file must exist on the host before running `docker compose up`. If it is missing, Docker will create a directory at that path instead of a file, breaking settings persistence.

## Configuration

Open `/settings` and configure the following fields. Settings are saved to `app/settings.json` and take effect immediately without a restart.

| Field | Description | Default |
|---|---|---|
| `Paperless Base URL` | URL of your Paperless-NGX instance | `http://paperless-ngx:8000` |
| `Paperless API Token` | API token from Paperless-NGX | _(empty)_ |
| `Ollama Base URL` | URL of your Ollama instance | `http://ollama:11434` |
| `Ollama Model` | Model name to use for suggestions | `llama3.1` |
| `Suggestion Provider` | `ollama` or `heuristic` | `ollama` |

On first start, settings can also be seeded via environment variables: `PAPERLESS_BASE_URL`, `PAPERLESS_TOKEN`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `SUGGESTION_PROVIDER`.

## Quality score

Each document is assigned a score from 0–100 based on:

- **Title length** — up to 50 points (25 for ≥3 chars, 50 for ≥8 chars)
- **Tag count** — 15 points per tag, up to 45 points
- **Capitalisation** — 5 points if the title is not all-lowercase

Documents with low scores are shown first when sorting by **Quality**.

## Suggestion providers

### Ollama

Sends document metadata to the configured Ollama model via `/api/generate` and expects a JSON response with `suggested_title`, `suggested_tags`, and `reason`. If the Ollama call fails for any reason, the app automatically falls back to the heuristic provider.

### Heuristic

A local, offline fallback. Normalises the title by capitalising each word and replacing underscores with spaces. Suggests the document's existing tags (or `review-needed` if none exist).

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

## Project structure

```
app/
  main.py           # FastAPI backend — API routes and Paperless/Ollama integration
  static/
    app.js          # Main page logic (document list, suggestions, apply)
    settings.js     # Settings page logic
    style.css       # Dark-theme stylesheet
  templates/
    index.html      # Main page template
    settings.html   # Settings page template
Dockerfile
docker-compose.yml
requirements.txt
```
