import os
import threading
import time
import unittest
import uuid
import urllib.error

from aamp_sdk import AampClient, Attachment


REAL_TEST_FLAG = "AAMP_RUN_REAL_SERVICE_TESTS"
REAL_HOST_ENV = "AAMP_REAL_SERVICE_HOST"
REAL_HOST_DEFAULT = "https://meshmail.ai"
REAL_TIMEOUT_ENV = "AAMP_REAL_SERVICE_TIMEOUT_SECS"
REAL_TIMEOUT_DEFAULT = 150


def _real_host() -> str:
    return os.getenv(REAL_HOST_ENV, REAL_HOST_DEFAULT).rstrip("/")


def _timeout_secs() -> int:
    return int(os.getenv(REAL_TIMEOUT_ENV, str(REAL_TIMEOUT_DEFAULT)))


def _register_mailbox_with_retry(*, host: str, slug: str, description: str) -> dict[str, str]:
    last_error: BaseException | None = None
    for attempt in range(1, 11):
        try:
            return AampClient.register_mailbox(
                aamp_host=host,
                slug=slug,
                description=description,
            )
        except urllib.error.HTTPError as err:
            last_error = err
            if err.code not in {429, 500, 502, 503, 504} or attempt == 10:
                raise
        except TimeoutError as err:
            last_error = err
            if attempt == 10:
                raise
        time.sleep(min(2 ** (attempt - 1), 10))
    raise AssertionError(f"register mailbox retry unexpectedly exhausted: {last_error}")


@unittest.skipUnless(os.getenv(REAL_TEST_FLAG) == "1", "real service tests are disabled")
class RealServiceTests(unittest.TestCase):
    def test_register_and_exchange_mail_over_meshmail(self) -> None:
        host = _real_host()
        run_id = uuid.uuid4().hex[:8]

        dispatcher_identity = _register_mailbox_with_retry(
            host=host,
            slug=f"cpyd-{run_id}",
            description="Codex Python real-service integration test dispatcher",
        )
        agent_identity = _register_mailbox_with_retry(
            host=host,
            slug=f"cpya-{run_id}",
            description="Codex Python real-service integration test agent",
        )

        dispatcher = AampClient(
            email=dispatcher_identity["email"],
            mailbox_token=dispatcher_identity["mailboxToken"],
            base_url=host,
            smtp_password=dispatcher_identity["smtpPassword"],
            reconnect_interval=1.0,
        )
        agent = AampClient(
            email=agent_identity["email"],
            mailbox_token=agent_identity["mailboxToken"],
            base_url=host,
            smtp_password=agent_identity["smtpPassword"],
            reconnect_interval=1.0,
        )

        ack_received = threading.Event()
        dispatch_received = threading.Event()
        result_received = threading.Event()
        state: dict[str, dict] = {}

        def on_dispatch(task: dict) -> None:
            state["dispatch"] = task
            dispatch_received.set()
            agent.send_result(
                to=task["from"],
                task_id=task["taskId"],
                status="completed",
                output="python-real-service-ok",
                in_reply_to=task["messageId"],
                attachments=[
                    Attachment(
                        filename="real-service.txt",
                        content_type="text/plain",
                        content=b"python-real-service-blob",
                    )
                ],
            )

        def on_ack(payload: dict) -> None:
            state["ack"] = payload
            ack_received.set()

        def on_result(payload: dict) -> None:
            state["result"] = payload
            result_received.set()

        agent.on("task.dispatch", on_dispatch)
        dispatcher.on("task.ack", on_ack)
        dispatcher.on("task.result", on_result)

        task_id, _message_id = dispatcher.send_task(
            to=agent_identity["email"],
            title=f"Codex Python real-service test {run_id}",
            body_text=f"real-service python probe {run_id}",
            priority="high",
        )

        deadline = time.time() + _timeout_secs()
        while time.time() < deadline:
            if ack_received.is_set() and dispatch_received.is_set() and result_received.is_set():
                break
            agent.reconcile_recent_emails(10)
            dispatcher.reconcile_recent_emails(10)
            time.sleep(2)

        self.assertTrue(dispatch_received.is_set(), "agent did not receive dispatched task from meshmail.ai")
        self.assertTrue(ack_received.is_set(), "dispatcher did not receive ACK from meshmail.ai")
        self.assertTrue(result_received.is_set(), "dispatcher did not receive task result from meshmail.ai")

        dispatch = state["dispatch"]
        result = state["result"]

        self.assertEqual(dispatch["taskId"], task_id)
        self.assertEqual(result["taskId"], task_id)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["output"], "python-real-service-ok")
        self.assertEqual(len(result.get("attachments") or []), 1)

        attachment = result["attachments"][0]
        blob = dispatcher.download_blob(attachment["blobId"], attachment["filename"])
        self.assertEqual(blob, b"python-real-service-blob")
