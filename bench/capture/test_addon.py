"""Tests for addon.py with small fake flow classes; no mitmproxy import.

Run: python3 -m unittest discover -s bench/capture -p 'test_*.py'
"""

import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import addon


ANTHROPIC_SSE = "\n".join(
    [
        "event: message_start",
        "data: "
        + '{"type":"message_start","message":{"id":"msg_1","usage":'
        + '{"input_tokens":120,"cache_creation_input_tokens":30,"cache_read_input_tokens":400,"output_tokens":1}}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":55}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
    ]
)

REQUEST_BODY = json.dumps(
    {"model": "claude-opus-5-5", "messages": [{"role": "user", "content": "hi"}]}
)


class FakeHeaders(dict):
    def get(self, key, default=None):
        for name, value in self.items():
            if name.lower() == key.lower():
                return value
        return default


class FakeRequest:
    def __init__(self, body, path="/v1/messages", host="api.anthropic.com"):
        self._body = body
        self.path = path
        self.pretty_host = host
        self.headers = FakeHeaders({"user-agent": "claude-cli/2.1.303"})
        self.raw_content = body.encode("utf-8")

    def get_text(self):
        return self._body


class FakeResponse:
    def __init__(self, content_type, body="", status_code=200):
        self.headers = FakeHeaders({"content-type": content_type})
        self._body = body
        self.status_code = status_code

    def get_text(self):
        return self._body


class FakeFlow:
    def __init__(self, request, response):
        self.request = request
        self.response = response
        self.metadata = {}


class AddonTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.temp.name, "capture.jsonl")
        self.previous = os.environ.get("ADEMARK_CAPTURE_OUT")
        os.environ["ADEMARK_CAPTURE_OUT"] = self.out
        addon.BODY_SEQUENCE = 0

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("ADEMARK_CAPTURE_OUT", None)
        else:
            os.environ["ADEMARK_CAPTURE_OUT"] = self.previous
        self.temp.cleanup()

    def read_rows(self):
        with open(self.out, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def test_streamed_sse_records_three_chunks(self):
        flow = FakeFlow(FakeRequest(REQUEST_BODY), FakeResponse("text/event-stream"))
        addon.responseheaders(flow)
        data = ANTHROPIC_SSE.encode("utf-8")
        third = len(data) // 3
        chunks = [data[:third], data[third : 2 * third], data[2 * third :]]
        for chunk in chunks:
            self.assertEqual(flow.response.stream(chunk), chunk)
        addon.response(flow)

        rows = self.read_rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(
            row["usage"],
            {"input": 120, "cache_write": 30, "cache_read": 400, "output": 55},
        )
        self.assertEqual(len(row["chunk_t_ns"]), 3)
        self.assertEqual(row["user_text_sha256"], [hashlib.sha256(b"hi").hexdigest()])
        self.assertIsNone(row["main_thread"])
        self.assertEqual(row["host"], "api.anthropic.com")
        self.assertEqual(row["model"], "claude-opus-5-5")
        self.assertEqual(row["status"], 200)
        self.assertEqual(row["body_file"], "bodies/0001.json")

    def test_body_files_use_a_sequence_and_store_no_headers(self):
        for _ in range(2):
            flow = FakeFlow(FakeRequest(REQUEST_BODY), FakeResponse("text/event-stream"))
            addon.responseheaders(flow)
            addon.response(flow)

        rows = self.read_rows()
        self.assertEqual([row["body_file"] for row in rows], ["bodies/0001.json", "bodies/0002.json"])
        bodies = os.path.join(self.temp.name, "bodies")
        self.assertEqual(sorted(os.listdir(bodies)), ["0001.json", "0002.json"])
        with open(os.path.join(bodies, "0001.json"), encoding="utf-8") as handle:
            saved = handle.read()
        self.assertEqual(json.loads(saved), json.loads(REQUEST_BODY))
        self.assertNotIn("claude-cli/2.1.303", saved)
        self.assertNotIn("x-api-key", saved.lower())

    def test_task_hash_is_equal_for_one_task_and_empty_for_a_tool_answer(self):
        from parse import task_hash

        body = {"messages": [{"role": "user", "content": [{"type": "text", "text": "explain"}]}]}
        same = {"messages": [{"role": "user", "content": "explain"}]}
        other = {"messages": [{"role": "user", "content": "write a title"}]}
        tool = {"messages": [{"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}]}
        self.assertEqual(task_hash(body), task_hash(same))
        self.assertNotEqual(task_hash(body), task_hash(other))
        self.assertEqual(task_hash(tool), "-")
        self.assertEqual(task_hash(None), "-")
        reminded = {"messages": [{"role": "user", "content": [{"type": "text", "text": "date: today"}, {"type": "text", "text": "explain"}]}]}
        self.assertEqual(task_hash(reminded), task_hash(body))
        titled = {"messages": body["messages"], "tools": [{"name": "Read"}]}
        self.assertNotEqual(task_hash(titled), task_hash(body))

    def test_non_json_bodies_are_written_as_txt(self):
        flow = FakeFlow(FakeRequest("not json at all"), FakeResponse("application/json", "{}"))
        addon.response(flow)

        rows = self.read_rows()
        self.assertEqual(rows[0]["body_file"], "bodies/0001.txt")
        with open(os.path.join(self.temp.name, "bodies", "0001.txt"), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "not json at all")

    def test_non_streamed_json_records_empty_chunks(self):
        body = json.dumps(
            {
                "usage": {
                    "input_tokens": 7,
                    "cache_creation_input_tokens": 1,
                    "cache_read_input_tokens": 2,
                    "output_tokens": 3,
                }
            }
        )
        flow = FakeFlow(FakeRequest(REQUEST_BODY), FakeResponse("application/json", body))
        addon.response(flow)

        rows = self.read_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["usage"],
            {"input": 7, "cache_write": 1, "cache_read": 2, "output": 3},
        )
        self.assertEqual(rows[0]["chunk_t_ns"], [])
        self.assertEqual(rows[0]["user_text_sha256"], [hashlib.sha256(b"hi").hexdigest()])
        self.assertEqual(rows[0]["body_file"], "bodies/0001.json")


if __name__ == "__main__":
    unittest.main()
