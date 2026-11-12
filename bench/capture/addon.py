"""mitmproxy addon that records every model API request for ADEMark.

Run with the capture proxy:

    mitmdump --mode local -s bench/capture/addon.py

One CaptureRow JSON line per response is appended to the file named by the environment
variable ADEMARK_CAPTURE_OUT. Streamed SSE answers are passed through chunk by chunk, so
the ADE is not slowed down; only the three model API hosts are recorded.
"""

import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from parse import (  # noqa: E402
    message_id_from_sse,
    task_hash,
    usage_from_anthropic_sse,
    usage_from_json,
    usage_from_openai_sse,
    user_text_candidates,
    write_request_body,
)

API_HOSTS = {"api.anthropic.com", "api.openai.com", "chatgpt.com"}
CHUNK_KEY = "ademark_chunks"
BODY_SEQUENCE = 0


def _now_ns() -> int:
    try:
        return time.clock_gettime_ns(time.CLOCK_UPTIME_RAW)
    except (AttributeError, ValueError):
        raise RuntimeError("CLOCK_UPTIME_RAW unavailable")


def _api_for(path: str):
    if "/v1/messages" in path:
        return "anthropic"
    if "/v1/responses" in path or path.endswith("/responses") or "/backend-api/" in path:
        return "openai"
    return None


def _client_meta(flow):
    # validate in pilot: local mode may not expose the client pid or process here.
    pid = None
    process = None
    try:
        connection = flow.client_conn
        pid = getattr(connection, "pid", None)
        process = getattr(connection, "process", None)
        metadata = getattr(connection, "metadata", None) or {}
        if pid is None:
            pid = metadata.get("client_pid") or metadata.get("pid")
        if process is None:
            process = metadata.get("client_process") or metadata.get("process")
    except Exception:
        pass
    return pid, process


def _request_json(flow):
    try:
        return json.loads(flow.request.get_text() or "")
    except Exception:
        return None


def _next_body_sequence() -> int:
    global BODY_SEQUENCE
    BODY_SEQUENCE += 1
    return BODY_SEQUENCE


def _save_body(flow) -> str | None:
    out = os.environ.get("ADEMARK_CAPTURE_OUT")
    if not out:
        return None
    body = flow.request.get_text() or ""
    try:
        return write_request_body(out, _next_body_sequence(), body)
    except OSError:
        return None


def _model(flow):
    body = _request_json(flow)
    return body.get("model") if isinstance(body, dict) else None


def _user_text_hashes(flow):
    body = _request_json(flow)
    if body is None:
        return []
    return [hashlib.sha256(text.encode("utf-8")).hexdigest() for text in user_text_candidates(body)]


def _row(flow, usage, chunk_t_ns, message_id=None):
    pid, process = _client_meta(flow)
    return {
        "t_ns": _now_ns(),
        "request_id": flow.response.headers.get("request-id"),
        "host": flow.request.pretty_host,
        "path": flow.request.path,
        "pid": pid,
        "process": process,
        "model": _model(flow),
        "user_agent": flow.request.headers.get("user-agent"),
        "req_bytes": len(flow.request.raw_content or b""),
        "status": flow.response.status_code,
        "usage": usage,
        "message_id": message_id,
        "main_thread": None,
        "user_text_sha256": _user_text_hashes(flow),
        "chunk_t_ns": list(chunk_t_ns),
        "body_file": _save_body(flow),
    }


def _write(flow, usage, chunk_t_ns, message_id=None) -> None:
    out = os.environ.get("ADEMARK_CAPTURE_OUT")
    if not out:
        return
    with open(out, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(_row(flow, usage, chunk_t_ns, message_id)) + "\n")


def _is_sse(flow) -> bool:
    content_type = flow.response.headers.get("content-type", "")
    return "text/event-stream" in content_type


def _note_request(flow) -> None:
    """A model call is on its way: rows arrive only when the answer ends, and the harness has to know sooner."""
    out = os.environ.get("ADEMARK_CAPTURE_OUT")
    path = flow.request.path.split("?")[0]
    if not out or path.endswith("/count_tokens") or _api_for(path) is None:
        return
    with open(out + ".requests", "a", encoding="utf-8") as handle:
        handle.write(f"{_now_ns()} {task_hash(_request_json(flow))}\n")


def requestheaders(flow) -> None:
    # A compressed stream cannot be read chunk by chunk, and a call with unknown usage invalidates its row.
    if flow.request.pretty_host in API_HOSTS:
        flow.request.headers["accept-encoding"] = "identity"


def request(flow) -> None:
    # The body exists from this hook on, and the request has not left yet.
    if flow.request.pretty_host in API_HOSTS:
        _note_request(flow)


def responseheaders(flow) -> None:
    if flow.request.pretty_host not in API_HOSTS or not _is_sse(flow):
        return
    chunks = []
    flow.metadata[CHUNK_KEY] = chunks

    def record(data: bytes) -> bytes:
        chunks.append((_now_ns(), data))
        return data

    flow.response.stream = record


def response(flow) -> None:
    if flow.request.pretty_host not in API_HOSTS:
        return
    if _is_sse(flow):
        chunks = flow.metadata.get(CHUNK_KEY) or []
        text = b"".join(data for _, data in chunks).decode("utf-8", "replace")
        api = _api_for(flow.request.path)
        if api == "anthropic":
            usage = usage_from_anthropic_sse(text)
        elif api == "openai":
            usage = usage_from_openai_sse(text)
        else:
            usage = None
        message_id = message_id_from_sse(text) if api == "anthropic" else None
        _write(flow, usage, [timestamp for timestamp, _ in chunks], message_id)
        return
    api = _api_for(flow.request.path)
    if api is None:
        return
    try:
        body = json.loads(flow.response.get_text() or "")
    except Exception:
        body = None
    identity = body.get("id") if isinstance(body, dict) else None
    _write(flow, usage_from_json(body, api), [], identity if isinstance(identity, str) else None)
