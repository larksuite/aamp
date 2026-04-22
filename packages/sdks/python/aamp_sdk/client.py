"""Portable Python client for AAMP service APIs and message sending."""

from __future__ import annotations

import base64
import json
import ssl
import threading
from typing import Any
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen

from .events import TinyEmitter
from .jmap_push import JmapPushClient
from .smtp import SmtpSender, derive_mailbox_service_defaults

DEFAULT_HTTP_TIMEOUT_SECS = 30


class _StreamAppendOperation:
    def __init__(self, *, event_type: str, payload: dict[str, Any], text: str | None = None) -> None:
        self.event_type = event_type
        self.payload = dict(payload)
        self.text = text
        self.done = False
        self.result: dict[str, Any] | None = None
        self.error: Exception | None = None


class _StreamAppendQueue:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.running = False
        self.operations: list[_StreamAppendOperation] = []


def _ssl_context(reject_unauthorized: bool) -> ssl.SSLContext:
    return ssl.create_default_context() if reject_unauthorized else ssl._create_unverified_context()


class AampClient(TinyEmitter):
    def __init__(
        self,
        *,
        email: str,
        mailbox_token: str,
        base_url: str,
        smtp_password: str,
        http_send_base_url: str | None = None,
        smtp_host: str | None = None,
        smtp_port: int = 587,
        reconnect_interval: float = 5.0,
        reject_unauthorized: bool = True,
    ) -> None:
        super().__init__()
        self.email = email
        self.mailbox_token = mailbox_token
        self.base_url = base_url
        self.reject_unauthorized = reject_unauthorized
        self._stream_append_queues: dict[str, _StreamAppendQueue] = {}
        self._stream_append_queues_guard = threading.RLock()

        derived = derive_mailbox_service_defaults(email, base_url)
        self.smtp_sender = SmtpSender(
            host=smtp_host or str(derived["smtp_host"]),
            port=smtp_port,
            user=email,
            password=smtp_password,
            http_base_url=http_send_base_url or base_url,
            auth_token=mailbox_token,
            reject_unauthorized=reject_unauthorized,
        )
        decoded = base64.b64decode(mailbox_token.encode("ascii")).decode("utf-8")
        _mailbox_email, _sep, password = decoded.partition(":")
        if not _sep or not password:
            raise RuntimeError("Invalid mailboxToken format: expected base64(email:password)")
        self.jmap_client = JmapPushClient(
            email=email,
            password=password,
            jmap_url=base_url,
            reconnect_interval=reconnect_interval,
            reject_unauthorized=reject_unauthorized,
        )
        for event_name in [
            "task.dispatch",
            "task.cancel",
            "task.result",
            "task.help_needed",
            "task.ack",
            "task.stream.opened",
            "card.query",
            "card.response",
            "reply",
            "connected",
            "disconnected",
            "error",
        ]:
            self.jmap_client.on(event_name, self._forward_event(event_name))
        self.jmap_client.on("_autoAck", self._handle_auto_ack)

    def _forward_event(self, event_name: str) -> Any:
        def handler(*args: Any) -> None:
            self.emit(event_name, *args)

        return handler

    def _handle_auto_ack(self, payload: dict[str, Any]) -> None:
        try:
            self.smtp_sender.send_ack(
                to=str(payload["to"]),
                task_id=str(payload["taskId"]),
                in_reply_to=str(payload["messageId"]),
            )
        except Exception as err:
            self.emit("error", RuntimeError(f"[AAMP] Failed to send ACK for task {payload.get('taskId')}: {err}"))

    @classmethod
    def from_mailbox_identity(
        cls,
        *,
        email: str,
        smtp_password: str,
        base_url: str | None = None,
        smtp_port: int = 587,
        reconnect_interval: float = 5.0,
        reject_unauthorized: bool = True,
    ) -> "AampClient":
        derived = derive_mailbox_service_defaults(email, base_url)
        token = base64.b64encode(f"{email}:{smtp_password}".encode("utf-8")).decode("ascii")
        return cls(
            email=email,
            mailbox_token=token,
            base_url=str(derived["http_base_url"] or f"https://{email.split('@', 1)[1]}"),
            smtp_password=smtp_password,
            smtp_host=str(derived["smtp_host"]),
            smtp_port=smtp_port,
            reconnect_interval=reconnect_interval,
            reject_unauthorized=reject_unauthorized,
        )

    @staticmethod
    def _request_json(
        url: str,
        *,
        method: str = "GET",
        body: Any | None = None,
        headers: dict[str, str] | None = None,
        reject_unauthorized: bool = True,
    ) -> Any:
        data = None
        request_headers = {"Accept": "application/json", **(headers or {})}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        request = Request(url, method=method, data=data, headers=request_headers)
        with urlopen(
            request,
            context=_ssl_context(reject_unauthorized),
            timeout=DEFAULT_HTTP_TIMEOUT_SECS,
        ) as response:
            return json.loads(response.read().decode("utf-8"))

    @classmethod
    def discover_aamp_service(cls, aamp_host: str, *, reject_unauthorized: bool = True) -> dict[str, Any]:
        base = aamp_host.rstrip("/")
        discovery = cls._request_json(
            f"{base}/.well-known/aamp",
            reject_unauthorized=reject_unauthorized,
        )
        if not discovery.get("api", {}).get("url"):
            raise RuntimeError("AAMP discovery did not return api.url")
        return discovery

    @classmethod
    def _call_discovered_api(
        cls,
        base: str,
        *,
        action: str,
        method: str = "GET",
        query: dict[str, Any] | None = None,
        body: Any | None = None,
        auth_token: str | None = None,
        reject_unauthorized: bool = True,
    ) -> Any:
        discovery = cls.discover_aamp_service(base, reject_unauthorized=reject_unauthorized)
        api_url = urljoin(f"{base.rstrip('/')}/", discovery["api"]["url"])
        params = {"action": action}
        for key, value in (query or {}).items():
            if value is not None:
                params[key] = str(value).lower() if isinstance(value, bool) else str(value)
        url = f"{api_url}?{urlencode(params)}"
        headers = {"Authorization": f"Basic {auth_token}"} if auth_token else None
        return cls._request_json(
            url,
            method=method,
            body=body,
            headers=headers,
            reject_unauthorized=reject_unauthorized,
        )

    @classmethod
    def register_mailbox(
        cls,
        *,
        aamp_host: str,
        slug: str,
        description: str | None = None,
        reject_unauthorized: bool = True,
    ) -> dict[str, str]:
        base = aamp_host.rstrip("/")
        registration = cls._call_discovered_api(
            base,
            action="aamp.mailbox.register",
            method="POST",
            body={"slug": slug, "description": description},
            reject_unauthorized=reject_unauthorized,
        )
        code = registration.get("registrationCode")
        if not code:
            raise RuntimeError("Mailbox registration succeeded but no registrationCode was returned")

        credentials = cls._call_discovered_api(
            base,
            action="aamp.mailbox.credentials",
            query={"code": code},
            reject_unauthorized=reject_unauthorized,
        )
        email = credentials.get("email")
        mailbox_token = credentials.get("mailbox", {}).get("token")
        smtp_password = credentials.get("smtp", {}).get("password")
        if not email or not mailbox_token or not smtp_password:
            raise RuntimeError("Mailbox credential exchange returned an incomplete identity payload")

        return {
            "email": email,
            "mailboxToken": mailbox_token,
            "smtpPassword": smtp_password,
            "baseUrl": base,
        }

    def send_task(self, **kwargs: Any) -> tuple[str, str]:
        return self.smtp_sender.send_task(**kwargs)

    def connect(self) -> None:
        self.jmap_client.start()

    def disconnect(self) -> None:
        self.jmap_client.stop()

    def is_connected(self) -> bool:
        return self.jmap_client.is_connected()

    def is_using_polling_fallback(self) -> bool:
        return self.jmap_client.is_using_polling_fallback()

    def send_result(self, **kwargs: Any) -> None:
        self.smtp_sender.send_result(**kwargs)

    def send_help(self, **kwargs: Any) -> None:
        self.smtp_sender.send_help(**kwargs)

    def send_cancel(self, **kwargs: Any) -> None:
        self.smtp_sender.send_cancel(**kwargs)

    def send_stream_opened(self, **kwargs: Any) -> None:
        self.smtp_sender.send_stream_opened(**kwargs)

    def send_card_query(self, **kwargs: Any) -> tuple[str, str]:
        return self.smtp_sender.send_card_query(**kwargs)

    def send_card_response(self, **kwargs: Any) -> None:
        self.smtp_sender.send_card_response(**kwargs)

    def download_blob(self, blob_id: str, filename: str | None = None) -> bytes:
        return self.jmap_client.download_blob(blob_id, filename)

    def reconcile_recent_emails(self, limit: int = 20, *, include_historical: bool = False) -> int:
        return self.jmap_client.reconcile_recent_emails(limit, include_historical=include_historical)

    def update_directory_profile(
        self,
        *,
        summary: str | None = None,
        card_text: str | None = None,
    ) -> dict[str, Any]:
        response = self._call_discovered_api(
            self.base_url,
            action="aamp.directory.upsert",
            method="POST",
            auth_token=self.mailbox_token,
            body={"summary": summary, "cardText": card_text},
            reject_unauthorized=self.reject_unauthorized,
        )
        return dict(response.get("profile", {}))

    def list_directory(
        self,
        *,
        scope: str | None = None,
        include_self: bool | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        response = self._call_discovered_api(
            self.base_url,
            action="aamp.directory.list",
            auth_token=self.mailbox_token,
            query={"scope": scope, "includeSelf": include_self, "limit": limit},
            reject_unauthorized=self.reject_unauthorized,
        )
        return list(response.get("agents", []))

    def search_directory(
        self,
        *,
        query: str,
        scope: str | None = None,
        include_self: bool | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        response = self._call_discovered_api(
            self.base_url,
            action="aamp.directory.search",
            auth_token=self.mailbox_token,
            query={
                "q": query,
                "scope": scope,
                "includeSelf": include_self,
                "limit": limit,
            },
            reject_unauthorized=self.reject_unauthorized,
        )
        return list(response.get("agents", []))

    def _resolve_stream_capability(self) -> dict[str, Any]:
        discovery = self.discover_aamp_service(
            self.base_url,
            reject_unauthorized=self.reject_unauthorized,
        )
        stream = discovery.get("capabilities", {}).get("stream")
        if not stream or not stream.get("transport"):
            raise RuntimeError("AAMP stream capability is not available on this service")
        return dict(stream)

    def create_stream(self, *, task_id: str, peer_email: str) -> dict[str, Any]:
        stream = self._resolve_stream_capability()
        return self._call_discovered_api(
            self.base_url,
            action=stream.get("createAction", "aamp.stream.create"),
            method="POST",
            auth_token=self.mailbox_token,
            body={"taskId": task_id, "peerEmail": peer_email},
            reject_unauthorized=self.reject_unauthorized,
        )

    def _get_stream_append_queue(self, stream_id: str) -> _StreamAppendQueue:
        with self._stream_append_queues_guard:
            queue = self._stream_append_queues.get(stream_id)
            if queue is None:
                queue = _StreamAppendQueue()
                self._stream_append_queues[stream_id] = queue
            return queue

    def _dispatch_stream_append(self, *, stream_id: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        stream = self._resolve_stream_capability()
        return self._call_discovered_api(
            self.base_url,
            action=stream.get("appendAction", "aamp.stream.append"),
            method="POST",
            auth_token=self.mailbox_token,
            body={"streamId": stream_id, "type": event_type, "payload": payload},
            reject_unauthorized=self.reject_unauthorized,
        )

    def _drain_stream_append_queue(self, stream_id: str) -> None:
        queue = self._get_stream_append_queue(stream_id)
        while True:
            with queue.condition:
                if not queue.operations:
                    queue.running = False
                    queue.condition.notify_all()
                    with self._stream_append_queues_guard:
                        if not queue.running and not queue.operations:
                            self._stream_append_queues.pop(stream_id, None)
                    return
                operation = queue.operations.pop(0)

            try:
                payload = dict(operation.payload)
                if operation.event_type == "text.delta" and operation.text is not None:
                    payload["text"] = operation.text
                result = self._dispatch_stream_append(
                    stream_id=stream_id,
                    event_type=operation.event_type,
                    payload=payload,
                )
                with queue.condition:
                    operation.result = result
                    operation.done = True
                    queue.condition.notify_all()
            except Exception as err:  # pragma: no cover - exercised via callers
                with queue.condition:
                    operation.error = err
                    operation.done = True
                    queue.condition.notify_all()

    def _flush_stream_append_queue(self, stream_id: str) -> None:
        queue = self._get_stream_append_queue(stream_id)
        with queue.condition:
            while queue.running or queue.operations:
                queue.condition.wait()

    def append_stream_event(self, *, stream_id: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        queue = self._get_stream_append_queue(stream_id)
        with queue.condition:
            operation: _StreamAppendOperation
            if event_type == "text.delta" and isinstance(payload.get("text"), str):
                last_operation = queue.operations[-1] if queue.operations else None
                if (
                    last_operation is not None
                    and last_operation.event_type == "text.delta"
                    and last_operation.text is not None
                ):
                    last_operation.text += str(payload.get("text") or "")
                    operation = last_operation
                else:
                    operation = _StreamAppendOperation(
                        event_type=event_type,
                        payload=payload,
                        text=str(payload.get("text") or ""),
                    )
                    queue.operations.append(operation)
            else:
                operation = _StreamAppendOperation(event_type=event_type, payload=payload)
                queue.operations.append(operation)

            if not queue.running:
                queue.running = True
                threading.Thread(
                    target=self._drain_stream_append_queue,
                    args=(stream_id,),
                    daemon=True,
                ).start()

            while not operation.done:
                queue.condition.wait()

            if operation.error is not None:
                raise operation.error
            if operation.result is None:
                raise RuntimeError("stream append completed without a result")
            return dict(operation.result)

    def close_stream(self, *, stream_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        self._flush_stream_append_queue(stream_id)
        stream = self._resolve_stream_capability()
        return self._call_discovered_api(
            self.base_url,
            action=stream.get("closeAction", "aamp.stream.close"),
            method="POST",
            auth_token=self.mailbox_token,
            body={"streamId": stream_id, "payload": payload or {}},
            reject_unauthorized=self.reject_unauthorized,
        )

    def get_task_stream(
        self,
        *,
        task_id: str | None = None,
        stream_id: str | None = None,
    ) -> dict[str, Any]:
        stream = self._resolve_stream_capability()
        return self._call_discovered_api(
            self.base_url,
            action=stream.get("getAction", "aamp.stream.get"),
            auth_token=self.mailbox_token,
            query={"taskId": task_id, "streamId": stream_id},
            reject_unauthorized=self.reject_unauthorized,
        )
