"""JMAP push receiver for AAMP mailboxes."""

from __future__ import annotations

import json
import ssl
import threading
import time
import urllib.error
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

try:
    import websocket  # type: ignore
except ImportError:  # pragma: no cover - exercised only in minimal environments
    websocket = None

from .events import TinyEmitter
from .protocol import parse_aamp_headers


def _ssl_context(reject_unauthorized: bool) -> ssl.SSLContext:
    return ssl.create_default_context() if reject_unauthorized else ssl._create_unverified_context()


def _describe_error(err: BaseException) -> str:
    return str(err)


class JmapPushClient(TinyEmitter):
    def __init__(
        self,
        *,
        email: str,
        password: str,
        jmap_url: str,
        reconnect_interval: float = 5.0,
        reject_unauthorized: bool = True,
    ) -> None:
        super().__init__()
        self.email = email
        self.password = password
        self.jmap_url = jmap_url.rstrip("/")
        self.reconnect_interval = reconnect_interval
        self.reject_unauthorized = reject_unauthorized
        self.ping_interval_secs = 5.0
        self.safety_sync_interval_secs = 5.0
        self.started_at_ms = int(time.time() * 1000)

        self.ws_app: websocket.WebSocketApp | None = None
        self.ws_thread: threading.Thread | None = None
        self.reconnect_timer: threading.Timer | None = None
        self.poll_thread: threading.Thread | None = None
        self.safety_thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.poll_stop_event = threading.Event()
        self.lock = threading.RLock()

        self.session: dict[str, Any] | None = None
        self.seen_message_ids: set[str] = set()
        self.connected = False
        self.polling_active = False
        self.running = False
        self.connecting = False
        self.email_state: str | None = None

    def start(self) -> None:
        with self.lock:
            if self.running:
                return
            self.running = True
            self.stop_event.clear()
        self._start_safety_sync()
        self._connect()

    def stop(self) -> None:
        with self.lock:
            self.running = False
            self.connecting = False
            self.connected = False
            self.polling_active = False
        self.stop_event.set()
        self.poll_stop_event.set()
        if self.reconnect_timer:
            self.reconnect_timer.cancel()
            self.reconnect_timer = None
        if self.ws_app:
            try:
                self.ws_app.close()
            except Exception:
                pass
            self.ws_app = None

    def is_connected(self) -> bool:
        with self.lock:
            return self.connected or self.polling_active

    def is_using_polling_fallback(self) -> bool:
        with self.lock:
            return self.polling_active and not self.connected

    def _auth_header(self) -> str:
        import base64

        creds = f"{self.email}:{self.password}".encode("utf-8")
        return "Basic " + base64.b64encode(creds).decode("ascii")

    def _request(
        self,
        url: str,
        *,
        method: str = "GET",
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> bytes:
        request = Request(url, method=method, data=body, headers=headers or {})
        with urlopen(request, context=_ssl_context(self.reject_unauthorized), timeout=30) as response:
            return response.read()

    def fetch_session(self) -> dict[str, Any]:
        payload = self._request(
            f"{self.jmap_url}/.well-known/jmap",
            headers={"Authorization": self._auth_header()},
        )
        return json.loads(payload.decode("utf-8"))

    def _jmap_call(self, methods: list[list[Any]]) -> dict[str, Any]:
        if not self.session:
            raise RuntimeError("No JMAP session")
        payload = json.dumps(
            {
                "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
                "methodCalls": methods,
            }
        ).encode("utf-8")
        response = self._request(
            f"{self.jmap_url}/jmap/",
            method="POST",
            body=payload,
            headers={
                "Authorization": self._auth_header(),
                "Content-Type": "application/json",
            },
        )
        return json.loads(response.decode("utf-8"))

    def _primary_account_id(self) -> str:
        if not self.session:
            raise RuntimeError("No JMAP session")
        primary = self.session.get("primaryAccounts", {}).get("urn:ietf:params:jmap:mail")
        if primary:
            return str(primary)
        accounts = self.session.get("accounts", {})
        for key in accounts:
            return str(key)
        raise RuntimeError("No mail account available in JMAP session")

    def _init_email_state(self, account_id: str) -> None:
        response = self._jmap_call([["Email/get", {"accountId": account_id, "ids": []}, "g0"]])
        for method_name, payload, _tag in response.get("methodResponses", []):
            if method_name == "Email/get":
                self.email_state = payload.get("state")
                return

    def _fetch_emails_since(self, account_id: str, since_state: str) -> list[dict[str, Any]]:
        changes_response = self._jmap_call(
            [["Email/changes", {"accountId": account_id, "sinceState": since_state, "maxChanges": 50}, "c1"]]
        )
        changes_result = next(
            (item for item in changes_response.get("methodResponses", []) if item[0] == "Email/changes"),
            None,
        )
        if not changes_result:
            self._init_email_state(account_id)
            return []

        changes = changes_result[1]
        if changes.get("newState"):
            self.email_state = changes["newState"]

        new_ids = changes.get("created") or []
        if not new_ids:
            return []

        response = self._jmap_call(
            [
                [
                    "Email/get",
                    {
                        "accountId": account_id,
                        "ids": new_ids,
                        "properties": [
                            "id",
                            "subject",
                            "from",
                            "to",
                            "headers",
                            "messageId",
                            "receivedAt",
                            "textBody",
                            "bodyValues",
                            "attachments",
                        ],
                        "fetchTextBodyValues": True,
                        "maxBodyValueBytes": 262144,
                    },
                    "g1",
                ]
            ]
        )
        result = next((item for item in response.get("methodResponses", []) if item[0] == "Email/get"), None)
        return list(result[1].get("list") or []) if result else []

    def _fetch_recent_emails(self, account_id: str) -> list[dict[str, Any]]:
        query_response = self._jmap_call(
            [["Email/query", {"accountId": account_id, "sort": [{"property": "receivedAt", "isAscending": False}], "limit": 20}, "q1"]]
        )
        query_result = next((item for item in query_response.get("methodResponses", []) if item[0] == "Email/query"), None)
        ids = list(query_result[1].get("ids") or [])[:20] if query_result else []
        if not ids:
            return []
        response = self._jmap_call(
            [
                [
                    "Email/get",
                    {
                        "accountId": account_id,
                        "ids": ids,
                        "properties": [
                            "id",
                            "subject",
                            "from",
                            "to",
                            "headers",
                            "messageId",
                            "receivedAt",
                            "textBody",
                            "bodyValues",
                            "attachments",
                        ],
                        "fetchTextBodyValues": True,
                        "maxBodyValueBytes": 262144,
                    },
                    "gRecent",
                ]
            ]
        )
        result = next((item for item in response.get("methodResponses", []) if item[0] == "Email/get"), None)
        return list(result[1].get("list") or []) if result else []

    def _should_process_bootstrap_email(self, email: dict[str, Any]) -> bool:
        received_at = email.get("receivedAt")
        if not received_at:
            return False
        try:
            import datetime as _dt

            timestamp_ms = int(_dt.datetime.fromisoformat(str(received_at).replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            return False
        return timestamp_ms >= self.started_at_ms - 15000

    def _process_email(self, email: dict[str, Any]) -> None:
        header_map = {str(item.get("name", "")).lower(): str(item.get("value", "")).strip() for item in email.get("headers") or []}
        from_addr = ((email.get("from") or [{}])[0]).get("email", "")
        to_addr = ((email.get("to") or [{}])[0]).get("email", "")
        message_id = ((email.get("messageId") or [email.get("id")])[0]) or email.get("id", "")

        with self.lock:
            if message_id in self.seen_message_ids:
                return
            self.seen_message_ids.add(str(message_id))

        text_body = email.get("textBody") or []
        part_id = text_body[0].get("partId") if text_body else None
        body_text = (email.get("bodyValues") or {}).get(part_id, {}).get("value", "").strip() if part_id else ""

        message = parse_aamp_headers(
            {
                "from": from_addr,
                "to": to_addr,
                "messageId": message_id,
                "subject": email.get("subject", ""),
                "headers": header_map,
                "bodyText": body_text,
            }
        )

        if message and "intent" in message:
            message["bodyText"] = body_text
            attachments = [
                {
                    "filename": item.get("name") or "attachment",
                    "contentType": item.get("type"),
                    "size": item.get("size"),
                    "blobId": item.get("blobId"),
                }
                for item in (email.get("attachments") or [])
            ]
            if attachments:
                message["attachments"] = attachments
            if message["intent"] == "task.dispatch":
                self.emit("_autoAck", {"to": from_addr, "taskId": message["taskId"], "messageId": message_id})
            self.emit(message["intent"], message)
            return

        raw_in_reply_to = header_map.get("in-reply-to", "")
        if not raw_in_reply_to:
            return
        raw_references = header_map.get("references", "")
        references = [item.replace("<", "").replace(">", "").strip() for item in raw_references.split() if item.strip()]
        reply = {
            "inReplyTo": raw_in_reply_to.replace("<", "").replace(">", "").strip(),
            "messageId": message_id,
            "from": from_addr,
            "to": to_addr,
            "subject": email.get("subject", ""),
            "bodyText": body_text,
        }
        if references:
            reply["references"] = references
        self.emit("reply", reply)

    def _handle_state_change(self, payload: dict[str, Any]) -> None:
        if not self.session:
            return
        account_id = self._primary_account_id()
        changed_account = payload.get("changed", {}).get(account_id, {})
        if not changed_account.get("Email"):
            return
        if self.email_state is None:
            self._init_email_state(account_id)
            return
        for email in self._fetch_emails_since(account_id, self.email_state):
            self._process_email(email)

    def _schedule_reconnect(self) -> None:
        with self.lock:
            if not self.running or self.reconnect_timer:
                return
            self.reconnect_timer = threading.Timer(self.reconnect_interval, self._reconnect)
            self.reconnect_timer.daemon = True
            self.reconnect_timer.start()

    def _reconnect(self) -> None:
        with self.lock:
            self.reconnect_timer = None
        if self.running:
            self._connect()

    def _stop_polling(self) -> None:
        self.poll_stop_event.set()
        with self.lock:
            self.polling_active = False

    def _start_polling(self, reason: str) -> None:
        with self.lock:
            if not self.running or self.polling_active:
                return
            self.polling_active = True
        self.emit("error", RuntimeError(f"JMAP WebSocket unavailable, falling back to polling: {reason}"))
        self.emit("connected")
        self.poll_stop_event = threading.Event()

        def loop() -> None:
            while self.running and not self.connected and not self.poll_stop_event.is_set():
                try:
                    if not self.session:
                        self.session = self.fetch_session()
                    account_id = self._primary_account_id()
                    if self.email_state is None:
                        recent = self._fetch_recent_emails(account_id)
                        for email in sorted(recent, key=lambda item: item.get("receivedAt", "")):
                            if not self._should_process_bootstrap_email(email):
                                continue
                            self._process_email(email)
                        self._init_email_state(account_id)
                    else:
                        for email in self._fetch_emails_since(account_id, self.email_state):
                            self._process_email(email)
                except Exception as err:
                    self.emit("error", RuntimeError(f"Polling fallback failed: {_describe_error(err)}"))
                self.poll_stop_event.wait(self.reconnect_interval)
            with self.lock:
                self.polling_active = False

        self.poll_thread = threading.Thread(target=loop, name="aamp-jmap-poll", daemon=True)
        self.poll_thread.start()

    def _start_safety_sync(self) -> None:
        if self.safety_thread and self.safety_thread.is_alive():
            return

        def loop() -> None:
            while not self.stop_event.wait(self.safety_sync_interval_secs):
                if not self.running:
                    return
                try:
                    self.reconcile_recent_emails(20)
                except Exception as err:
                    self.emit("error", RuntimeError(f"Safety reconcile failed: {_describe_error(err)}"))

        self.safety_thread = threading.Thread(target=loop, name="aamp-jmap-safety", daemon=True)
        self.safety_thread.start()

    def _connect(self) -> None:
        with self.lock:
            if self.connecting or not self.running:
                return
            self.connecting = True
        try:
            self.session = self.fetch_session()
        except Exception as err:
            with self.lock:
                self.connecting = False
            self.emit("error", RuntimeError(f"Failed to get JMAP session: {_describe_error(err)}"))
            self._start_polling("session fetch failed")
            self._schedule_reconnect()
            return

        ws_url = self.jmap_url.replace("https://", "wss://").replace("http://", "ws://") + "/jmap/ws"
        sslopt = {"cert_reqs": ssl.CERT_REQUIRED if self.reject_unauthorized else ssl.CERT_NONE}
        if websocket is None:
            with self.lock:
                self.connecting = False
            self._start_polling("python package websocket-client is not installed")
            self._schedule_reconnect()
            return

        def on_open(ws: websocket.WebSocketApp) -> None:
            del ws
            with self.lock:
                self.connecting = False
                self.connected = True
            self._stop_polling()
            account_id = self._primary_account_id()
            if self.email_state is None:
                self._init_email_state(account_id)
            self.ws_app.send(json.dumps({"@type": "WebSocketPushEnable", "dataTypes": ["Email"], "pushState": None}))
            self.emit("connected")

        def on_message(_ws: websocket.WebSocketApp, message: str) -> None:
            try:
                payload = json.loads(message)
                if payload.get("@type") == "StateChange":
                    self._handle_state_change(payload)
            except Exception as err:
                self.emit("error", RuntimeError(f"Failed to process JMAP push message: {_describe_error(err)}"))

        def on_close(_ws: websocket.WebSocketApp, _code: Any, reason: Any) -> None:
            with self.lock:
                self.connecting = False
                self.connected = False
            reason_text = str(reason or "connection closed")
            self._start_polling(reason_text)
            self.emit("disconnected", reason_text)
            if self.running:
                self._schedule_reconnect()

        def on_error(_ws: websocket.WebSocketApp, err: Any) -> None:
            with self.lock:
                self.connecting = False
                self.connected = False
            self._start_polling(str(err))
            self.emit("error", err if isinstance(err, BaseException) else RuntimeError(str(err)))

        self.ws_app = websocket.WebSocketApp(
            ws_url,
            header=[f"Authorization: {self._auth_header()}"],
            subprotocols=["jmap"],
            on_open=on_open,
            on_message=on_message,
            on_close=on_close,
            on_error=on_error,
        )

        def run() -> None:
            try:
                self.ws_app.run_forever(
                    ping_interval=self.ping_interval_secs,
                    sslopt=sslopt,
                )
            except Exception as err:
                on_error(self.ws_app, err)

        self.ws_thread = threading.Thread(target=run, name="aamp-jmap-ws", daemon=True)
        self.ws_thread.start()

    def download_blob(self, blob_id: str, filename: str | None = None) -> bytes:
        if not self.session:
            self.session = self.fetch_session()
        account_id = self._primary_account_id()
        download_url = self.session.get("downloadUrl") or f"{self.jmap_url}/jmap/download/{{accountId}}/{{blobId}}/{{name}}"

        try:
            parsed = urlparse(download_url)
            configured = urlparse(self.jmap_url)
            if parsed.scheme and parsed.netloc:
                download_url = parsed._replace(scheme=configured.scheme, netloc=configured.netloc).geturl()
        except Exception:
            pass

        safe_filename = filename or "attachment"
        download_url = (
            download_url.replace("{accountId}", account_id)
            .replace("{blobId}", blob_id)
            .replace("{name}", safe_filename)
            .replace("{type}", "application/octet-stream")
        )

        max_attempts = 8
        for attempt in range(1, max_attempts + 1):
            try:
                request = Request(download_url, headers={"Authorization": self._auth_header()})
                with urlopen(request, context=_ssl_context(self.reject_unauthorized), timeout=30) as response:
                    return response.read()
            except urllib.error.HTTPError as err:
                if attempt < max_attempts and err.code in {404, 429, 503}:
                    time.sleep(min(2 ** (attempt - 1), 15))
                    continue
                raise RuntimeError(
                    f"Blob download failed: status={err.code} attempt={attempt}/{max_attempts} blobId={blob_id}"
                ) from err
        raise RuntimeError(f"Blob download failed after retries: blobId={blob_id}")

    def reconcile_recent_emails(self, limit: int = 20, *, include_historical: bool = False) -> int:
        if not self.session:
            self.session = self.fetch_session()
        account_id = self._primary_account_id()
        query_response = self._jmap_call(
            [["Email/query", {"accountId": account_id, "sort": [{"property": "receivedAt", "isAscending": False}], "limit": limit}, "qReconcile"]]
        )
        query_result = next((item for item in query_response.get("methodResponses", []) if item[0] == "Email/query"), None)
        ids = list(query_result[1].get("ids") or [])[:limit] if query_result else []
        if not ids:
            return 0
        response = self._jmap_call(
            [
                [
                    "Email/get",
                    {
                        "accountId": account_id,
                        "ids": ids,
                        "properties": [
                            "id",
                            "subject",
                            "from",
                            "to",
                            "headers",
                            "messageId",
                            "receivedAt",
                            "textBody",
                            "bodyValues",
                            "attachments",
                        ],
                        "fetchTextBodyValues": True,
                        "maxBodyValueBytes": 262144,
                    },
                    "gReconcile",
                ]
            ]
        )
        result = next((item for item in response.get("methodResponses", []) if item[0] == "Email/get"), None)
        emails = list(result[1].get("list") or []) if result else []
        for email in sorted(emails, key=lambda item: item.get("receivedAt", "")):
            if not include_historical and not self._should_process_bootstrap_email(email):
                continue
            self._process_email(email)
        return len(emails)
