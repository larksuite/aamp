import base64
import json
import threading
import time
import unittest
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from aamp_sdk import AampClient, Attachment


def _decode_basic_auth(header_value: str) -> str:
    token = header_value.split(" ", 1)[1]
    return base64.b64decode(token.encode("ascii")).decode("utf-8").split(":", 1)[0]


@dataclass
class MockAttachment:
    blob_id: str
    filename: str
    content_type: str
    content: bytes


@dataclass
class MockMessage:
    message_id: str
    subject: str
    text: str
    from_email: str
    to_email: str
    headers: dict[str, str]
    state: int
    received_at: str
    attachments: list[MockAttachment] = field(default_factory=list)


class MockAampService:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.append_delay_secs = 0.0
        self.current_state = 0
        self.next_message = 0
        self.next_blob = 0
        self.next_stream = 0
        self.messages: list[MockMessage] = []
        self.streams: dict[str, dict] = {}

    def store_message(
        self,
        *,
        from_email: str,
        to_email: str,
        subject: str,
        text: str,
        headers: dict[str, str],
        attachments: list[dict],
    ) -> str:
        with self.lock:
            self.current_state += 1
            self.next_message += 1
            message_id = f"<msg-{self.next_message}@mock.local>"
            message_attachments: list[MockAttachment] = []
            for attachment in attachments:
                self.next_blob += 1
                message_attachments.append(
                    MockAttachment(
                        blob_id=f"blob-{self.next_blob}",
                        filename=attachment["filename"],
                        content_type=attachment["contentType"],
                        content=base64.b64decode(attachment["content"].encode("ascii")),
                    )
                )
            self.messages.append(
                MockMessage(
                    message_id=message_id,
                    subject=subject,
                    text=text,
                    from_email=from_email,
                    to_email=to_email,
                    headers=headers,
                    state=self.current_state,
                    received_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    attachments=message_attachments,
                )
            )
            return message_id

    def mailbox_messages(self, email: str) -> list[MockMessage]:
        with self.lock:
            return [message for message in self.messages if message.to_email == email]

    def get_message(self, email: str, message_id: str) -> MockMessage | None:
        with self.lock:
            for message in self.messages:
                if message.to_email == email and message.message_id == message_id:
                    return message
        return None

    def get_blob(self, email: str, blob_id: str) -> MockAttachment | None:
        with self.lock:
            for message in self.messages:
                if message.to_email != email:
                    continue
                for attachment in message.attachments:
                    if attachment.blob_id == blob_id:
                        return attachment
        return None

    def create_stream(self, owner_email: str, task_id: str, peer_email: str) -> dict:
        with self.lock:
            for stream in self.streams.values():
                if stream["taskId"] == task_id and stream["status"] != "closed":
                    return dict(stream)
            self.next_stream += 1
            stream = {
                "streamId": f"stream-{self.next_stream}",
                "taskId": task_id,
                "status": "created",
                "ownerEmail": owner_email,
                "peerEmail": peer_email,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "events": [],
            }
            self.streams[stream["streamId"]] = stream
            return dict(stream)

    def append_stream_event(self, stream_id: str, event_type: str, payload: dict) -> dict:
        if self.append_delay_secs > 0:
            time.sleep(self.append_delay_secs)
        with self.lock:
            stream = self.streams[stream_id]
            event = {
                "id": f"{stream_id}-{len(stream['events']) + 1}",
                "streamId": stream_id,
                "taskId": stream["taskId"],
                "seq": len(stream["events"]) + 1,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "type": event_type,
                "payload": payload,
            }
            stream["events"].append(event)
            stream["latestEvent"] = event
            if event_type == "done":
                stream["status"] = "closed"
            return dict(event)

    def close_stream(self, stream_id: str, payload: dict) -> dict:
        with self.lock:
            stream = self.streams[stream_id]
            stream["status"] = "closed"
            stream["closedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            if payload:
                stream["latestEvent"] = {
                    "id": f"{stream_id}-done",
                    "streamId": stream_id,
                    "taskId": stream["taskId"],
                    "seq": len(stream["events"]) + 1,
                    "timestamp": stream["closedAt"],
                    "type": "done",
                    "payload": payload,
                }
            return {key: value for key, value in stream.items() if key != "events"}

    def get_stream(self, task_id: str | None, stream_id: str | None) -> dict:
        with self.lock:
            if stream_id and stream_id in self.streams:
                stream = self.streams[stream_id]
                return {key: value for key, value in stream.items() if key != "events"}
            for stream in self.streams.values():
                if task_id and stream["taskId"] == task_id:
                    return {key: value for key, value in stream.items() if key != "events"}
        raise KeyError("stream not found")


class MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    @property
    def state(self) -> MockAampService:
        return self.server.mock_state  # type: ignore[attr-defined]

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/.well-known/aamp":
            self._json(
                200,
                {
                    "protocol": "aamp",
                    "version": "1.1",
                    "api": {"url": "/api/aamp"},
                    "capabilities": {
                        "stream": {
                            "transport": "sse",
                            "createAction": "aamp.stream.create",
                            "appendAction": "aamp.stream.append",
                            "closeAction": "aamp.stream.close",
                            "getAction": "aamp.stream.get",
                        }
                    },
                },
            )
            return
        if parsed.path == "/.well-known/jmap":
            self._json(
                200,
                {
                    "primaryAccounts": {"urn:ietf:params:jmap:mail": "acc-1"},
                    "accounts": {"acc-1": {"name": "mock"}},
                    "downloadUrl": f"http://127.0.0.1:{self.server.server_address[1]}/jmap/download/{{accountId}}/{{blobId}}/{{name}}",
                },
            )
            return
        if parsed.path == "/api/aamp":
            auth_email = _decode_basic_auth(self.headers["Authorization"])
            action = parse_qs(parsed.query).get("action", [""])[0]
            if action == "aamp.stream.get":
                stream = self.state.get_stream(
                    task_id=parse_qs(parsed.query).get("taskId", [None])[0],
                    stream_id=parse_qs(parsed.query).get("streamId", [None])[0],
                )
                self._json(200, stream)
                return
            self._json(404, {"error": f"unsupported action {action} for {auth_email}"})
            return
        if parsed.path.startswith("/jmap/download/"):
            auth_email = _decode_basic_auth(self.headers["Authorization"])
            _prefix, _jmap, _download, _account, blob_id, _name = parsed.path.split("/", 5)
            attachment = self.state.get_blob(auth_email, blob_id)
            if not attachment:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", attachment.content_type)
            self.send_header("Content-Length", str(len(attachment.content)))
            self.end_headers()
            self.wfile.write(attachment.content)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length) if content_length else b""
        payload = json.loads(body.decode("utf-8") or "{}")

        if parsed.path == "/api/aamp":
            auth_email = _decode_basic_auth(self.headers["Authorization"])
            action = parse_qs(parsed.query).get("action", [""])[0]
            if action == "aamp.mailbox.send":
                message_id = self.state.store_message(
                    from_email=auth_email,
                    to_email=payload["to"],
                    subject=payload["subject"],
                    text=payload["text"],
                    headers=payload.get("aampHeaders") or {},
                    attachments=payload.get("attachments") or [],
                )
                self._json(200, {"ok": True, "messageId": message_id})
                return
            if action == "aamp.stream.create":
                self._json(200, self.state.create_stream(auth_email, payload["taskId"], payload["peerEmail"]))
                return
            if action == "aamp.stream.append":
                self._json(200, self.state.append_stream_event(payload["streamId"], payload["type"], payload["payload"]))
                return
            if action == "aamp.stream.close":
                self._json(200, self.state.close_stream(payload["streamId"], payload.get("payload") or {}))
                return
            self._json(404, {"error": f"unsupported action {action}"})
            return

        if parsed.path == "/jmap/":
            auth_email = _decode_basic_auth(self.headers["Authorization"])
            responses = []
            for method_name, args, tag in payload.get("methodCalls") or []:
                if method_name == "Email/get":
                    ids = args.get("ids") or []
                    if not ids:
                        responses.append([method_name, {"state": str(self.state.current_state), "list": []}, tag])
                    else:
                        records = []
                        for message_id in ids:
                            message = self.state.get_message(auth_email, message_id)
                            if not message:
                                continue
                            records.append(
                                {
                                    "id": message.message_id,
                                    "subject": message.subject,
                                    "from": [{"email": message.from_email}],
                                    "to": [{"email": message.to_email}],
                                    "messageId": [message.message_id],
                                    "headers": [{"name": key, "value": value} for key, value in message.headers.items()],
                                    "receivedAt": message.received_at,
                                    "textBody": [{"partId": "body", "type": "text/plain"}],
                                    "bodyValues": {"body": {"value": message.text}},
                                    "attachments": [
                                        {
                                            "blobId": attachment.blob_id,
                                            "type": attachment.content_type,
                                            "name": attachment.filename,
                                            "size": len(attachment.content),
                                        }
                                        for attachment in message.attachments
                                    ],
                                }
                            )
                        responses.append([method_name, {"state": str(self.state.current_state), "list": records}, tag])
                elif method_name == "Email/query":
                    messages = list(reversed(self.state.mailbox_messages(auth_email)))
                    responses.append([method_name, {"ids": [message.message_id for message in messages[: args.get("limit", 20)]]}, tag])
                elif method_name == "Email/changes":
                    since_state = int(args["sinceState"])
                    messages = [
                        message.message_id
                        for message in self.state.mailbox_messages(auth_email)
                        if message.state > since_state
                    ]
                    responses.append([method_name, {"created": messages, "newState": str(self.state.current_state)}, tag])
                else:
                    responses.append(["error", {"type": "unknownMethod", "methodName": method_name}, tag])
            self._json(200, {"methodResponses": responses})
            return

        self.send_response(404)
        self.end_headers()


class EndToEndTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mock_state = MockAampService()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        self.server.mock_state = self.mock_state  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_task_lifecycle_e2e(self) -> None:
        dispatcher = AampClient.from_mailbox_identity(
            email="dispatcher@mesh.local",
            smtp_password="dispatcher-pass",
            base_url=self.base_url,
            reconnect_interval=0.1,
            reject_unauthorized=False,
        )
        agent = AampClient.from_mailbox_identity(
            email="agent@mesh.local",
            smtp_password="agent-pass",
            base_url=self.base_url,
            reconnect_interval=0.1,
            reject_unauthorized=False,
        )

        task_received = threading.Event()
        ack_received = threading.Event()
        result_received = threading.Event()
        stream_received = threading.Event()
        result_payload: dict | None = None
        stream_payload: dict | None = None

        def on_dispatch(task: dict) -> None:
            stream = agent.create_stream(task_id=task["taskId"], peer_email=task["from"])
            agent.send_stream_opened(
                to=task["from"],
                task_id=task["taskId"],
                stream_id=stream["streamId"],
                in_reply_to=task["messageId"],
            )
            agent.append_stream_event(
                stream_id=stream["streamId"],
                event_type="status",
                payload={"stage": "running"},
            )
            agent.close_stream(stream_id=stream["streamId"], payload={"stage": "done"})
            agent.send_result(
                to=task["from"],
                task_id=task["taskId"],
                status="completed",
                output="processed",
                in_reply_to=task["messageId"],
                attachments=[
                    Attachment(
                        filename="report.txt",
                        content_type="text/plain",
                        content=b"integration-ok",
                    )
                ],
            )
            task_received.set()

        def on_ack(_ack: dict) -> None:
            ack_received.set()

        def on_stream(payload: dict) -> None:
            nonlocal stream_payload
            stream_payload = payload
            stream_received.set()

        def on_result(payload: dict) -> None:
            nonlocal result_payload
            result_payload = payload
            result_received.set()

        agent.on("task.dispatch", on_dispatch)
        dispatcher.on("task.ack", on_ack)
        dispatcher.on("task.stream.opened", on_stream)
        dispatcher.on("task.result", on_result)

        dispatcher.connect()
        agent.connect()
        time.sleep(0.3)

        task_id, _message_id = dispatcher.send_task(
            to="agent@mesh.local",
            title="Integration test",
            body_text="Please handle this task.",
            priority="high",
        )

        self.assertTrue(task_received.wait(5), "agent did not receive dispatch")
        self.assertTrue(ack_received.wait(5), "dispatcher did not receive ack")
        self.assertTrue(stream_received.wait(5), "dispatcher did not receive stream open")
        self.assertTrue(result_received.wait(5), "dispatcher did not receive result")

        assert stream_payload is not None
        assert result_payload is not None
        self.assertEqual(stream_payload["taskId"], task_id)
        self.assertEqual(result_payload["taskId"], task_id)
        self.assertEqual(result_payload["status"], "completed")
        self.assertEqual(result_payload["output"], "processed")
        self.assertEqual(len(result_payload["attachments"]), 1)

        blob = dispatcher.download_blob(result_payload["attachments"][0]["blobId"], "report.txt")
        self.assertEqual(blob, b"integration-ok")

        stream_state = dispatcher.get_task_stream(task_id=task_id)
        self.assertEqual(stream_state["status"], "closed")
        self.assertEqual(stream_state["latestEvent"]["payload"]["stage"], "done")

        dispatcher.disconnect()
        agent.disconnect()

    def test_stream_append_serializes_and_coalesces_text_delta_per_stream(self) -> None:
        self.mock_state.append_delay_secs = 0.05
        client = AampClient.from_mailbox_identity(
            email="agent@mesh.local",
            smtp_password="agent-pass",
            base_url=self.base_url,
            reconnect_interval=0.1,
            reject_unauthorized=False,
        )

        stream = client.create_stream(
            task_id="task-stream-ordering",
            peer_email="dispatcher@mesh.local",
        )

        tokens = [chr(code) for code in range(ord("A"), ord("Z") + 1)]
        threads: list[threading.Thread] = []

        first_token = tokens[0]
        first_thread = threading.Thread(
            target=lambda: client.append_stream_event(
                stream_id=stream["streamId"],
                event_type="text.delta",
                payload={"text": first_token},
            )
        )
        threads.append(first_thread)
        first_thread.start()
        time.sleep(0.01)

        release_events: list[threading.Event] = []
        for token in tokens[1:]:
            release = threading.Event()
            release_events.append(release)
            thread = threading.Thread(
                target=lambda gate=release, value=token: (
                    gate.wait(),
                    client.append_stream_event(
                        stream_id=stream["streamId"],
                        event_type="text.delta",
                        payload={"text": value},
                    ),
                )
            )
            threads.append(thread)
            thread.start()

        for release in release_events:
            release.set()
            time.sleep(0.002)

        for thread in threads:
            thread.join(timeout=2)

        events = list(self.mock_state.streams[stream["streamId"]]["events"])
        self.assertGreaterEqual(len(events), 1)
        self.assertLess(len(events), len(tokens))
        self.assertEqual(
            "".join(str(event["payload"].get("text", "")) for event in events),
            "".join(tokens),
        )


if __name__ == "__main__":
    unittest.main()
