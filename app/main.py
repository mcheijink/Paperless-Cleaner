from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import instructor
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from starlette.requests import Request

try:
    from langdetect import detect as _langdetect
    from langdetect.lang_detect_exception import LangDetectException
except ImportError:
    _langdetect = None
    LangDetectException = Exception

try:
    import ollama as _ollama_client
except ImportError:
    _ollama_client = None

BASE_DIR = Path(__file__).resolve().parent
SETTINGS_FILE = BASE_DIR / "settings.json"

# ---------------------------------------------------------------------------
# Language name mapping (ISO 639-1 → English name)
# ---------------------------------------------------------------------------
_LANG_NAMES: dict[str, str] = {
    "af": "Afrikaans", "ar": "Arabic", "bg": "Bulgarian", "bn": "Bengali",
    "ca": "Catalan", "cs": "Czech", "cy": "Welsh", "da": "Danish",
    "de": "German", "el": "Greek", "en": "English", "es": "Spanish",
    "et": "Estonian", "fa": "Persian", "fi": "Finnish", "fr": "French",
    "gu": "Gujarati", "he": "Hebrew", "hi": "Hindi", "hr": "Croatian",
    "hu": "Hungarian", "id": "Indonesian", "it": "Italian", "ja": "Japanese",
    "kn": "Kannada", "ko": "Korean", "lt": "Lithuanian", "lv": "Latvian",
    "mk": "Macedonian", "ml": "Malayalam", "mr": "Marathi", "ne": "Nepali",
    "nl": "Dutch", "no": "Norwegian", "pa": "Punjabi", "pl": "Polish",
    "pt": "Portuguese", "ro": "Romanian", "ru": "Russian", "sk": "Slovak",
    "sl": "Slovenian", "so": "Somali", "sq": "Albanian", "sv": "Swedish",
    "sw": "Swahili", "ta": "Tamil", "te": "Telugu", "th": "Thai",
    "tl": "Filipino", "tr": "Turkish", "uk": "Ukrainian", "ur": "Urdu",
    "vi": "Vietnamese", "zh-cn": "Chinese", "zh-tw": "Chinese",
}

# ---------------------------------------------------------------------------
# Built-in few-shot examples (used when user library is too small)
# ---------------------------------------------------------------------------
_BUILTIN_EXAMPLES = [
    {
        "title": "Electricity bill January",
        "correspondent": "Energy provider",
        "document_type": "Invoice",
        "tags": ["utilities", "bills"],
        "content_snippet": "Monthly electricity usage statement. Period: January 2024. Total due: €87.50.",
        "suggested_title": "Electricity bill January",
        "suggested_tags": ["utilities", "bills"],
        "reason": "Title is already clear and concise.",
    },
    {
        "title": "scan0047",
        "correspondent": None,
        "document_type": None,
        "tags": [],
        "content_snippet": "ADAC Autoversicherung. Versicherungsschein Nr. AD-9512372748. Gültig ab 01.01.2026.",
        "suggested_title": "Kfz versicherungsschein renewal",
        "suggested_tags": ["insurance", "car"],
        "reason": "Scanner filename replaced with descriptive sentence-case title.",
    },
    {
        "title": "20231015123456",
        "correspondent": "Employer GmbH",
        "document_type": "Letter",
        "tags": ["work"],
        "content_snippet": "Gehaltsabrechnung Oktober 2023. Bruttolohn: 3.500 EUR.",
        "suggested_title": "Salary statement October",
        "suggested_tags": ["work", "salary"],
        "reason": "Timestamp filename replaced; reference numbers omitted.",
    },
]


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

class DocumentState(BaseModel):
    llm_quality: int | None = None
    suggestion_status: str = "none"
    fallback_used: bool = False


class AppSettings(BaseModel):
    paperless_base_url: str = "http://paperless-ngx:8000"
    paperless_token: str = ""
    ollama_base_url: str = "http://ollama:11434"
    ollama_model: str = "llama3.1"
    suggestion_provider: str = "ollama"
    ollama_temperature: float = 0.0
    confidence_discount: float = 0.2
    few_shot_min_documents: int = 5
    document_state: dict[str, DocumentState] = Field(default_factory=dict)


class SuggestRequest(BaseModel):
    ids: list[int]


class SuggestedTag(BaseModel):
    name: str
    confidence: float
    is_new: bool = False


class SuggestedField(BaseModel):
    name: str
    confidence: float


class Suggestion(BaseModel):
    id: int
    title_quality: int | None = None
    detected_language: str | None = None
    reasoning: str | None = None
    suggested_title: str
    suggested_correspondent: SuggestedField | None = None
    suggested_document_type: SuggestedField | None = None
    suggested_tags: list[SuggestedTag] = Field(default_factory=list)
    reason: str
    fallback_used: bool = False


class ApplyItem(BaseModel):
    id: int
    title: str | None = None
    correspondent: str | None = None
    document_type: str | None = None
    tags: list[str] | None = None
    tags_new: list[str] = Field(default_factory=list)


class ApplyRequest(BaseModel):
    entries: list[ApplyItem]


class SettingsRequest(BaseModel):
    paperless_base_url: str
    paperless_token: str
    ollama_base_url: str
    ollama_model: str
    suggestion_provider: str
    ollama_temperature: float = 0.0
    confidence_discount: float = 0.2
    few_shot_min_documents: int = 5


# Instructor response model
class _OllamaTagOut(BaseModel):
    name: str
    confidence: float = 0.5


class _OllamaFieldOut(BaseModel):
    name: str
    confidence: float = 0.5


class _OllamaResponse(BaseModel):
    reasoning: str = ""
    title_quality: int = 50
    suggested_title: str
    suggested_correspondent: _OllamaFieldOut | None = None
    suggested_document_type: _OllamaFieldOut | None = None
    suggested_tags: list[_OllamaTagOut] = Field(default_factory=list)
    reason: str = ""


# ---------------------------------------------------------------------------
# Job state
# ---------------------------------------------------------------------------

class JobState(BaseModel):
    total: int
    completed: int = 0
    results: list[Suggestion] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# App + task queue
# ---------------------------------------------------------------------------

app = FastAPI(title="Paperless Cleaner")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

_suggestion_queue: asyncio.Queue = asyncio.Queue()
_jobs: dict[str, JobState] = {}
_worker_task: asyncio.Task | None = None
_current_ollama_task: asyncio.Task | None = None


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def load_settings() -> AppSettings:
    if SETTINGS_FILE.exists():
        raw = json.loads(SETTINGS_FILE.read_text())
        # Deserialise document_state sub-dict
        doc_state_raw = raw.pop("document_state", {})
        settings = AppSettings(**raw)
        settings.document_state = {
            k: DocumentState(**v) if isinstance(v, dict) else v
            for k, v in doc_state_raw.items()
        }
        return settings
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
    data = settings.model_dump()
    # Serialise document_state properly
    data["document_state"] = {
        k: v.model_dump() if isinstance(v, DocumentState) else v
        for k, v in settings.document_state.items()
    }
    SETTINGS_FILE.write_text(json.dumps(data, indent=2))


# ---------------------------------------------------------------------------
# Paperless helpers
# ---------------------------------------------------------------------------

def _auth_headers(settings: AppSettings) -> dict[str, str]:
    if settings.paperless_token:
        return {"Authorization": f"Token {settings.paperless_token}"}
    return {}


async def _paginated_get(client: httpx.AsyncClient, url: str, headers: dict) -> list[dict]:
    results: list[dict] = []
    while url:
        resp = await client.get(url, headers=headers)
        if resp.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Paperless request failed: {resp.text}")
        payload = resp.json()
        results.extend(payload.get("results", []))
        url = payload.get("next") or ""
    return results


async def get_documents(settings: AppSettings) -> list[dict[str, Any]]:
    headers = _auth_headers(settings)
    url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/"
    async with httpx.AsyncClient(timeout=30.0) as client:
        return await _paginated_get(client, url, headers)


async def get_tag_map(settings: AppSettings) -> dict[int, str]:
    headers = _auth_headers(settings)
    url = f"{settings.paperless_base_url.rstrip('/')}/api/tags/"
    async with httpx.AsyncClient(timeout=30.0) as client:
        tags = await _paginated_get(client, url, headers)
    return {t["id"]: t["name"] for t in tags}


async def get_correspondent_map(settings: AppSettings) -> dict[int, str]:
    headers = _auth_headers(settings)
    url = f"{settings.paperless_base_url.rstrip('/')}/api/correspondents/"
    async with httpx.AsyncClient(timeout=30.0) as client:
        items = await _paginated_get(client, url, headers)
    return {c["id"]: c["name"] for c in items}


async def get_document_type_map(settings: AppSettings) -> dict[int, str]:
    headers = _auth_headers(settings)
    url = f"{settings.paperless_base_url.rstrip('/')}/api/document_types/"
    async with httpx.AsyncClient(timeout=30.0) as client:
        items = await _paginated_get(client, url, headers)
    return {d["id"]: d["name"] for d in items}


async def get_or_create_custom_field(settings: AppSettings, client: httpx.AsyncClient) -> int:
    headers = {**_auth_headers(settings), "Content-Type": "application/json"}
    url = f"{settings.paperless_base_url.rstrip('/')}/api/custom_fields/"
    fields = await _paginated_get(client, url, _auth_headers(settings))

    target_name = "Metadata reviewed"
    for f in fields:
        if f["name"].lower() == target_name.lower():
            if f.get("data_type") == "date":
                return f["id"]
            # Wrong type — use fallback name
            target_name = "Metadata reviewed (cleaner)"
            break

    # Check fallback name too
    for f in fields:
        if f["name"].lower() == target_name.lower():
            if f.get("data_type") == "date":
                return f["id"]

    # Create it
    resp = await client.post(url, headers=headers, json={"name": target_name, "data_type": "date"})
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Failed to create custom field: {resp.text}")
    return resp.json()["id"]


async def create_tag(settings: AppSettings, client: httpx.AsyncClient, name: str) -> int:
    headers = {**_auth_headers(settings), "Content-Type": "application/json"}
    url = f"{settings.paperless_base_url.rstrip('/')}/api/tags/"
    resp = await client.post(url, headers=headers, json={"name": name})
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Failed to create tag '{name}': {resp.text}")
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# Quality scoring
# ---------------------------------------------------------------------------

_FILENAME_RE = re.compile(r"(^scan\d+$|^doc_|^IMG_|^[0-9]+$|_.*_)", re.IGNORECASE)


def score_heuristic(title: str, tags: list[str]) -> int:
    words = title.strip().split()
    wc = len(words)

    if wc == 0:
        pts = 0
    elif wc == 1:
        pts = 15
    elif wc == 2:
        pts = 35
    elif 3 <= wc <= 6:
        pts = 60
    else:
        pts = 35

    # Casing
    if wc > 0:
        first = words[0]
        rest = words[1:]
        if first[0].isupper() and all(w.islower() for w in rest if w.isalpha()):
            pts += 15
        elif any(c.isupper() for c in title):
            pts += 5

    # Tags
    pts += min(len(tags) * 9, 27)

    # Penalties
    t = title.strip()
    if _FILENAME_RE.search(t) or ("_" in t and " " not in t):
        pts -= 30
    digit_ratio = sum(1 for c in t if c.isdigit()) / max(len(t), 1)
    if digit_ratio > 0.4:
        pts -= 20

    return max(0, min(pts, 100))


def score_completeness(title: str, tags: list[str], correspondent: str | None,
                       document_type: str | None, doc_date: str | None) -> int:
    score = 0
    if title and score_heuristic(title, []) > 0:
        score += 20
    if tags:
        score += 20
    if correspondent:
        score += 20
    if document_type:
        score += 20
    if doc_date:
        score += 20
    return score


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

def detect_language(text: str) -> str:
    if not text or _langdetect is None:
        return "unknown"
    try:
        code = _langdetect(text[:500])
        return _LANG_NAMES.get(code, code)
    except Exception:
        return "unknown"


# ---------------------------------------------------------------------------
# Suggestion providers
# ---------------------------------------------------------------------------

def heuristic_suggestion(entry: dict[str, Any], tag_names: list[str]) -> Suggestion:
    original = entry.get("title", "Untitled")
    cleaned = " ".join(part.capitalize() for part in original.replace("_", " ").split())
    cleaned = cleaned if cleaned else "Untitled Document"
    return Suggestion(
        id=entry["id"],
        suggested_title=cleaned,
        suggested_tags=[SuggestedTag(name=t, confidence=1.0, is_new=False) for t in tag_names],
        reason="Title normalized. Correspondent, document type, and tag suggestions require an LLM provider.",
    )


def _build_few_shot_section(settings: AppSettings, docs_by_id: dict[int, dict],
                             tag_map: dict[int, str], corr_map: dict[int, str],
                             dtype_map: dict[int, str]) -> str:
    done_ids = [
        int(doc_id)
        for doc_id, state in settings.document_state.items()
        if state.suggestion_status == "done" and not state.fallback_used
    ]

    examples_used: list[dict] = []
    if len(done_ids) >= settings.few_shot_min_documents:
        seen_types: set[str] = set()
        for doc_id in done_ids[:20]:
            doc = docs_by_id.get(doc_id)
            if not doc:
                continue
            dtype = dtype_map.get(doc.get("document_type") or 0, "")
            if dtype in seen_types:
                continue
            seen_types.add(dtype)
            tag_names = [tag_map.get(t, str(t)) for t in doc.get("tags", [])]
            corr = corr_map.get(doc.get("correspondent") or 0)
            examples_used.append({
                "title": doc.get("title", ""),
                "correspondent": corr,
                "document_type": dtype or None,
                "tags": tag_names,
                "content_snippet": (doc.get("content") or "")[:200],
                "suggested_title": doc.get("title", ""),
                "reason": "Reviewed by user.",
            })
            if len(examples_used) >= 3:
                break

    if not examples_used:
        examples_used = _BUILTIN_EXAMPLES[:3]

    lines = []
    for i, ex in enumerate(examples_used, 1):
        lines.append(f"Example {i}:")
        lines.append(f'  Input title: {ex["title"]}')
        lines.append(f'  Correspondent: {ex.get("correspondent") or "unknown"}')
        lines.append(f'  Document type: {ex.get("document_type") or "unknown"}')
        lines.append(f'  Tags: {", ".join(ex.get("tags", [])) or "none"}')
        lines.append(f'  Content: {ex.get("content_snippet", "")}')
        lines.append(f'  → suggested_title: {ex["suggested_title"]}')
        lines.append(f'  → reason: {ex.get("reason", "")}')
    return "\n".join(lines)


async def ollama_suggestion(
    settings: AppSettings,
    entry: dict[str, Any],
    tag_names: list[str],
    all_tags: list[str],
    corr_names: list[str],
    dtype_names: list[str],
    docs_by_id: dict[int, dict],
    tag_map: dict[int, str],
    corr_map: dict[int, str],
    dtype_map: dict[int, str],
) -> Suggestion:
    content = entry.get("content") or ""
    language = detect_language(content)

    corr_id = entry.get("correspondent")
    dtype_id = entry.get("document_type")
    current_corr = corr_map.get(corr_id, "unknown") if corr_id else "unknown"
    current_dtype = dtype_map.get(dtype_id, "unknown") if dtype_id else "unknown"
    doc_date = entry.get("created") or "unknown"

    few_shot = _build_few_shot_section(settings, docs_by_id, tag_map, corr_map, dtype_map)

    system_prompt = f"""## Output format
Respond with a single valid JSON object. No text outside the JSON.

## JSON schema
{{
  "reasoning": string,
  "title_quality": int (0-100),
  "suggested_title": string,
  "suggested_correspondent": {{"name": string, "confidence": float}} | null,
  "suggested_document_type": {{"name": string, "confidence": float}} | null,
  "suggested_tags": [{{"name": string, "confidence": float}}],
  "reason": string
}}

## Allowed values
Tags (select from this list only): {", ".join(all_tags) or "none"}
Correspondents (select from this list only): {", ".join(corr_names) or "none"}
Document types (select from this list only): {", ".join(dtype_names) or "none"}

## Examples
{few_shot}

## Rules
- Title must be sentence case (first word capitalised, rest lowercase) in {language}
- Title must be 3-6 words
- Title must describe the subject only — do not include the correspondent, document type, date, or reference numbers; these are stored separately
- Only suggest a correspondent, document type, or tag if it is in the lists above
- Set suggested_correspondent and suggested_document_type to null if the current value is already appropriate or you are not confident
- Confidence is 0.0-1.0; be conservative
- Do not invent new tags, correspondents, or document types

## Do not
- Include markdown, commentary, or any text outside the JSON
- Add fields not in the schema
- Translate the title; keep it in {language}"""

    user_message = f"""Current title: {entry.get("title", "")}
Correspondent: {current_corr}
Document type: {current_dtype}
Date: {doc_date}
Tags: {", ".join(tag_names) or "none"}
Content (first 500 chars): {content[:500]}"""

    if _ollama_client is None:
        raise RuntimeError("ollama package not installed")

    client = instructor.from_ollama(
        _ollama_client.AsyncClient(host=settings.ollama_base_url),
        mode=instructor.Mode.JSON,
    )

    response: _OllamaResponse = await asyncio.wait_for(
        client.chat.completions.create(
            model=settings.ollama_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            response_model=_OllamaResponse,
            options={"temperature": settings.ollama_temperature},
        ),
        timeout=60.0,
    )

    disc = settings.confidence_discount

    # Validate and build SuggestedTag list
    tag_map_lower = {v.lower(): v for v in all_tags}
    suggested_tags: list[SuggestedTag] = []
    for t in response.suggested_tags:
        name_lower = t.name.lower()
        if name_lower in tag_map_lower:
            suggested_tags.append(SuggestedTag(
                name=tag_map_lower[name_lower],
                confidence=max(0.0, t.confidence - disc),
                is_new=False,
            ))
        else:
            suggested_tags.append(SuggestedTag(
                name=t.name,
                confidence=max(0.0, t.confidence - disc),
                is_new=True,
            ))

    # Validate correspondent
    corr_map_lower = {v.lower(): v for v in corr_names}
    validated_corr: SuggestedField | None = None
    if response.suggested_correspondent:
        n = response.suggested_correspondent.name.lower()
        if n in corr_map_lower:
            validated_corr = SuggestedField(
                name=corr_map_lower[n],
                confidence=max(0.0, response.suggested_correspondent.confidence - disc),
            )

    # Validate document type
    dtype_map_lower = {v.lower(): v for v in dtype_names}
    validated_dtype: SuggestedField | None = None
    if response.suggested_document_type:
        n = response.suggested_document_type.name.lower()
        if n in dtype_map_lower:
            validated_dtype = SuggestedField(
                name=dtype_map_lower[n],
                confidence=max(0.0, response.suggested_document_type.confidence - disc),
            )

    # Validate title word count
    title = response.suggested_title
    word_count = len(title.strip().split())
    if not (1 <= word_count <= 10):
        title = entry.get("title", "Untitled")

    return Suggestion(
        id=entry["id"],
        title_quality=response.title_quality,
        detected_language=language,
        reasoning=response.reasoning or None,
        suggested_title=title,
        suggested_correspondent=validated_corr,
        suggested_document_type=validated_dtype,
        suggested_tags=suggested_tags,
        reason=response.reason or "Suggested by Ollama model.",
    )


# ---------------------------------------------------------------------------
# Background worker
# ---------------------------------------------------------------------------

async def _process_one(item: dict[str, Any]) -> None:
    global _current_ollama_task
    settings = item["settings"]
    entry = item["entry"]
    job_id = item["job_id"]
    tag_names = item["tag_names"]
    all_tags = item["all_tags"]
    corr_names = item["corr_names"]
    dtype_names = item["dtype_names"]
    docs_by_id = item["docs_by_id"]
    tag_map = item["tag_map"]
    corr_map = item["corr_map"]
    dtype_map = item["dtype_map"]

    fallback_used = False
    try:
        if settings.suggestion_provider == "ollama":
            coro = ollama_suggestion(
                settings, entry, tag_names, all_tags, corr_names, dtype_names,
                docs_by_id, tag_map, corr_map, dtype_map,
            )
            _current_ollama_task = asyncio.current_task()
            suggestion = await coro
            _current_ollama_task = None
        else:
            suggestion = heuristic_suggestion(entry, tag_names)
    except Exception:
        suggestion = heuristic_suggestion(entry, tag_names)
        suggestion.fallback_used = True
        fallback_used = True

    # Persist llm_quality + status
    settings_fresh = load_settings()
    doc_id_str = str(entry["id"])
    existing = settings_fresh.document_state.get(doc_id_str, DocumentState())
    existing.suggestion_status = "ready"
    existing.fallback_used = fallback_used
    if suggestion.title_quality is not None:
        existing.llm_quality = suggestion.title_quality
    settings_fresh.document_state[doc_id_str] = existing
    save_settings(settings_fresh)

    job = _jobs.get(job_id)
    if job:
        job.results.append(suggestion)
        job.completed += 1


async def _worker() -> None:
    while True:
        item = await _suggestion_queue.get()
        if item is None:
            break
        try:
            await _process_one(item)
        except asyncio.CancelledError:
            break
        except Exception:
            pass
        finally:
            _suggestion_queue.task_done()


@app.on_event("startup")
async def _startup() -> None:
    global _worker_task
    _worker_task = asyncio.create_task(_worker())


@app.on_event("shutdown")
async def _shutdown() -> None:
    # Drain queue
    while not _suggestion_queue.empty():
        try:
            _suggestion_queue.get_nowait()
            _suggestion_queue.task_done()
        except asyncio.QueueEmpty:
            break
    # Cancel worker
    if _worker_task:
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("settings.html", {"request": request})


@app.get("/api/settings")
async def get_settings() -> dict[str, Any]:
    s = load_settings()
    d = s.model_dump(exclude={"document_state"})
    d["paperless_token"] = "***" if s.paperless_token else ""
    return d


@app.post("/api/settings")
async def update_settings(payload: SettingsRequest) -> dict[str, Any]:
    current = load_settings()
    data = payload.model_dump()
    if data.get("paperless_token") == "***":
        data["paperless_token"] = current.paperless_token
    new_settings = AppSettings(**data)
    new_settings.document_state = current.document_state
    save_settings(new_settings)
    return {"status": "ok"}


@app.get("/api/entries")
async def entries(sort_by: str = Query("name", pattern="^(name|tags|quality)$")) -> list[dict[str, Any]]:
    settings = load_settings()
    tag_map, corr_map, dtype_map, docs = await asyncio.gather(
        get_tag_map(settings),
        get_correspondent_map(settings),
        get_document_type_map(settings),
        get_documents(settings),
    )

    enriched = []
    for d in docs:
        tag_names = [tag_map.get(tid, str(tid)) for tid in d.get("tags", [])]
        corr_id = d.get("correspondent")
        dtype_id = d.get("document_type")
        correspondent = corr_map.get(corr_id) if corr_id else None
        document_type = dtype_map.get(dtype_id) if dtype_id else None
        doc_date = d.get("created")
        title = d.get("title", "")

        doc_id_str = str(d["id"])
        state = settings.document_state.get(doc_id_str, DocumentState())

        enriched.append({
            "id": d["id"],
            "title": title,
            "correspondent": correspondent,
            "document_type": document_type,
            "date": doc_date,
            "tags": tag_names,
            "heuristic_quality": score_heuristic(title, tag_names),
            "llm_quality": state.llm_quality,
            "metadata_completeness": score_completeness(title, tag_names, correspondent, document_type, doc_date),
            "suggestion_status": state.suggestion_status,
            "fallback_used": state.fallback_used,
            "metadata_reviewed": None,  # populated via custom field if desired
        })

    if sort_by == "name":
        enriched.sort(key=lambda x: x["title"].lower())
    elif sort_by == "tags":
        enriched.sort(key=lambda x: len(x["tags"]), reverse=True)
    else:
        enriched.sort(key=lambda x: (
            x["llm_quality"] if x["llm_quality"] is not None else x["heuristic_quality"]
        ))

    return enriched


@app.post("/api/suggestions")
async def suggestions(payload: SuggestRequest) -> dict[str, Any]:
    settings = load_settings()
    tag_map, corr_map, dtype_map, docs = await asyncio.gather(
        get_tag_map(settings),
        get_correspondent_map(settings),
        get_document_type_map(settings),
        get_documents(settings),
    )
    docs_by_id = {doc["id"]: doc for doc in docs}
    all_tags = sorted(tag_map.values())
    corr_names = sorted(corr_map.values())
    dtype_names = sorted(dtype_map.values())

    job_id = str(uuid.uuid4())
    valid_ids = [doc_id for doc_id in payload.ids if doc_id in docs_by_id]
    _jobs[job_id] = JobState(total=len(valid_ids))

    # Mark all as pending
    settings_fresh = load_settings()
    for doc_id in valid_ids:
        doc_id_str = str(doc_id)
        state = settings_fresh.document_state.get(doc_id_str, DocumentState())
        state.suggestion_status = "pending"
        settings_fresh.document_state[doc_id_str] = state
    save_settings(settings_fresh)

    for doc_id in valid_ids:
        entry = docs_by_id[doc_id]
        tag_names = [tag_map.get(tid, str(tid)) for tid in entry.get("tags", [])]
        await _suggestion_queue.put({
            "settings": settings,
            "entry": entry,
            "job_id": job_id,
            "tag_names": tag_names,
            "all_tags": all_tags,
            "corr_names": corr_names,
            "dtype_names": dtype_names,
            "docs_by_id": docs_by_id,
            "tag_map": tag_map,
            "corr_map": corr_map,
            "dtype_map": dtype_map,
        })

    return {"job_id": job_id, "total": len(valid_ids)}


@app.get("/api/suggestions/status")
async def suggestion_status(job_id: str = Query(...)) -> dict[str, Any]:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "job_id": job_id,
        "total": job.total,
        "completed": job.completed,
        "results": [s.model_dump() for s in job.results],
    }


@app.delete("/api/suggestions/queue")
async def cancel_queue() -> dict[str, Any]:
    cancelled = 0
    while not _suggestion_queue.empty():
        try:
            _suggestion_queue.get_nowait()
            _suggestion_queue.task_done()
            cancelled += 1
        except asyncio.QueueEmpty:
            break
    return {"status": "ok", "cancelled": cancelled}


@app.post("/api/apply")
async def apply_changes(payload: ApplyRequest) -> dict[str, Any]:
    settings = load_settings()
    headers_auth = _auth_headers(settings)
    headers_json = {**headers_auth, "Content-Type": "application/json"}
    today = date.today().isoformat()
    tags_created: list[str] = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        tag_map = await get_tag_map(settings)
        corr_map = await get_correspondent_map(settings)
        dtype_map = await get_document_type_map(settings)
        inverse_tag_map = {v.lower(): k for k, v in tag_map.items()}
        inverse_corr_map = {v.lower(): k for k, v in corr_map.items()}
        inverse_dtype_map = {v.lower(): k for k, v in dtype_map.items()}

        custom_field_id = await get_or_create_custom_field(settings, client)

        for entry in payload.entries:
            patch: dict[str, Any] = {}

            if entry.title is not None:
                patch["title"] = entry.title

            if entry.correspondent is not None:
                cid = inverse_corr_map.get(entry.correspondent.lower())
                if cid is not None:
                    patch["correspondent"] = cid

            if entry.document_type is not None:
                did = inverse_dtype_map.get(entry.document_type.lower())
                if did is not None:
                    patch["document_type"] = did

            if entry.tags is not None:
                tag_ids: list[int] = []
                for tag_name in entry.tags:
                    existing_id = inverse_tag_map.get(tag_name.lower())
                    if existing_id is not None:
                        tag_ids.append(existing_id)
                # Create new tags
                for new_tag in entry.tags_new:
                    if new_tag.lower() not in inverse_tag_map:
                        new_id = await create_tag(settings, client, new_tag)
                        tag_ids.append(new_id)
                        inverse_tag_map[new_tag.lower()] = new_id
                        tags_created.append(new_tag)
                patch["tags"] = tag_ids

            patch["custom_fields"] = [{"field": custom_field_id, "value": today}]

            url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/{entry.id}/"
            resp = await client.patch(url, headers=headers_json, json=patch)
            if resp.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Apply failed for {entry.id}: {resp.text}")

            # Update document state
            doc_id_str = str(entry.id)
            state = settings.document_state.get(doc_id_str, DocumentState())
            state.suggestion_status = "done"
            settings.document_state[doc_id_str] = state

    save_settings(settings)
    return {"status": "ok", "updated": len(payload.entries), "tags_created": tags_created}


@app.get("/api/documents/{doc_id}/thumb")
async def proxy_thumb(doc_id: int) -> StreamingResponse:
    settings = load_settings()
    url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/{doc_id}/thumb/"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_auth_headers(settings))
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail="Thumbnail not available")
        return StreamingResponse(iter([resp.content]), media_type="image/jpeg")


@app.get("/api/documents/{doc_id}/preview")
async def proxy_preview(doc_id: int) -> StreamingResponse:
    settings = load_settings()
    url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/{doc_id}/preview/"
    client = httpx.AsyncClient(timeout=60.0)
    req = client.build_request("GET", url, headers=_auth_headers(settings))
    resp = await client.send(req, stream=True)
    if resp.status_code >= 400:
        await resp.aclose()
        await client.aclose()
        raise HTTPException(status_code=resp.status_code, detail="Preview not available")

    async def _stream():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(_stream(), media_type="application/pdf")
