"""Pure logic for the duplicate scan: text similarity, extracted facts, LLM prompt,
verdict cache and confidence. No I/O against Paperless or Ollama here, so it can be
tested in isolation.

A "duplicate" is the same document stored twice (re-scan, re-upload, another file of
the same letter). Documents that share a sender, layout or template are NOT
duplicates: the salary statement for March 2026 and the one for March 2025 look
alike but are different documents.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

SHINGLE_WORDS = 5
# A shingle that occurs in more documents than this is boilerplate (letterhead,
# footer) and says nothing about whether two documents are the same.
MAX_SHINGLE_DOCS = 25

_WORD_RE = re.compile(r"\w+", re.UNICODE)


def shingles(text: str, n: int = SHINGLE_WORDS) -> set[str]:
    words = _WORD_RE.findall((text or "").lower())
    return {" ".join(words[i:i + n]) for i in range(len(words) - n + 1)}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def content_candidate_pairs(
    shingle_sets: dict[int, set[str]], min_similarity: float,
) -> dict[tuple[int, int], float]:
    """All document pairs whose full-text similarity is >= min_similarity.

    Uses an inverted index so only documents that share text are compared.
    """
    index: dict[str, list[int]] = defaultdict(list)
    for doc_id, sh in shingle_sets.items():
        for s in sh:
            index[s].append(doc_id)
    shared: dict[tuple[int, int], int] = defaultdict(int)
    for ids in index.values():
        if 1 < len(ids) <= MAX_SHINGLE_DOCS:
            for a, b in itertools.combinations(sorted(ids), 2):
                shared[(a, b)] += 1
    result = {}
    for (a, b), count in shared.items():
        union = len(shingle_sets[a] | shingle_sets[b])
        if union and count / union >= min_similarity:
            result[(a, b)] = count / union
    return result


# ── Facts: the details that tell a copy apart from a look-alike ──────────────

_MONTHS = {
    # Dutch / German / English, full and common abbreviations
    "januari": 1, "januar": 1, "january": 1, "jan": 1, "jänner": 1,
    "februari": 2, "februar": 2, "february": 2, "feb": 2,
    "maart": 3, "märz": 3, "maerz": 3, "march": 3, "mrt": 3, "mär": 3,
    "april": 4, "apr": 4,
    "mei": 5, "mai": 5, "may": 5,
    "juni": 6, "june": 6, "jun": 6,
    "juli": 7, "july": 7, "jul": 7,
    "augustus": 8, "august": 8, "aug": 8,
    "september": 9, "sept": 9, "sep": 9,
    "oktober": 10, "october": 10, "okt": 10, "oct": 10,
    "november": 11, "nov": 11,
    "december": 12, "dezember": 12, "dec": 12, "dez": 12,
}
_MONTH_RE = "|".join(sorted(map(re.escape, _MONTHS), key=len, reverse=True))
_PERIOD_RE = re.compile(rf"\b({_MONTH_RE})\.?\s+(20\d\d|19\d\d)\b", re.IGNORECASE)
_PERIOD_NUM_RE = re.compile(r"\b(0?[1-9]|1[0-2])\s*[/.-]\s*(20\d\d)\b")
_DATE_DMY_RE = re.compile(r"\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](20\d\d|19\d\d)\b")
_DATE_ISO_RE = re.compile(r"\b(20\d\d|19\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b")
_AMOUNT_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:[.\s]\d{3})*|\d+),(\d{2})(?![\d,])")
_THOUSANDS_RE = re.compile(r"[.\s]")
_REFERENCE_RE = re.compile(r"\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{5,}\b|\b\d{7,}\b")


def extract_facts(text: str) -> dict[str, set[str]]:
    text = text or ""
    periods = set()
    for month, year in _PERIOD_RE.findall(text):
        periods.add(f"{year}-{_MONTHS[month.lower()]:02d}")
    for month, year in _PERIOD_NUM_RE.findall(text):
        periods.add(f"{year}-{int(month):02d}")
    dates = {f"{y}-{int(m):02d}-{int(d):02d}" for d, m, y in _DATE_DMY_RE.findall(text)}
    dates |= {f"{y}-{m}-{d}" for y, m, d in _DATE_ISO_RE.findall(text)}
    amounts = {_THOUSANDS_RE.sub("", whole) + "." + cents for whole, cents in _AMOUNT_RE.findall(text)}
    references = set(_REFERENCE_RE.findall(text))
    return {"periods": periods, "dates": dates, "amounts": amounts, "references": references}


def fact_differences(a: str, b: str, limit: int = 12) -> dict[str, dict[str, list[str]]]:
    fa, fb = extract_facts(a), extract_facts(b)
    diff = {}
    for key in fa:
        only_a = sorted(fa[key] - fb[key])[:limit]
        only_b = sorted(fb[key] - fa[key])[:limit]
        if only_a or only_b:
            diff[key] = {"only_a": only_a, "only_b": only_b}
    return diff


def amounts_conflict(a: str, b: str) -> bool:
    """True when both documents list several amounts and share few of them.

    Copies of the same statement or invoice carry the same amounts; small OCR
    differences cost a few, not most.
    """
    fa, fb = extract_facts(a)["amounts"], extract_facts(b)["amounts"]
    if len(fa) < 3 or len(fb) < 3:
        return False
    return jaccard(fa, fb) < 0.5


# ── LLM prompt ───────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You compare two documents from a personal document archive and decide whether they are the SAME document stored twice, or two DIFFERENT documents.

The same document stored twice: a re-scan, a re-upload, or another file of the same letter, statement or invoice. Small OCR differences, a missing page or a different scan quality are fine.

Different documents: anything that describes a different period, date, amount, reference number or recipient - even when the sender, layout and wording are the same. A salary statement for March 2026 and one for March 2025 are DIFFERENT documents. So are two monthly statements of the same account, two invoices with different numbers, or the same form filled in for different people.

Read both texts in full. Use the list of automatically extracted differences as a hint, but check it against the texts (OCR errors happen).

Respond with a single JSON object, no other text:
{"verdict": "duplicate" | "different", "reasoning": "one sentence naming the decisive detail"}"""


def _describe(label: str, doc: dict[str, Any], text: str) -> str:
    return (
        f"=== Document {label} (id={doc['id']}) ===\n"
        f"Title: {doc.get('title') or ''}\n"
        f"Date in Paperless: {doc.get('date') or 'unknown'}\n"
        f"Correspondent: {doc.get('correspondent') or 'unknown'}\n"
        f"Document type: {doc.get('document_type') or 'unknown'}\n"
        f"Pages: {doc.get('page_count') or 'unknown'}\n"
        f"Text ({len(doc.get('content') or '')} characters):\n{text}\n"
    )


def build_user_prompt(doc_a: dict[str, Any], doc_b: dict[str, Any], text_a: str, text_b: str) -> str:
    diff = fact_differences(doc_a.get("content") or "", doc_b.get("content") or "")
    if diff:
        lines = []
        for key, d in diff.items():
            lines.append(f"- {key}: only in A: {', '.join(d['only_a']) or '-'}; only in B: {', '.join(d['only_b']) or '-'}")
        diff_text = "\n".join(lines)
    else:
        diff_text = "- none found"
    return (
        _describe("A", doc_a, text_a) + "\n" + _describe("B", doc_b, text_b)
        + "\nAutomatically extracted differences:\n" + diff_text
    )


# ── Verdict cache ────────────────────────────────────────────────────────────

def pair_key(a: int, b: int) -> str:
    lo, hi = sorted((a, b))
    return f"{lo}-{hi}"


class VerdictCache:
    """LLM verdicts per document pair, valid while neither document changed and the
    model and prompt are the same. Stored as JSON next to the settings."""

    def __init__(self, path: Path, model: str):
        self.path = path
        self.model = model
        # hash() is randomised per process; a stable digest keeps the cache valid
        self.prompt_version = hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:12]
        try:
            self.data: dict[str, Any] = json.loads(path.read_text())
        except (FileNotFoundError, ValueError):
            self.data = {}

    def get(self, a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any] | None:
        entry = self.data.get(pair_key(a["id"], b["id"]))
        if not entry:
            return None
        lo, hi = sorted((a, b), key=lambda d: d["id"])
        if (entry.get("modified") != [lo.get("modified"), hi.get("modified")]
                or entry.get("model") != self.model
                or entry.get("prompt_version") != self.prompt_version):
            return None
        return entry

    def put(self, a: dict[str, Any], b: dict[str, Any], verdict: str, reasoning: str) -> None:
        lo, hi = sorted((a, b), key=lambda d: d["id"])
        self.data[pair_key(a["id"], b["id"])] = {
            "verdict": verdict,
            "reasoning": reasoning,
            "modified": [lo.get("modified"), hi.get("modified")],
            "model": self.model,
            "prompt_version": self.prompt_version,
        }

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data))
        os.replace(tmp, self.path)


# ── Confidence ───────────────────────────────────────────────────────────────

def pair_confidence(verdict: str, similarity: float, text_a: str, text_b: str) -> str | None:
    """'high' only when the LLM, having read both texts in full, says duplicate and
    the amounts do not contradict it. 'possible' when it is unclear. None when the
    LLM says the documents are different."""
    if verdict == "different":
        return None
    if verdict == "duplicate":
        return "possible" if amounts_conflict(text_a, text_b) else "high"
    # LLM failed or inconclusive: only worth showing when the text is nearly the same
    return "possible" if similarity >= 0.6 else None
