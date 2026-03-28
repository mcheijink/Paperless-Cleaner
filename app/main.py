from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from starlette.requests import Request

BASE_DIR = Path(__file__).resolve().parent
SETTINGS_FILE = BASE_DIR / "settings.json"


@dataclass
class AppSettings:
    paperless_base_url: str = "http://paperless-ngx:8000"
    paperless_token: str = ""
    ollama_base_url: str = "http://ollama:11434"
    ollama_model: str = "llama3.1"
    suggestion_provider: str = "ollama"


class SuggestRequest(BaseModel):
    ids: list[int]


class Suggestion(BaseModel):
    id: int
    suggested_title: str
    suggested_tags: list[str]
    reason: str


class ApplyItem(BaseModel):
    id: int
    title: str
    tags: list[str] = Field(default_factory=list)


class ApplyRequest(BaseModel):
    entries: list[ApplyItem]


class SettingsRequest(BaseModel):
    paperless_base_url: str
    paperless_token: str
    ollama_base_url: str
    ollama_model: str
    suggestion_provider: str


app = FastAPI(title="Paperless Cleaner")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def load_settings() -> AppSettings:
    if SETTINGS_FILE.exists():
        raw = json.loads(SETTINGS_FILE.read_text())
        return AppSettings(**raw)
    settings = AppSettings(
        paperless_base_url=os.getenv("PAPERLESS_BASE_URL", "http://paperless-ngx:8000"),
        paperless_token=os.getenv("PAPERLESS_TOKEN", ""),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://ollama:11434"),
        ollama_model=os.getenv("OLLAMA_MODEL", "llama3.1"),
        suggestion_provider=os.getenv("SUGGESTION_PROVIDER", "ollama"),
    )
    save_settings(settings)
    return settings


def save_settings(settings: AppSettings) -> None:
    SETTINGS_FILE.write_text(json.dumps(settings.__dict__, indent=2))


def score_quality(entry: dict[str, Any]) -> int:
    title = entry.get("title", "").strip()
    tags = entry.get("tags", [])
    score = 0
    if len(title) >= 8:
        score += 50
    elif len(title) >= 3:
        score += 25
    score += min(len(tags) * 15, 45)
    if title and title.lower() != title:
        score += 5
    return min(score, 100)


async def get_documents(settings: AppSettings) -> list[dict[str, Any]]:
    headers = {"Authorization": f"Token {settings.paperless_token}"} if settings.paperless_token else {}
    url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/"
    docs: list[dict[str, Any]] = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        while url:
            response = await client.get(url, headers=headers)
            if response.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Paperless request failed: {response.text}")
            payload = response.json()
            docs.extend(payload.get("results", []))
            url = payload.get("next")

    return docs


async def get_tag_map(settings: AppSettings) -> dict[int, str]:
    headers = {"Authorization": f"Token {settings.paperless_token}"} if settings.paperless_token else {}
    url = f"{settings.paperless_base_url.rstrip('/')}/api/tags/"
    tags: dict[int, str] = {}

    async with httpx.AsyncClient(timeout=30.0) as client:
        while url:
            response = await client.get(url, headers=headers)
            if response.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Paperless tags request failed: {response.text}")
            payload = response.json()
            for tag in payload.get("results", []):
                tags[tag["id"]] = tag["name"]
            url = payload.get("next")

    return tags


def heuristic_suggestion(entry: dict[str, Any], tag_names: list[str]) -> Suggestion:
    original = entry.get("title", "Untitled")
    cleaned = " ".join(part.capitalize() for part in original.replace("_", " ").split())
    cleaned = cleaned if cleaned else "Untitled Document"
    suggestions = sorted(set(tag_names))
    if not suggestions:
        suggestions = ["review-needed"]
    reason = "Title normalized and ensured at least one meaningful tag."
    return Suggestion(id=entry["id"], suggested_title=cleaned, suggested_tags=suggestions, reason=reason)


async def ollama_suggestion(settings: AppSettings, entry: dict[str, Any], tag_names: list[str]) -> Suggestion:
    prompt = (
        "You improve metadata quality for scanned documents. Return JSON object with "
        "keys suggested_title (string), suggested_tags (array of strings), reason (string). "
        f"Input title: {entry.get('title', '')}. Existing tags: {', '.join(tag_names) or 'none'}."
    )
    payload = {
        "model": settings.ollama_model,
        "prompt": prompt,
        "stream": False,
        "format": "json",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{settings.ollama_base_url.rstrip('/')}/api/generate", json=payload)
        if resp.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Ollama request failed: {resp.text}")
        response_json = resp.json()
        model_out = json.loads(response_json.get("response", "{}"))

    return Suggestion(
        id=entry["id"],
        suggested_title=model_out.get("suggested_title", entry.get("title", "Untitled")),
        suggested_tags=model_out.get("suggested_tags", tag_names),
        reason=model_out.get("reason", "Suggested by Ollama model."),
    )


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("settings.html", {"request": request})


@app.get("/api/settings")
async def get_settings() -> dict[str, Any]:
    return load_settings().__dict__


@app.post("/api/settings")
async def update_settings(payload: SettingsRequest) -> dict[str, Any]:
    settings = AppSettings(**payload.model_dump())
    save_settings(settings)
    return {"status": "ok"}


@app.get("/api/entries")
async def entries(sort_by: str = Query("name", pattern="^(name|tags|quality)$")) -> list[dict[str, Any]]:
    settings = load_settings()
    tag_map = await get_tag_map(settings)
    docs = await get_documents(settings)

    enriched = []
    for d in docs:
        names = [tag_map.get(tag_id, str(tag_id)) for tag_id in d.get("tags", [])]
        enriched.append(
            {
                "id": d["id"],
                "title": d.get("title", "Untitled"),
                "tags": names,
                "quality": score_quality({"title": d.get("title", ""), "tags": names}),
            }
        )

    if sort_by == "name":
        enriched.sort(key=lambda x: x["title"].lower())
    elif sort_by == "tags":
        enriched.sort(key=lambda x: len(x["tags"]), reverse=True)
    else:
        enriched.sort(key=lambda x: x["quality"])

    return enriched


@app.post("/api/suggestions")
async def suggestions(payload: SuggestRequest) -> list[Suggestion]:
    settings = load_settings()
    tag_map = await get_tag_map(settings)
    docs = await get_documents(settings)
    docs_by_id = {doc["id"]: doc for doc in docs}

    result: list[Suggestion] = []
    for doc_id in payload.ids:
        doc = docs_by_id.get(doc_id)
        if not doc:
            continue
        tag_names = [tag_map.get(tag_id, str(tag_id)) for tag_id in doc.get("tags", [])]
        if settings.suggestion_provider == "ollama":
            try:
                item = await ollama_suggestion(settings, doc, tag_names)
            except Exception:
                item = heuristic_suggestion(doc, tag_names)
        else:
            item = heuristic_suggestion(doc, tag_names)
        result.append(item)
    return result


@app.post("/api/apply")
async def apply_changes(payload: ApplyRequest) -> dict[str, Any]:
    settings = load_settings()
    auth_headers = {"Authorization": f"Token {settings.paperless_token}"} if settings.paperless_token else {}
    headers = {**auth_headers, "Content-Type": "application/json"}
    tag_map = await get_tag_map(settings)
    inverse_tag_map = {v.lower(): k for k, v in tag_map.items()}

    async with httpx.AsyncClient(timeout=30.0) as client:
        for entry in payload.entries:
            tag_ids = [inverse_tag_map[tag.lower()] for tag in entry.tags if tag.lower() in inverse_tag_map]
            url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/{entry.id}/"
            patch_payload = {"title": entry.title, "tags": tag_ids}
            response = await client.patch(url, headers=headers, json=patch_payload)
            if response.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Apply failed for {entry.id}: {response.text}")

    return {"status": "ok", "updated": len(payload.entries)}
