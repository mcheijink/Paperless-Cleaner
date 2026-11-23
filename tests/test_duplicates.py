"""Duplicate detection logic. All documents here are invented."""
from app import duplicates as dup


def salary(month: str, year: int, gross: str, net: str) -> str:
    return (
        "Musterfirma GmbH · Beispielstraße 1 · 12345 Beispielstadt\n"
        f"Entgeltabrechnung für {month} {year}\n"
        "Personalnummer 004711 Steuerklasse 3 Kinderfreibetrag 1,0\n"
        f"Gesamtbrutto {gross} Steuerbrutto {gross} Lohnsteuer 312,40 "
        f"Solidaritätszuschlag 0,00 Krankenversicherung 287,15 Auszahlungsbetrag {net}\n"
        "Bankverbindung DE00 1234 5678 9012 3456 78 Beispielbank\n"
    ) * 3


MARCH_2026 = salary("März", 2026, "4.250,00", "2.811,23")
MARCH_2025 = salary("März", 2025, "4.100,00", "2.744,90")


def test_salary_statements_of_different_years_differ_in_facts():
    diff = dup.fact_differences(MARCH_2026, MARCH_2025)
    assert diff["periods"] == {"only_a": ["2026-03"], "only_b": ["2025-03"]}
    assert "4250.00" in diff["amounts"]["only_a"]
    assert "4100.00" in diff["amounts"]["only_b"]


def test_rescan_with_ocr_noise_has_no_period_or_amount_difference():
    rescan = MARCH_2026.replace("Beispielstraße", "Beispielstrasse").replace("Steuerklasse", "Steuerk1asse")
    diff = dup.fact_differences(MARCH_2026, rescan)
    assert "periods" not in diff and "amounts" not in diff
    assert dup.jaccard(dup.shingles(MARCH_2026), dup.shingles(rescan)) > 0.6


def test_extract_facts_formats():
    facts = dup.extract_facts("Rechnung vom 03.11.2026, Zeitraum 10/2026, Betrag 1.234,56 EUR, Ref AB-1234567")
    assert facts["dates"] == {"2026-11-03"}
    assert "2026-10" in facts["periods"]
    assert facts["amounts"] == {"1234.56"}
    assert "AB-1234567" in facts["references"]


def test_user_prompt_contains_full_text_and_differences():
    long_a = MARCH_2026 + "x " * 5000          # ~10k characters, far beyond the old 3000
    a = {"id": 1, "title": "Gehalt März", "content": long_a, "date": "2026-03-25"}
    b = {"id": 2, "title": "Gehalt März", "content": MARCH_2025, "date": "2025-03-25"}
    prompt = dup.build_user_prompt(a, b, long_a, MARCH_2025)
    assert long_a in prompt and MARCH_2025 in prompt
    assert "periods: only in A: 2026-03; only in B: 2025-03" in prompt
    assert "March 2025 are DIFFERENT documents" in dup.SYSTEM_PROMPT


def test_confidence_high_only_when_llm_says_duplicate():
    assert dup.pair_confidence("duplicate", 0.9, MARCH_2026, MARCH_2026) == "high"
    assert dup.pair_confidence("different", 0.99, MARCH_2026, MARCH_2026) is None
    # LLM failed: shown as possible only when the text is nearly the same
    assert dup.pair_confidence("unknown", 0.7, MARCH_2026, MARCH_2026) == "possible"
    assert dup.pair_confidence("unknown", 0.4, MARCH_2026, MARCH_2025) is None


def test_llm_duplicate_is_downgraded_when_amounts_conflict():
    assert dup.pair_confidence("duplicate", 0.5, MARCH_2026, MARCH_2025) == "possible"


def test_content_candidates_find_pairs_regardless_of_metadata():
    docs = {1: MARCH_2026, 2: MARCH_2026.replace("Steuerklasse", "Steuerk1asse"), 3: "völlig anderer Text " * 50}
    pairs = dup.content_candidate_pairs({i: dup.shingles(t) for i, t in docs.items()}, 0.3)
    assert (1, 2) in pairs and (1, 3) not in pairs and (2, 3) not in pairs


def test_verdict_cache_invalidates_on_change(tmp_path):
    path = tmp_path / "verdicts.json"
    a = {"id": 5, "modified": "2026-11-01T10:00:00Z"}
    b = {"id": 3, "modified": "2026-11-02T10:00:00Z"}
    cache = dup.VerdictCache(path, "qwen3.5:9b")
    cache.put(a, b, "different", "other year")
    cache.save()

    reloaded = dup.VerdictCache(path, "qwen3.5:9b")
    assert reloaded.get(b, a)["verdict"] == "different"          # order does not matter
    assert reloaded.get({**a, "modified": "2026-11-23T09:00:00Z"}, b) is None   # document changed
    assert dup.VerdictCache(path, "other-model").get(a, b) is None              # model changed
