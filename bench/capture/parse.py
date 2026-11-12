"""Pure parsing helpers for the ADEMark capture addon.

No mitmproxy import lives here, so the functions are unit-testable on any Python 3.
"""

import hashlib
import json
import os
from typing import Any, Dict, Iterator, List, Mapping

REDACTED_HEADERS = {"authorization", "x-api-key", "cookie", "set-cookie"}
BODY_DIR = "bodies"


def _is_json_text(text: str) -> bool:
    try:
        json.loads(text)
    except ValueError:
        return False
    return True


def body_file_name(sequence: int, body: str) -> str:
    """Relative path of a saved request body, JSON as .json and anything else as .txt."""
    if sequence < 1:
        raise ValueError("body sequence starts at 1")
    suffix = ".json" if _is_json_text(body) else ".txt"
    return f"{BODY_DIR}/{sequence:04d}{suffix}"


def write_request_body(capture_out: str, sequence: int, body: str) -> str:
    """Write one body next to capture.jsonl and return its path relative to the capture folder."""
    relative = body_file_name(sequence, body)
    folder = os.path.dirname(os.path.abspath(capture_out))
    os.makedirs(os.path.join(folder, BODY_DIR), exist_ok=True)
    with open(os.path.join(folder, relative), "w", encoding="utf-8") as handle:
        handle.write(body)
    return relative


def redact_headers(headers: Mapping[str, str]) -> Dict[str, str]:
    """Return a copy of the headers without credentials."""
    return {key: value for key, value in headers.items() if key.lower() not in REDACTED_HEADERS}


def _content_blocks(content: Any) -> List[str]:
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    blocks: List[str] = []
    for part in content:
        if isinstance(part, str):
            blocks.append(part)
        elif isinstance(part, dict) and isinstance(part.get("text"), str):
            blocks.append(part["text"])
    return blocks


def _user_contents(body: Any) -> List[Any]:
    if not isinstance(body, dict):
        return []
    contents: List[Any] = []
    messages = body.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, dict) and message.get("role") == "user":
                contents.append(message.get("content"))
        return contents
    data = body.get("input")
    if isinstance(data, str):
        return [data]
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and item.get("role") == "user":
                contents.append(item.get("content"))
    return contents


def user_text_candidates(body: Any) -> List[str]:
    """Mirror of userTextCandidates in bench/replay/session.ts.

    Every user message contributes the trimmed concatenation of its text, then each text
    block on its own, without empties or duplicates.
    """
    candidates: List[str] = []

    def push(value: str) -> None:
        text = value.strip()
        if not text or text in candidates:
            return
        candidates.append(text)

    for content in _user_contents(body):
        blocks = _content_blocks(content)
        push("".join(blocks))
        for block in blocks:
            push(block)
    return candidates


def _usage(
    input_tokens: int = 0,
    cache_write: int = 0,
    cache_read: int = 0,
    output: int = 0,
) -> Dict[str, int]:
    return {
        "input": input_tokens,
        "cache_write": cache_write,
        "cache_read": cache_read,
        "output": output,
    }


def _iter_sse_json(text: str) -> Iterator[Dict[str, Any]]:
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload:
            continue
        try:
            value = json.loads(payload)
        except ValueError:
            continue
        if isinstance(value, dict):
            yield value


def _with_ttl(result: Dict[str, int], usage: Dict[str, Any]) -> Dict[str, int]:
    """Keep the one-hour part of the cache writes, which has its own price."""
    breakdown = usage.get("cache_creation")
    if isinstance(breakdown, dict):
        result["cache_write_1h"] = breakdown.get("ephemeral_1h_input_tokens", 0) or 0
    return result


def task_hash(body: Any) -> str:
    """Hash of the last user message, or - when it answers a tool: two equal hashes are one task started twice."""
    contents = _user_contents(body)
    if not contents:
        return "-"
    last = contents[-1]
    if isinstance(last, list) and any(isinstance(part, dict) and part.get("type") == "tool_result" for part in last):
        return "-"
    candidates = user_text_candidates({"messages": [{"role": "user", "content": last}]})
    if not candidates:
        return "-"
    # The last block is the task: reminders come before it, and they can differ between two sends. The tool count keeps a
    # title call that carries the same text apart from the working thread.
    tools = body.get("tools") if isinstance(body, dict) else None
    count = len(tools) if isinstance(tools, list) else 0
    return f"{hashlib.sha256(candidates[-1].encode('utf-8')).hexdigest()}:{count}"


def message_id_from_sse(text: str) -> str | None:
    """The id of an Anthropic answer, which a thread continuation names."""
    for event in _iter_sse_json(text):
        if event.get("type") == "message_start":
            message = event.get("message")
            identity = message.get("id") if isinstance(message, dict) else None
            return identity if isinstance(identity, str) else None
    return None


def usage_from_anthropic_sse(text: str) -> Dict[str, int] | None:
    """Anthropic input usage from message_start, final output from message_delta."""
    input_tokens = 0
    cache_write = 0
    cache_read = 0
    output = 0
    found = False
    start_usage: Dict[str, Any] = {}
    for event in _iter_sse_json(text):
        kind = event.get("type")
        if kind == "message_start":
            message = event.get("message")
            usage = message.get("usage") if isinstance(message, dict) else None
            if isinstance(usage, dict):
                input_tokens = usage.get("input_tokens", 0) or 0
                cache_write = usage.get("cache_creation_input_tokens", 0) or 0
                cache_read = usage.get("cache_read_input_tokens", 0) or 0
                start_usage = usage
                found = True
        elif kind == "message_delta":
            usage = event.get("usage")
            if isinstance(usage, dict) and "output_tokens" in usage:
                output = usage.get("output_tokens", 0) or 0
                found = True
    if not found:
        return None
    return _with_ttl(_usage(input_tokens, cache_write, cache_read, output), start_usage)


def usage_from_openai_sse(text: str) -> Dict[str, int] | None:
    """OpenAI usage comes on the final response.completed event."""
    for event in _iter_sse_json(text):
        if event.get("type") != "response.completed":
            continue
        response = event.get("response")
        usage = response.get("usage") if isinstance(response, dict) else None
        if not isinstance(usage, dict):
            continue
        details = usage.get("input_tokens_details")
        cached = details.get("cached_tokens", 0) if isinstance(details, dict) else 0
        return _usage(
            usage.get("input_tokens", 0) or 0,
            0,
            cached or 0,
            usage.get("output_tokens", 0) or 0,
        )
    return None


def usage_from_json(body: Any, api: str) -> Dict[str, int] | None:
    """Usage from a non-streaming Anthropic or OpenAI response body."""
    if not isinstance(body, dict):
        return None
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None
    if api == "anthropic":
        return _with_ttl(
            _usage(
                usage.get("input_tokens", 0) or 0,
                usage.get("cache_creation_input_tokens", 0) or 0,
                usage.get("cache_read_input_tokens", 0) or 0,
                usage.get("output_tokens", 0) or 0,
            ),
            usage,
        )
    if api == "openai":
        details = usage.get("input_tokens_details")
        cached = details.get("cached_tokens", 0) if isinstance(details, dict) else 0
        return _usage(
            usage.get("input_tokens", 0) or 0,
            0,
            cached or 0,
            usage.get("output_tokens", 0) or 0,
        )
    return None
