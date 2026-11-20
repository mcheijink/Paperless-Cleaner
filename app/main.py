from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

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
LEGACY_SETTINGS_FILE = BASE_DIR / "settings.json"
CONFIG_DIR = Path(os.getenv("CONFIG_DIR", str(BASE_DIR.parent / "config")))


def _resolve_settings_file() -> Path:
    """Settings live in CONFIG_DIR (a mounted volume) so they survive container
    recreation. Falls back to the legacy in-app location when no config dir exists."""
    explicit = os.getenv("SETTINGS_FILE")
    if explicit:
        return Path(explicit)
    if CONFIG_DIR.is_dir():
        target = CONFIG_DIR / "settings.json"
        if not target.exists() and LEGACY_SETTINGS_FILE.exists() and LEGACY_SETTINGS_FILE.stat().st_size > 0:
            try:
                target.write_text(LEGACY_SETTINGS_FILE.read_text())
            except OSError:
                logger.exception("Could not migrate settings to %s", target)
                return LEGACY_SETTINGS_FILE
        return target
    return LEGACY_SETTINGS_FILE


SETTINGS_FILE = _resolve_settings_file()

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

class AppSettings(BaseModel):
    paperless_base_url: str = "http://paperless-ngx:8000"
    paperless_token: str = ""
    ollama_base_url: str = "http://ollama:11434"
    ollama_model: str = "llama3.1"
    suggestion_provider: str = "ollama"
    ollama_temperature: float = 0.0
    confidence_discount: float = 0.2
    few_shot_min_documents: int = 5


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
    protected_tags: list[str] = Field(default_factory=list)  # manual tags — never shown as removals
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

class JobItem(BaseModel):
    doc_id: int
    title: str
    status: str = "pending"   # "pending" | "processing" | "done" | "failed"
    started_at: float | None = None
    finished_at: float | None = None


class JobState(BaseModel):
    total: int
    completed: int = 0
    started_at: float = Field(default_factory=time.time)
    items: list[JobItem] = Field(default_factory=list)
    results: list[Suggestion] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# App + task queue
# ---------------------------------------------------------------------------

app = FastAPI(title="Paperless Cleaner")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

_suggestion_queue: asyncio.Queue = asyncio.Queue()
_global_job: JobState | None = None
_worker_task: asyncio.Task | None = None
_current_ollama_task: asyncio.Task | None = None

# In-memory transient state (lost on restart — intentional)
_transient_status: dict[str, str] = {}    # doc_id_str → "pending" | "ready"
_transient_fallback: dict[str, bool] = {} # doc_id_str → fallback_used

# Custom field ID cache (populated at startup)
_cf_metadata_reviewed_id: int | None = None
_cf_llm_quality_id: int | None = None
_cf_suggestion_status_id: int | None = None


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def load_settings() -> AppSettings:
    if SETTINGS_FILE.exists() and SETTINGS_FILE.stat().st_size > 0:
        raw = json.loads(SETTINGS_FILE.read_text())
        raw.pop("document_state", None)  # remove legacy field if present
        return AppSettings(**{k: v for k, v in raw.items() if k in AppSettings.model_fields})
    settings = AppSettings(
        paperless_base_url=os.getenv("PAPERLESS_BASE_URL") or os.getenv("PAPERLESS_URL") or "http://paperless-ngx:8000",
        paperless_token=os.getenv("PAPERLESS_TOKEN", ""),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://ollama:11434"),
        ollama_model=os.getenv("OLLAMA_MODEL", "llama3.1"),
        suggestion_provider=os.getenv("SUGGESTION_PROVIDER", "ollama"),
    )
    save_settings(settings)
    return settings


def save_settings(settings: AppSettings) -> None:
    SETTINGS_FILE.write_text(json.dumps(settings.model_dump(), indent=2))


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
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        return await _paginated_get(client, url, headers)


async def get_tag_map(settings: AppSettings) -> dict[int, str]:
    headers = _auth_headers(settings)
    url = f"{settings.paperless_base_url.rstrip('/')}/api/tags/"
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        tags = await _paginated_get(client, url, headers)
    return {t["id"]: t["name"] for t in tags}


async def get_tag_objects(settings: AppSettings) -> list[dict]:
    """Returns full tag objects including matching_algorithm."""
    headers = _auth_headers(settings)
    url = f"{settings.paperless_base_url.rstrip('/')}/api/tags/"
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        return await _paginated_get(client, url, headers)


def split_auto_manual_tags(tag_objects: list[dict]) -> tuple[set[str], set[str]]:
    """Returns (auto_tag_names, manual_tag_names).
    Auto tags have matching_algorithm != 0 — Paperless assigns these automatically.
    Manual tags (algorithm=0) are workflow/status tags managed by the user."""
    auto_tags: set[str] = set()
    manual_tags: set[str] = set()
    for t in tag_objects:
        if t.get("matching_algorithm", 0) != 0:
            auto_tags.add(t["name"])
        else:
            manual_tags.add(t["name"])
    return auto_tags, manual_tags


async def get_correspondent_map(settings: AppSettings) -> dict[int, str]:
    headers = _auth_headers(settings)
    url = f"{settings.paperless_base_url.rstrip('/')}/api/correspondents/"
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        items = await _paginated_get(client, url, headers)
    return {c["id"]: c["name"] for c in items}


async def get_document_type_map(settings: AppSettings) -> dict[int, str]:
    headers = _auth_headers(settings)
    url = f"{settings.paperless_base_url.rstrip('/')}/api/document_types/"
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        items = await _paginated_get(client, url, headers)
    return {d["id"]: d["name"] for d in items}


async def _resolve_or_create_field(
    client: httpx.AsyncClient, url: str, headers: dict,
    fields: list[dict], name: str, data_type: str
) -> int:
    """Find a custom field by name+type, or create it. Falls back to name+(cleaner) if wrong type."""
    target = name
    for f in fields:
        if f["name"].lower() == target.lower():
            if f.get("data_type") == data_type:
                return f["id"]
            target = f"{name} (cleaner)"
            break
    for f in fields:
        if f["name"].lower() == target.lower() and f.get("data_type") == data_type:
            return f["id"]
    resp = await client.post(url, headers=headers, json={"name": target, "data_type": data_type})
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Failed to create custom field '{target}': {resp.text}")
    return resp.json()["id"]


async def init_custom_fields(settings: AppSettings) -> None:
    """Resolve or create all three custom fields and cache their IDs."""
    global _cf_metadata_reviewed_id, _cf_llm_quality_id, _cf_suggestion_status_id
    headers_auth = _auth_headers(settings)
    headers_json = {**headers_auth, "Content-Type": "application/json"}
    url = f"{settings.paperless_base_url.rstrip('/')}/api/custom_fields/"
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        fields = await _paginated_get(client, url, headers_auth)
        _cf_metadata_reviewed_id = await _resolve_or_create_field(
            client, url, headers_json, fields, "Metadata reviewed", "date")
        _cf_llm_quality_id = await _resolve_or_create_field(
            client, url, headers_json, fields, "LLM quality", "integer")
        _cf_suggestion_status_id = await _resolve_or_create_field(
            client, url, headers_json, fields, "Suggestion status", "string")


_cf_init_lock = asyncio.Lock()
_cf_last_error: str | None = None


def _custom_fields_ready() -> bool:
    return None not in (_cf_metadata_reviewed_id, _cf_llm_quality_id, _cf_suggestion_status_id)


async def ensure_custom_fields(settings: AppSettings) -> bool:
    """Resolve the custom field IDs if startup could not (e.g. Paperless was still
    booting). Returns False — never raises — when they are still unavailable, so
    callers can surface a warning instead of silently showing empty review state."""
    global _cf_last_error
    if _custom_fields_ready():
        return True
    async with _cf_init_lock:
        if _custom_fields_ready():
            return True
        try:
            await init_custom_fields(settings)
            _cf_last_error = None
        except HTTPException as exc:
            _cf_last_error = str(exc.detail)
            logger.warning("Custom fields unavailable: %s", _cf_last_error)
        except Exception as exc:
            _cf_last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("Custom fields unavailable: %s", _cf_last_error)
    return _custom_fields_ready()


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


def score_heuristic(title: str, tags: list[str] = []) -> int:
    """
    Score title quality only (0-100). Tags are intentionally excluded —
    they are already captured by metadata_completeness. Including them here
    caused well-tagged documents with raw filenames to outscore cleanly
    titled documents with fewer tags.
    """
    words = title.strip().split()
    wc = len(words)

    if wc == 0:
        pts = 0
    elif wc == 1:
        pts = 15
    elif wc == 2:
        pts = 40
    elif 3 <= wc <= 7:
        pts = 70
    else:
        pts = 50  # long titles still acceptable

    # Casing bonus — first word capitalised, rest lower (sentence case)
    if wc > 0:
        first = words[0]
        rest = words[1:]
        if first[0].isupper() and all(w.islower() for w in rest if w.isalpha()):
            pts += 20
        elif any(c.isupper() for c in title):
            pts += 5

    # Penalties — raw filenames and digit-heavy strings
    t = title.strip()
    if _FILENAME_RE.search(t) or ("_" in t and " " not in t):
        pts -= 50
    digit_ratio = sum(1 for c in t if c.isdigit()) / max(len(t), 1)
    if digit_ratio > 0.4:
        pts -= 30

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
# LLM input / request options
# ---------------------------------------------------------------------------

# How much document text the LLM sees. Prompt processing on the GPU is cheap
# (~4k tokens/s on an RTX 4070), so we send the whole text up to this cap
# (~8k tokens; covers ~94% of documents). Must stay well under the Ollama
# context length, or Ollama silently drops the start of the prompt.
LLM_MAX_CONTENT_CHARS = int(os.getenv("LLM_MAX_CONTENT_CHARS", "24000"))
LLM_DUPLICATE_SNIPPET_CHARS = int(os.getenv("LLM_DUPLICATE_SNIPPET_CHARS", "3000"))

# Thinking models (qwen3.x, deepseek-r1) ignore the "/no_think" prompt prefix on
# Ollama's OpenAI-compatible endpoint and reason for thousands of tokens first
# (qwen3.5:9b: ~6000 tokens, ~90 s per document instead of ~3 s).
# reasoning_effort="none" switches thinking off there; non-thinking models
# accept and ignore it.
LLM_EXTRA_BODY = {"reasoning_effort": "none"}


def content_for_llm(text: str, limit: int = LLM_MAX_CONTENT_CHARS) -> str:
    """Return the document text, or its start and end when longer than limit."""
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    tail = limit - head
    omitted = len(text) - head - tail
    return f"{text[:head]}\n\n[... {omitted} characters omitted ...]\n\n{text[-tail:]}"


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
    # Find docs marked "done" via the Paperless custom field
    done_ids = []
    if _cf_suggestion_status_id is not None:
        for doc in docs_by_id.values():
            cf_values = {cf["field"]: cf["value"] for cf in doc.get("custom_fields", [])}
            if cf_values.get(_cf_suggestion_status_id) == "done":
                done_ids.append(doc["id"])

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
    auto_tag_names: set[str],
    manual_tag_names: set[str],
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

    # Split current tags into auto (LLM can touch) and manual (protected)
    current_auto_tags = [t for t in tag_names if t in auto_tag_names]
    current_manual_tags = [t for t in tag_names if t not in auto_tag_names]

    few_shot = _build_few_shot_section(settings, docs_by_id, tag_map, corr_map, dtype_map)

    manual_note = ""
    if current_manual_tags:
        manual_note = f"\nProtected tags (do NOT include these — they are managed by the user's workflow): {', '.join(current_manual_tags)}"

    system_prompt = f"""/no_think

## Output format
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
Auto-matched tags — only suggest from this list: {", ".join(sorted(auto_tag_names)) or "none"}
Correspondents (select from this list only): {", ".join(corr_names) or "none"}
Document types (select from this list only): {", ".join(dtype_names) or "none"}

## Examples
{few_shot}

## Rules
- Title must be sentence case (first word capitalised, rest lowercase) in {language}
- Title must be 4-7 words — be specific, not generic
- Title must describe the SPECIFIC subject: what is this document actually about?
  - For medical invoices: name the specialist type AND whether it was a treatment, checkup/kontrolle, or procedure — and the patient if determinable (e.g. "Kinderarzt kontrolle Jacyntha", "Zahnarzt behandlung Marco", "Augenarzt untersuchung 2026")
  - For insurance: name the specific policy or vehicle/asset covered
  - For salary/payroll: name the month or period
  - Avoid generic words like "Rechnung", "Brief", "Invoice" alone — the document type field already captures that
- Title must not include the correspondent, document type, date, or reference numbers — these are stored separately
- Only suggest a correspondent, document type, or tag if it is in the allowed lists above
- suggested_tags must be the COMPLETE recommended set of auto-matched tags for this document (existing auto tags you want to keep + any new ones to add)
- Only omit an existing auto tag from suggested_tags if you are very confident (≥ 0.9) it does not apply
- Set suggested_correspondent and suggested_document_type to null if the current value is already appropriate or you are not confident
- Confidence is 0.0-1.0; be conservative
- Do not invent new tags, correspondents, or document types{manual_note}

## Do not
- Include protected/workflow tags in suggested_tags
- Include markdown, commentary, or any text outside the JSON
- Add fields not in the schema
- Translate the title; keep it in {language}"""

    user_message = f"""Current title: {entry.get("title", "")}
Correspondent: {current_corr}
Document type: {current_dtype}
Date: {doc_date}
Current auto-matched tags: {", ".join(current_auto_tags) or "none"}
Protected workflow tags (do not touch): {", ".join(current_manual_tags) or "none"}
Content:
{content_for_llm(content)}"""

    from openai import AsyncOpenAI

    base = settings.ollama_base_url.rstrip("/")
    openai_client = AsyncOpenAI(
        base_url=f"{base}/v1",
        api_key="ollama",
        timeout=httpx.Timeout(timeout=300.0, connect=30.0),
    )
    client = instructor.from_openai(openai_client, mode=instructor.Mode.JSON)

    response: _OllamaResponse = await asyncio.wait_for(
        client.chat.completions.create(
            model=settings.ollama_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            response_model=_OllamaResponse,
            temperature=settings.ollama_temperature,
            extra_body=LLM_EXTRA_BODY,
        ),
        timeout=300.0,
    )

    disc = settings.confidence_discount

    # Validate and build SuggestedTag list
    tag_map_lower = {v.lower(): v for v in auto_tag_names}
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

    # Validate correspondent — discard if same as current value
    corr_map_lower = {v.lower(): v for v in corr_names}
    validated_corr: SuggestedField | None = None
    if response.suggested_correspondent:
        n = response.suggested_correspondent.name.lower()
        if n in corr_map_lower and n != current_corr.lower():
            validated_corr = SuggestedField(
                name=corr_map_lower[n],
                confidence=max(0.0, response.suggested_correspondent.confidence - disc),
            )

    # Validate document type — discard if same as current value
    dtype_map_lower = {v.lower(): v for v in dtype_names}
    validated_dtype: SuggestedField | None = None
    if response.suggested_document_type:
        n = response.suggested_document_type.name.lower()
        if n in dtype_map_lower and n != current_dtype.lower():
            validated_dtype = SuggestedField(
                name=dtype_map_lower[n],
                confidence=max(0.0, response.suggested_document_type.confidence - disc),
            )

    # Validate title word count
    title = response.suggested_title
    word_count = len(title.strip().split())
    if not (2 <= word_count <= 10):
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
        protected_tags=current_manual_tags,
        reason=response.reason or "Suggested by Ollama model.",
    )


# ---------------------------------------------------------------------------
# Background worker
# ---------------------------------------------------------------------------

async def _process_one(item: dict[str, Any]) -> None:
    global _current_ollama_task
    settings = item["settings"]
    entry = item["entry"]
    tag_names = item["tag_names"]
    auto_tag_names = item["auto_tag_names"]
    manual_tag_names = item["manual_tag_names"]
    corr_names = item["corr_names"]
    dtype_names = item["dtype_names"]
    docs_by_id = item["docs_by_id"]
    tag_map = item["tag_map"]
    corr_map = item["corr_map"]
    dtype_map = item["dtype_map"]

    # Mark item as processing
    job = _global_job
    job_item = next((i for i in job.items if i.doc_id == entry["id"]), None) if job else None
    if job_item:
        job_item.status = "processing"
        job_item.started_at = time.time()

    fallback_used = False
    try:
        if settings.suggestion_provider == "ollama":
            coro = ollama_suggestion(
                settings, entry, tag_names, auto_tag_names, manual_tag_names,
                corr_names, dtype_names, docs_by_id, tag_map, corr_map, dtype_map,
            )
            _current_ollama_task = asyncio.current_task()
            suggestion = await coro
            _current_ollama_task = None
        else:
            suggestion = heuristic_suggestion(entry, tag_names)
    except Exception:
        logger.exception("Ollama suggestion failed for doc %s, falling back to heuristic", entry.get("id"))
        suggestion = heuristic_suggestion(entry, tag_names)
        suggestion.fallback_used = True
        fallback_used = True

    doc_id_str = str(entry["id"])
    if _global_job is not job:
        # Queue was cancelled while this document was in flight — drop the result
        _transient_status.pop(doc_id_str, None)
        return
    _transient_status[doc_id_str] = "ready"
    _transient_fallback[doc_id_str] = fallback_used

    if job_item:
        job_item.status = "failed" if fallback_used else "done"
        job_item.finished_at = time.time()

    # Persist llm_quality to Paperless if available
    if suggestion.title_quality is not None and _cf_llm_quality_id is not None:
        try:
            settings_fresh = load_settings()
            patch_url = f"{settings_fresh.paperless_base_url.rstrip('/')}/api/documents/{entry['id']}/"
            headers = {**_auth_headers(settings_fresh), "Content-Type": "application/json"}
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                await client.patch(patch_url, headers=headers, json={
                    "custom_fields": [{"field": _cf_llm_quality_id, "value": suggestion.title_quality}]
                })
        except Exception:
            logger.exception("Failed to persist llm_quality for doc %s", entry["id"])

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
    settings = load_settings()
    if not await ensure_custom_fields(settings):
        logger.warning("Paperless custom fields not resolved at startup — retrying on each request until they are")
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
    d = s.model_dump()
    d["paperless_token"] = "***" if s.paperless_token else ""
    return d


@app.post("/api/settings")
async def update_settings(payload: SettingsRequest) -> dict[str, Any]:
    current = load_settings()
    data = payload.model_dump()
    if data.get("paperless_token") == "***":
        data["paperless_token"] = current.paperless_token
    new_settings = AppSettings(**data)
    save_settings(new_settings)
    # Re-resolve custom fields in case the Paperless URL changed
    global _cf_metadata_reviewed_id, _cf_llm_quality_id, _cf_suggestion_status_id
    _cf_metadata_reviewed_id = _cf_llm_quality_id = _cf_suggestion_status_id = None
    fields_ok = await ensure_custom_fields(new_settings)
    return {"status": "ok", "paperless_ok": fields_ok, "paperless_error": None if fields_ok else _cf_last_error}


class ConnectionTestRequest(BaseModel):
    paperless_base_url: str = ""
    paperless_token: str = ""
    ollama_base_url: str = ""
    ollama_model: str = ""


@app.post("/api/settings/test")
async def test_connections(payload: ConnectionTestRequest) -> dict[str, Any]:
    """Check the *submitted* (possibly unsaved) connection values."""
    current = load_settings()
    token = current.paperless_token if payload.paperless_token == "***" else payload.paperless_token
    out: dict[str, Any] = {}

    try:
        url = f"{payload.paperless_base_url.rstrip('/')}/api/documents/?page_size=1"
        headers = {"Authorization": f"Token {token}"} if token else {}
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code in (401, 403):
            out["paperless"] = {"ok": False, "message": "Paperless rejected the API token."}
        elif resp.status_code >= 400:
            out["paperless"] = {"ok": False, "message": f"Paperless answered HTTP {resp.status_code}."}
        else:
            out["paperless"] = {"ok": True, "message": f"Connected — {resp.json().get('count', '?')} documents."}
    except Exception as exc:
        out["paperless"] = {"ok": False, "message": f"Could not reach Paperless ({type(exc).__name__})."}

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(f"{payload.ollama_base_url.rstrip('/')}/api/tags")
        if resp.status_code >= 400:
            out["ollama"] = {"ok": False, "message": f"Ollama answered HTTP {resp.status_code}."}
        else:
            models = [m.get("name", "") for m in resp.json().get("models", [])]
            wanted = payload.ollama_model
            found = any(m == wanted or m.split(":")[0] == wanted for m in models)
            out["ollama"] = {
                "ok": found,
                "message": f"Connected — model '{wanted}' available." if found
                else f"Connected, but model '{wanted}' is not installed.",
            }
    except Exception as exc:
        out["ollama"] = {"ok": False, "message": f"Could not reach Ollama ({type(exc).__name__})."}

    return out


@app.get("/api/entries")
async def entries(sort_by: str = Query("name", pattern="^(name|tags|quality)$")) -> dict[str, Any]:
    settings = load_settings()
    if not settings.paperless_token:
        raise HTTPException(status_code=503, detail="No Paperless API token configured. Add one in Settings.")
    review_state_ok = await ensure_custom_fields(settings)
    try:
        tag_map, corr_map, dtype_map, docs = await asyncio.gather(
            get_tag_map(settings),
            get_correspondent_map(settings),
            get_document_type_map(settings),
            get_documents(settings),
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach Paperless at {settings.paperless_base_url} ({type(exc).__name__}).",
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

        # Read persistent state from Paperless custom fields
        cf_values: dict[int, Any] = {
            cf["field"]: cf["value"]
            for cf in d.get("custom_fields", [])
        }
        llm_quality: int | None = cf_values.get(_cf_llm_quality_id) if _cf_llm_quality_id else None
        suggestion_status_persisted: str = cf_values.get(_cf_suggestion_status_id, "") or ""
        metadata_reviewed: str | None = cf_values.get(_cf_metadata_reviewed_id) if _cf_metadata_reviewed_id else None

        # Overlay with transient in-memory state (pending/ready)
        transient = _transient_status.get(doc_id_str)
        if transient:
            suggestion_status = transient
        elif suggestion_status_persisted == "done":
            suggestion_status = "done"
        else:
            suggestion_status = "none"

        enriched.append({
            "id": d["id"],
            "title": title,
            "correspondent": correspondent,
            "document_type": document_type,
            "date": doc_date,
            "tags": tag_names,
            "heuristic_quality": score_heuristic(title),
            "llm_quality": llm_quality,
            "metadata_completeness": score_completeness(title, tag_names, correspondent, document_type, doc_date),
            "suggestion_status": suggestion_status,
            "fallback_used": _transient_fallback.get(doc_id_str, False),
            "metadata_reviewed": metadata_reviewed,
        })

    if sort_by == "name":
        enriched.sort(key=lambda x: x["title"].lower())
    elif sort_by == "tags":
        enriched.sort(key=lambda x: len(x["tags"]), reverse=True)
    else:
        enriched.sort(key=lambda x: (
            x["llm_quality"] if x["llm_quality"] is not None else x["heuristic_quality"]
        ))

    warnings: list[str] = []
    if not review_state_ok:
        warnings.append(
            "Review state could not be read from Paperless, so every document shows as "
            f"not reviewed. ({_cf_last_error or 'custom fields unavailable'})"
        )
    return {"entries": enriched, "review_state_ok": review_state_ok, "warnings": warnings}


@app.post("/api/suggestions")
async def suggestions(payload: SuggestRequest) -> dict[str, Any]:
    global _global_job
    settings = load_settings()
    await ensure_custom_fields(settings)
    tag_objects, corr_map, dtype_map, docs = await asyncio.gather(
        get_tag_objects(settings),
        get_correspondent_map(settings),
        get_document_type_map(settings),
        get_documents(settings),
    )
    tag_map = {t["id"]: t["name"] for t in tag_objects}
    auto_tag_names, manual_tag_names = split_auto_manual_tags(tag_objects)
    docs_by_id = {doc["id"]: doc for doc in docs}
    corr_names = sorted(corr_map.values())
    dtype_names = sorted(dtype_map.values())

    # Deduplicate: skip ids already in the global job queue
    existing_ids: set[int] = set()
    if _global_job is not None:
        existing_ids = {i.doc_id for i in _global_job.items}

    valid_ids = [
        doc_id for doc_id in payload.ids
        if doc_id in docs_by_id and doc_id not in existing_ids
    ]
    new_items = [
        JobItem(doc_id=doc_id, title=docs_by_id[doc_id].get("title", str(doc_id)))
        for doc_id in valid_ids
    ]

    if _global_job is None:
        _global_job = JobState(total=len(valid_ids), items=new_items)
    else:
        _global_job.items.extend(new_items)
        _global_job.total += len(valid_ids)

    # Mark all new items as pending in transient state
    for doc_id in valid_ids:
        _transient_status[str(doc_id)] = "pending"
        _transient_fallback.pop(str(doc_id), None)

    for doc_id in valid_ids:
        entry = docs_by_id[doc_id]
        tag_names = [tag_map.get(tid, str(tid)) for tid in entry.get("tags", [])]
        await _suggestion_queue.put({
            "settings": settings,
            "entry": entry,
            "tag_names": tag_names,
            "auto_tag_names": auto_tag_names,
            "manual_tag_names": manual_tag_names,
            "corr_names": corr_names,
            "dtype_names": dtype_names,
            "docs_by_id": docs_by_id,
            "tag_map": tag_map,
            "corr_map": corr_map,
            "dtype_map": dtype_map,
        })

    return {"newly_added": len(valid_ids), "total": _global_job.total}


@app.get("/api/suggestions/status")
async def suggestion_status() -> dict[str, Any]:
    if _global_job is None:
        raise HTTPException(status_code=404, detail="No active job")

    job = _global_job
    now = time.time()
    done_items = [i for i in job.items if i.finished_at is not None]
    durations = [i.finished_at - i.started_at for i in done_items if i.started_at]
    avg_seconds = sum(durations) / len(durations) if durations else None
    elapsed = now - job.started_at
    remaining = job.total - job.completed
    eta_seconds = avg_seconds * remaining if avg_seconds is not None else None

    return {
        "total": job.total,
        "completed": job.completed,
        "results": [s.model_dump() for s in job.results],
        "items": [i.model_dump() for i in job.items],
        "elapsed_seconds": round(elapsed, 1),
        "avg_seconds_per_doc": round(avg_seconds, 1) if avg_seconds is not None else None,
        "eta_seconds": round(eta_seconds) if eta_seconds is not None else None,
    }


@app.delete("/api/suggestions/queue")
async def cancel_queue() -> dict[str, Any]:
    global _global_job
    cancelled = 0
    while not _suggestion_queue.empty():
        try:
            _suggestion_queue.get_nowait()
            _suggestion_queue.task_done()
            cancelled += 1
        except asyncio.QueueEmpty:
            break
    _global_job = None
    for doc_id_str in [k for k, v in _transient_status.items() if v == "pending"]:
        _transient_status.pop(doc_id_str, None)
    return {"status": "ok", "cancelled": cancelled}


@app.post("/api/apply")
async def apply_changes(payload: ApplyRequest) -> dict[str, Any]:
    settings = load_settings()
    headers_auth = _auth_headers(settings)
    headers_json = {**headers_auth, "Content-Type": "application/json"}
    today = date.today().isoformat()
    tags_created: list[str] = []

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        tag_objects = await get_tag_objects(settings)
        tag_map = {t["id"]: t["name"] for t in tag_objects}
        auto_tag_names, _manual_tag_names = split_auto_manual_tags(tag_objects)
        corr_map = await get_correspondent_map(settings)
        dtype_map = await get_document_type_map(settings)
        inverse_tag_map = {v.lower(): k for k, v in tag_map.items()}
        inverse_corr_map = {v.lower(): k for k, v in corr_map.items()}
        inverse_dtype_map = {v.lower(): k for k, v in dtype_map.items()}
        # Map tag id → is_manual for preserving workflow tags
        tag_id_is_manual = {t["id"]: (t.get("matching_algorithm", 0) == 0) for t in tag_objects}

        # Ensure custom fields are initialised (may not be if startup failed)
        if not await ensure_custom_fields(settings):
            raise HTTPException(
                status_code=502,
                detail=f"Cannot record review state in Paperless: {_cf_last_error or 'custom fields unavailable'}",
            )

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
                # Fetch current document tags to preserve manual/workflow ones
                doc_resp = await client.get(
                    f"{settings.paperless_base_url.rstrip('/')}/api/documents/{entry.id}/",
                    headers=headers_auth,
                )
                current_tag_ids: list[int] = doc_resp.json().get("tags", []) if doc_resp.status_code == 200 else []
                manual_tag_ids = [tid for tid in current_tag_ids if tag_id_is_manual.get(tid, True)]

                tag_ids: list[int] = list(manual_tag_ids)  # start with preserved manual tags
                for tag_name in entry.tags:
                    existing_id = inverse_tag_map.get(tag_name.lower())
                    if existing_id is not None and existing_id not in tag_ids:
                        tag_ids.append(existing_id)
                # Create new tags
                for new_tag in entry.tags_new:
                    if new_tag.lower() not in inverse_tag_map:
                        new_id = await create_tag(settings, client, new_tag)
                        tag_ids.append(new_id)
                        inverse_tag_map[new_tag.lower()] = new_id
                        tags_created.append(new_tag)
                    elif inverse_tag_map[new_tag.lower()] not in tag_ids:
                        tag_ids.append(inverse_tag_map[new_tag.lower()])
                patch["tags"] = tag_ids

            custom_fields_patch = []
            if _cf_metadata_reviewed_id is not None:
                custom_fields_patch.append({"field": _cf_metadata_reviewed_id, "value": today})
            if _cf_suggestion_status_id is not None:
                custom_fields_patch.append({"field": _cf_suggestion_status_id, "value": "done"})
            if custom_fields_patch:
                patch["custom_fields"] = custom_fields_patch

            url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/{entry.id}/"
            resp = await client.patch(url, headers=headers_json, json=patch)
            if resp.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Apply failed for {entry.id}: {resp.text}")

            # Clear transient state
            doc_id_str = str(entry.id)
            _transient_status.pop(doc_id_str, None)
            _transient_fallback.pop(doc_id_str, None)

    return {"status": "ok", "updated": len(payload.entries), "tags_created": tags_created}


# ---------------------------------------------------------------------------
# Duplicate detection
# ---------------------------------------------------------------------------

def _title_tokens(title: str) -> set[str]:
    """Normalise a title to a set of lowercase alphabetic tokens (≥3 chars)."""
    return {w.lower() for w in re.findall(r"[a-z]{3,}", title, re.IGNORECASE)}


def _token_overlap(a: set[str], b: set[str]) -> float:
    """Overlap = intersection / size-of-smaller-set (0.0–1.0)."""
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def _content_similarity(a: str, b: str, sample: int = 800) -> float:
    """Character-level Jaccard on 3-grams of the first `sample` chars."""
    def trigrams(s: str) -> set[str]:
        s = re.sub(r"\s+", " ", s.lower().strip())[:sample]
        return {s[i:i+3] for i in range(len(s) - 2)}
    ta, tb = trigrams(a), trigrams(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# Last completed duplicate scan (in memory) so revisiting the page needs no rescan
_last_duplicate_scan: dict[str, Any] | None = None


def _duplicate_result(g: dict[str, Any]) -> dict[str, Any] | None:
    """Final confidence for a candidate group; None when the LLM ruled it out.

    High     → content nearly identical (≥ 0.85) OR LLM says duplicate
    Medium   → ambiguous (0.35–0.85) and LLM inconclusive
    Possible → metadata match only, or LLM says same template
    """
    sim = g["max_similarity"]
    llm_verdict = g.get("llm_verdict")
    if llm_verdict == "different":
        return None
    if sim >= 0.85 or llm_verdict == "duplicate":
        confidence = "high"
    elif 0.35 <= sim < 0.85 and llm_verdict == "same_template":
        confidence = "possible"
    elif sim >= 0.35:
        confidence = "medium"
    else:
        confidence = "possible"

    docs_in = g["docs"]
    best_id = max(docs_in, key=lambda e: (e["content_len"], e["completeness"], e["heuristic_quality"]))["id"]
    return {
        "confidence": confidence,
        "reason": g["meta_reason"],
        "llm_verdict": llm_verdict,
        "llm_reasoning": g.get("llm_reasoning", ""),
        "pairs": g["pairs"],
        "best_id": best_id,
        "snippets": {e["id"]: e["content"][:400] for e in docs_in},
        "documents": [
            {
                "id": e["id"],
                "title": e["title"],
                "correspondent": e["correspondent"],
                "document_type": e["document_type"],
                "date": e["date"],
                "tags": e["tags"],
                "heuristic_quality": e["heuristic_quality"],
                "completeness": e["completeness"],
                "content_len": e["content_len"],
                "is_best": e["id"] == best_id,
            }
            for e in docs_in
        ],
    }


@app.get("/api/duplicates/last")
async def last_duplicate_scan() -> dict[str, Any]:
    if _last_duplicate_scan is None:
        raise HTTPException(status_code=404, detail="No scan has been run yet")
    return _last_duplicate_scan


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.get("/duplicates", response_class=HTMLResponse)
async def duplicates_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("duplicates.html", {"request": request})


@app.get("/api/duplicates/scan")
async def scan_duplicates(request: Request) -> StreamingResponse:
    """
    Three-pass duplicate scan streamed as SSE events.

    Events emitted:
      progress  { phase: int, phase_label: str, detail: str }
      result    { confidence, reason, llm_verdict, llm_reasoning, documents: [...], snippets: {...} }
      done      { total: int }
      error     { message: str }
    """

    async def _generate():
        try:
            settings = load_settings()

            # ── Phase 1: fetch docs & build metadata candidates ────────────────
            yield _sse("progress", {"phase": 1, "phase_label": "Phase 1/3", "detail": "Fetching documents from Paperless…"})
            tag_map, corr_map, dtype_map, docs = await asyncio.gather(
                get_tag_map(settings),
                get_correspondent_map(settings),
                get_document_type_map(settings),
                get_documents(settings),
            )

            yield _sse("progress", {"phase": 1, "phase_label": "Phase 1/3", "detail": f"Analysing metadata for {len(docs)} documents…"})

            entries: list[dict[str, Any]] = []
            for d in docs:
                corr_id = d.get("correspondent")
                dtype_id = d.get("document_type")
                raw_date = d.get("created") or ""
                date_str = raw_date[:10] if raw_date else ""
                title = d.get("title", "")
                tokens = _title_tokens(title)
                is_filename = bool(_FILENAME_RE.search(title.strip()) or ("_" in title and " " not in title))
                tag_names = [tag_map.get(tid, str(tid)) for tid in d.get("tags", [])]
                correspondent = corr_map.get(corr_id) if corr_id else None
                document_type = dtype_map.get(dtype_id) if dtype_id else None
                content = d.get("content") or ""
                hq = score_heuristic(title)
                completeness = score_completeness(title, tag_names, correspondent, document_type, date_str)
                entries.append({
                    "id": d["id"],
                    "title": title,
                    "correspondent": correspondent,
                    "document_type": document_type,
                    "date": date_str,
                    "tags": tag_names,
                    "tokens": tokens,
                    "is_filename": is_filename,
                    "heuristic_quality": hq,
                    "completeness": completeness,
                    "content": content,
                    "content_len": len(content),
                })

            # Build raw candidate groups (all start as "possible")
            raw_groups: list[dict[str, Any]] = []
            used_ids: set[int] = set()

            triple_groups: dict[tuple, list[dict]] = defaultdict(list)
            for e in entries:
                if e["date"] and e["correspondent"] and e["document_type"]:
                    triple_groups[(e["date"], e["correspondent"], e["document_type"])].append(e)
            for (date_v, corr_v, dtype_v), grp in triple_groups.items():
                if len(grp) >= 2:
                    raw_groups.append({
                        "meta_reason": f"Same date, correspondent & document type ({corr_v} · {date_v} · {dtype_v})",
                        "docs": grp,
                    })
                    for e in grp:
                        used_ids.add(e["id"])

            pair_groups: dict[tuple, list[dict]] = defaultdict(list)
            for e in entries:
                if e["id"] not in used_ids and e["date"] and e["correspondent"]:
                    pair_groups[(e["date"], e["correspondent"])].append(e)
            for (date_v, corr_v), grp in pair_groups.items():
                if len(grp) >= 2:
                    raw_groups.append({
                        "meta_reason": f"Same date & correspondent ({corr_v} · {date_v})",
                        "docs": grp,
                    })
                    for e in grp:
                        used_ids.add(e["id"])

            title_candidates = [e for e in entries if e["id"] not in used_ids and e["tokens"] and not e["is_filename"]]
            merged_used: set[int] = set()
            for i, a in enumerate(title_candidates):
                if a["id"] in merged_used:
                    continue
                group: list[dict] = [a]
                for j, b in enumerate(title_candidates):
                    if i == j or b["id"] in merged_used:
                        continue
                    if _token_overlap(a["tokens"], b["tokens"]) >= 0.60:
                        group.append(b)
                        merged_used.add(b["id"])
                if len(group) >= 2:
                    merged_used.add(a["id"])
                    raw_groups.append({"meta_reason": "Similar title", "docs": group})

            yield _sse("progress", {"phase": 1, "phase_label": "Phase 1/3", "detail": f"Found {len(raw_groups)} candidate group(s)."})

            # ── Phase 2: content similarity for every candidate pair ───────────
            yield _sse("progress", {"phase": 2, "phase_label": "Phase 2/3", "detail": f"Comparing content for {len(raw_groups)} group(s)…"})

            # Attach pairwise content similarity to each group
            for g in raw_groups:
                docs_in = g["docs"]
                pairs: list[dict] = []
                for i in range(len(docs_in)):
                    for j in range(i + 1, len(docs_in)):
                        sim = _content_similarity(docs_in[i]["content"], docs_in[j]["content"])
                        pairs.append({
                            "id_a": docs_in[i]["id"],
                            "id_b": docs_in[j]["id"],
                            "similarity": round(sim, 3),
                        })
                g["pairs"] = pairs
                # Max similarity across all pairs in the group
                g["max_similarity"] = max((p["similarity"] for p in pairs), default=0.0)

            # ── Emit groups that need no LLM right away ───────────────────────
            ambiguous = [g for g in raw_groups if 0.35 <= g["max_similarity"] < 0.85]
            emitted: list[dict[str, Any]] = []
            for g in raw_groups:
                if 0.35 <= g["max_similarity"] < 0.85:
                    continue
                result = _duplicate_result(g)
                if result:
                    emitted.append(result)
                    yield _sse("result", result)

            # ── Phase 3: LLM review for ambiguous pairs (sim 0.35–0.85) ────────
            yield _sse("progress", {
                "phase": 3,
                "phase_label": "Phase 3/3",
                "current": 0,
                "total": len(ambiguous),
                "detail": f"LLM reviewing {len(ambiguous)} ambiguous group(s)…" if ambiguous else "No ambiguous groups — skipping LLM.",
            })

            for idx, g in enumerate(ambiguous):
                if await request.is_disconnected():
                    logger.info("Duplicate scan cancelled by client after %d/%d LLM reviews", idx, len(ambiguous))
                    return
                docs_in = g["docs"]
                # Build snippet pairs for LLM
                snippets_for_llm = [
                    {"id": e["id"], "title": e["title"],
                     "snippet": content_for_llm(e["content"], LLM_DUPLICATE_SNIPPET_CHARS)}
                    for e in docs_in
                ]
                snippet_text = "\n\n".join(
                    f'Document {i+1} (id={s["id"]}, title="{s["title"]}"):\n{s["snippet"]}'
                    for i, s in enumerate(snippets_for_llm)
                )

                llm_prompt_system = """/no_think
You are a document duplicate detector. Given content snippets from two or more documents, decide whether they are:
- "duplicate": the same document uploaded/scanned more than once (content is the same)
- "same_template": the same form or letter sent to different people (same structure, different recipient/personal details)
- "different": distinct documents that happen to share metadata

Respond with a single JSON object:
{"verdict": "duplicate"|"same_template"|"different", "reasoning": "one sentence explanation"}

No text outside the JSON."""

                llm_prompt_user = f"Compare these document snippets:\n\n{snippet_text}"

                llm_verdict = "unknown"
                llm_reasoning = ""
                try:
                    from openai import AsyncOpenAI
                    base = settings.ollama_base_url.rstrip("/")
                    openai_client = AsyncOpenAI(
                        base_url=f"{base}/v1",
                        api_key="ollama",
                        timeout=httpx.Timeout(timeout=300.0, connect=30.0),
                    )
                    llm_client = instructor.from_openai(openai_client, mode=instructor.Mode.JSON)

                    class _LLMVerdict(BaseModel):
                        verdict: str = "different"
                        reasoning: str = ""

                    resp: _LLMVerdict = await asyncio.wait_for(
                        llm_client.chat.completions.create(
                            model=settings.ollama_model,
                            messages=[
                                {"role": "system", "content": llm_prompt_system},
                                {"role": "user", "content": llm_prompt_user},
                            ],
                            response_model=_LLMVerdict,
                            temperature=0.0,
                            extra_body=LLM_EXTRA_BODY,
                        ),
                        timeout=300.0,
                    )
                    llm_verdict = resp.verdict if resp.verdict in ("duplicate", "same_template", "different") else "unknown"
                    llm_reasoning = resp.reasoning
                except Exception:
                    logger.exception("LLM verdict failed for duplicate group, skipping")
                    llm_verdict = "unknown"

                g["llm_verdict"] = llm_verdict
                g["llm_reasoning"] = llm_reasoning

                # Emit as soon as this group is decided
                result = _duplicate_result(g)
                if result:
                    emitted.append(result)
                    yield _sse("result", result)

                yield _sse("progress", {
                    "phase": 3,
                    "phase_label": "Phase 3/3",
                    "current": idx + 1,
                    "total": len(ambiguous),
                    "detail": f"LLM reviewed group {idx + 1} of {len(ambiguous)}",
                })

            global _last_duplicate_scan
            _last_duplicate_scan = {"finished_at": time.time(), "results": emitted}
            total_emitted = len(emitted)

            yield _sse("done", {"total": total_emitted})

        except Exception as exc:
            logger.exception("Duplicate scan failed")
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(_generate(), media_type="text/event-stream")


@app.get("/api/documents/{doc_id}/thumb")
async def proxy_thumb(doc_id: int) -> StreamingResponse:
    settings = load_settings()
    url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/{doc_id}/thumb/"
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(url, headers=_auth_headers(settings))
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail="Thumbnail not available")
        return StreamingResponse(iter([resp.content]), media_type="image/jpeg")


@app.get("/api/documents/{doc_id}/preview")
async def proxy_preview(doc_id: int) -> StreamingResponse:
    settings = load_settings()
    url = f"{settings.paperless_base_url.rstrip('/')}/api/documents/{doc_id}/preview/"
    client = httpx.AsyncClient(timeout=60.0, follow_redirects=True)
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
