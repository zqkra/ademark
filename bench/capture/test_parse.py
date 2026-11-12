"""Unit tests for parse.py. Run: python3 -m unittest discover -s bench/capture -p 'test_*.py'"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import parse

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


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

OPENAI_SSE = "\n".join(
    [
        "event: response.created",
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"hi"}',
        "",
        "event: response.completed",
        "data: "
        + '{"type":"response.completed","response":{"id":"resp_1","usage":'
        + '{"input_tokens":200,"input_tokens_details":{"cached_tokens":80},'
        + '"output_tokens":70,"total_tokens":270}}}',
        "",
    ]
)


class BodyFilesTest(unittest.TestCase):
    def test_sequence_and_suffix(self):
        self.assertEqual(parse.body_file_name(1, '{"a":1}'), "bodies/0001.json")
        self.assertEqual(parse.body_file_name(42, "raw body"), "bodies/0042.txt")
        with self.assertRaises(ValueError):
            parse.body_file_name(0, "{}")

    def test_write_next_to_the_capture_file(self):
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "run", "capture.jsonl")
            os.makedirs(os.path.dirname(out))
            relative = parse.write_request_body(out, 3, '{"model":"m"}')
            self.assertEqual(relative, "bodies/0003.json")
            path = os.path.join(os.path.dirname(out), "bodies", "0003.json")
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(json.load(handle), {"model": "m"})


class RedactHeadersTest(unittest.TestCase):
    def test_drops_credentials_case_insensitively(self):
        headers = {
            "Authorization": "Bearer secret",
            "X-API-KEY": "sk-secret",
            "Cookie": "a=b",
            "Set-Cookie": "c=d",
            "content-type": "application/json",
            "user-agent": "Claude-Code/1.0",
        }
        redacted = parse.redact_headers(headers)
        self.assertEqual(
            redacted,
            {"content-type": "application/json", "user-agent": "Claude-Code/1.0"},
        )

    def test_keeps_everything_else(self):
        self.assertEqual(parse.redact_headers({}), {})


class UserTextCandidatesTest(unittest.TestCase):
    def test_user_texts_fixture(self):
        with open(os.path.join(FIXTURES, "user-texts.json"), encoding="utf-8") as handle:
            cases = json.load(handle)
        self.assertEqual(len(cases), 3)
        for case in cases:
            with self.subTest(case["name"]):
                self.assertEqual(parse.user_text_candidates(case["body"]), case["candidates"])

    def test_missing_and_empty_forms(self):
        self.assertEqual(parse.user_text_candidates(None), [])
        self.assertEqual(parse.user_text_candidates({"messages": []}), [])
        self.assertEqual(parse.user_text_candidates({"messages": [{"role": "user", "content": "  "}]}), [])


class AnthropicSseTest(unittest.TestCase):
    def test_all_categories(self):
        self.assertEqual(
            parse.usage_from_anthropic_sse(ANTHROPIC_SSE),
            {"input": 120, "cache_write": 30, "cache_read": 400, "output": 55},
        )

    def test_message_delta_output_wins(self):
        text = ANTHROPIC_SSE.replace('"output_tokens":1}', '"output_tokens":9}')
        usage = parse.usage_from_anthropic_sse(text)
        self.assertEqual(usage["output"], 55)

    def test_no_usage_returns_none(self):
        self.assertIsNone(parse.usage_from_anthropic_sse("data: not json\n\n"))

    def test_missing_cache_fields_default_to_zero(self):
        text = '\n'.join(
            [
                "data: "
                + '{"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}',
                "",
                'data: {"type":"message_delta","usage":{"output_tokens":3}}',
                "",
            ]
        )
        self.assertEqual(
            parse.usage_from_anthropic_sse(text),
            {"input": 7, "cache_write": 0, "cache_read": 0, "output": 3},
        )


class OpenAiSseTest(unittest.TestCase):
    def test_response_completed_usage(self):
        self.assertEqual(
            parse.usage_from_openai_sse(OPENAI_SSE),
            {"input": 200, "cache_write": 0, "cache_read": 80, "output": 70},
        )

    def test_without_completed_event(self):
        self.assertIsNone(parse.usage_from_openai_sse(OPENAI_SSE.split("event: response.completed")[0]))


class JsonUsageTest(unittest.TestCase):
    def test_anthropic_body(self):
        body = {
            "usage": {
                "input_tokens": 11,
                "cache_creation_input_tokens": 2,
                "cache_read_input_tokens": 3,
                "output_tokens": 4,
            }
        }
        self.assertEqual(
            parse.usage_from_json(body, "anthropic"),
            {"input": 11, "cache_write": 2, "cache_read": 3, "output": 4},
        )

    def test_openai_body(self):
        body = {
            "usage": {
                "input_tokens": 50,
                "input_tokens_details": {"cached_tokens": 12},
                "output_tokens": 13,
            }
        }
        self.assertEqual(
            parse.usage_from_json(body, "openai"),
            {"input": 50, "cache_write": 0, "cache_read": 12, "output": 13},
        )

    def test_unknown_api_and_no_usage(self):
        self.assertIsNone(parse.usage_from_json({"usage": {}}, "other"))
        self.assertIsNone(parse.usage_from_json({}, "anthropic"))
        self.assertIsNone(parse.usage_from_json(None, "openai"))


if __name__ == "__main__":
    unittest.main()
