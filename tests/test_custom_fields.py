"""Guard against wiping user custom fields in Paperless.

Paperless treats `custom_fields` in a document PATCH as the complete set and
deletes every field that is left out. These tests use a fake Paperless with
that same behaviour.
"""
import asyncio
import re
from pathlib import Path

import httpx

from app import main

USER_FIELD = 5        # e.g. "Status Rekening", owned by the user
LLM_QUALITY = 8       # field this tool writes


class FakePaperless:
    def __init__(self):
        self.custom_fields = {7: [{"field": USER_FIELD, "value": "paid-option-id"}]}

    def handler(self, request: httpx.Request) -> httpx.Response:
        doc_id = int(request.url.path.rstrip("/").split("/")[-1])
        if request.method == "GET":
            return httpx.Response(200, json={"id": doc_id, "custom_fields": self.custom_fields[doc_id]})
        if request.method == "PATCH":
            body = httpx.Response(200, content=request.content).json()
            if "custom_fields" in body:
                # Replace semantics, like the real Paperless serializer
                self.custom_fields[doc_id] = body["custom_fields"]
            return httpx.Response(200, json={"id": doc_id})
        return httpx.Response(405)


def settings():
    return main.AppSettings(
        paperless_base_url="http://paperless", paperless_token="x",
        ollama_base_url="http://ollama", ollama_model="m",
    )


def test_merged_write_keeps_user_fields():
    fake = FakePaperless()

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as client:
            fields = await main.merged_custom_fields(client, settings(), 7, {LLM_QUALITY: 95})
            await client.patch("http://paperless/api/documents/7/", json={"custom_fields": fields})

    asyncio.run(run())
    values = {cf["field"]: cf["value"] for cf in fake.custom_fields[7]}
    assert values == {USER_FIELD: "paid-option-id", LLM_QUALITY: 95}


def test_failed_read_does_not_write():
    def handler(request):
        if request.method == "GET":
            return httpx.Response(500)
        raise AssertionError("PATCH must not be sent when the current fields could not be read")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await main.merged_custom_fields(client, settings(), 7, {LLM_QUALITY: 95})

    try:
        asyncio.run(run())
    except httpx.HTTPStatusError:
        return
    raise AssertionError("expected an error")


def test_every_custom_fields_write_goes_through_merge():
    """Any payload that sets "custom_fields" must be built by merged_custom_fields."""
    source = Path(main.__file__).read_text()
    pattern = r'\["custom_fields"\]\s*=|json=\{\s*"custom_fields"'
    offenders = []
    for m in re.finditer(pattern, source):
        window = source[max(0, m.start() - 300):m.end() + 200]
        if "merged_custom_fields" not in window:
            offenders.append(source[:m.start()].count("\n") + 1)
    assert list(re.finditer(pattern, source)), "pattern no longer matches any write; update this test"
    assert not offenders, f"custom_fields written without merged_custom_fields at lines {offenders}"
