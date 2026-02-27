# Paperless Cleaner

Paperless Cleaner is a modern web app for reviewing and improving Paperless-NGX metadata quality with support for Ollama-powered suggestions.

## Features

- List all Paperless documents and sort by name, number of tags, or computed quality score.
- Select one or many entries for metadata improvement.
- Generate automatic title + tag suggestions.
- Configure suggestion provider (`ollama` or local heuristic).
- Review suggestions in bulk: approve, deny (uncheck), or alter title/tags before applying.
- Push accepted changes back to Paperless-NGX via API.
- Settings page for Paperless and Ollama connection/model parameters.

## Quick start (Docker)

```bash
docker compose up --build
```

Then open `http://localhost:8080`.

## Settings

Open `/settings` and configure:

- `Paperless Base URL` (e.g. `http://paperless-ngx:8000`)
- `Paperless API Token`
- `Ollama Base URL` (e.g. `http://ollama:11434`)
- `Ollama Model` (e.g. `llama3.1`)
- `Suggestion Provider` (`ollama` or `heuristic`)

Settings are stored in `app/settings.json`.

## Ollama support

If provider is set to `ollama`, suggestions are generated with Ollama `/api/generate` and expected as JSON.
If Ollama fails, the app automatically falls back to heuristic suggestions.

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```
