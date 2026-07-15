import unittest

from aamp_sdk import (
    build_dispatch_headers,
    build_result_headers,
    parse_aamp_headers,
    parse_dispatch_context_header,
    serialize_dispatch_context_header,
)


class ProtocolTests(unittest.TestCase):
    def test_dispatch_context_round_trip(self) -> None:
        value = serialize_dispatch_context_header({"project_key": "proj 123", "user_key": "alice"})
        self.assertEqual(value, "project_key=proj%20123; user_key=alice")
        self.assertEqual(
            parse_dispatch_context_header(value),
            {"project_key": "proj 123", "user_key": "alice"},
        )

    def test_build_dispatch_headers(self) -> None:
        headers = build_dispatch_headers(
            "task-1",
            priority="urgent",
            dispatch_context={"project_key": "proj-1"},
            session_key="  p2p:ou_sender  ",
        )
        self.assertEqual(headers["X-AAMP-Intent"], "task.dispatch")
        self.assertEqual(headers["X-AAMP-TaskId"], "task-1")
        self.assertEqual(headers["X-AAMP-Session-Key"], "p2p:ou_sender")

    def test_dispatch_session_key_round_trip(self) -> None:
        headers = build_dispatch_headers("task-session", session_key="thread:demo-1")
        parsed = parse_aamp_headers(
            {
                "from": "dispatcher@example.com",
                "to": "agent@example.com",
                "subject": "[AAMP Task] Continue task",
                "messageId": "<msg-session@example.com>",
                "bodyText": "Continue the previous task.",
                "headers": headers,
            }
        )
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["sessionKey"], "thread:demo-1")

    def test_blank_session_key_is_omitted(self) -> None:
        headers = build_dispatch_headers("task-blank", session_key="   ")
        self.assertNotIn("X-AAMP-Session-Key", headers)

    def test_parse_task_result(self) -> None:
        headers = build_result_headers(
            "task-2",
            status="completed",
            output="done",
            structured_result=[{"fieldKey": "summary", "value": "done"}],
        )
        parsed = parse_aamp_headers(
            {
                "from": "agent@example.com",
                "to": "dispatcher@example.com",
                "subject": "[AAMP Result] Task task-2 - completed",
                "messageId": "<msg-2@example.com>",
                "bodyText": "Output:\ndone",
                "headers": headers,
            }
        )
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["intent"], "task.result")
        self.assertEqual(parsed["output"], "done")
        self.assertEqual(parsed["structuredResult"][0]["fieldKey"], "summary")


if __name__ == "__main__":
    unittest.main()
