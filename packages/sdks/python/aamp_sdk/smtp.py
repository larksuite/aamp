"""SMTP sender for AAMP messages."""

from __future__ import annotations

import base64
import json
import smtplib
import ssl
import uuid
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Any
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from .protocol import (
    build_ack_headers,
    build_cancel_headers,
    build_card_query_headers,
    build_card_response_headers,
    build_dispatch_headers,
    build_help_headers,
    build_result_headers,
    build_stream_opened_headers,
)

DEFAULT_HTTP_TIMEOUT_SECS = 30


def _sanitize(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ").strip()


def _ssl_context(reject_unauthorized: bool) -> ssl.SSLContext:
    return ssl.create_default_context() if reject_unauthorized else ssl._create_unverified_context()


@dataclass(slots=True)
class Attachment:
    filename: str
    content_type: str
    content: bytes | str

    def as_bytes(self) -> bytes:
        if isinstance(self.content, bytes):
            return self.content
        return base64.b64decode(self.content.encode("ascii"))


def derive_mailbox_service_defaults(email: str, base_url: str | None = None) -> dict[str, str | None]:
    domain = email.split("@", 1)[1].strip() if "@" in email else ""
    resolved_base_url = base_url.strip() if base_url else (f"https://{domain}" if domain else None)
    smtp_host = domain or (urlparse(resolved_base_url).hostname if resolved_base_url else "localhost")
    return {
        "smtp_host": smtp_host,
        "http_base_url": resolved_base_url,
    }


class SmtpSender:
    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        password: str,
        http_base_url: str | None = None,
        auth_token: str | None = None,
        secure: bool = False,
        reject_unauthorized: bool = True,
    ) -> None:
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.http_base_url = http_base_url
        self.auth_token = auth_token
        self.secure = secure
        self.reject_unauthorized = reject_unauthorized
        self._api_url: str | None = None

    @classmethod
    def from_mailbox_identity(
        cls,
        *,
        email: str,
        password: str,
        base_url: str | None = None,
        smtp_port: int = 587,
        secure: bool = False,
        reject_unauthorized: bool = True,
    ) -> "SmtpSender":
        derived = derive_mailbox_service_defaults(email, base_url)
        token = base64.b64encode(f"{email}:{password}".encode("utf-8")).decode("ascii")
        return cls(
            host=str(derived["smtp_host"]),
            port=smtp_port,
            user=email,
            password=password,
            http_base_url=derived["http_base_url"],
            auth_token=token,
            secure=secure,
            reject_unauthorized=reject_unauthorized,
        )

    def _sender_domain(self) -> str:
        return self.user.split("@", 1)[1].lower() if "@" in self.user else ""

    @staticmethod
    def _recipient_domain(email: str) -> str:
        return email.split("@", 1)[1].lower() if "@" in email else ""

    def _should_use_http_fallback(self, to: str) -> bool:
        return bool(
            self.http_base_url
            and self.auth_token
            and self._sender_domain()
            and self._sender_domain() == self._recipient_domain(to)
        )

    def _request_json(
        self,
        url: str,
        *,
        method: str = "GET",
        body: Any | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        data = None
        request_headers = {"Accept": "application/json", **(headers or {})}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        request = Request(url, method=method, data=data, headers=request_headers)
        with urlopen(
            request,
            context=_ssl_context(self.reject_unauthorized),
            timeout=DEFAULT_HTTP_TIMEOUT_SECS,
        ) as response:
            return json.loads(response.read().decode("utf-8"))

    def _resolve_aamp_api_url(self) -> str:
        if self._api_url:
            return self._api_url
        if not self.http_base_url:
            raise RuntimeError("HTTP send fallback is not configured")
        base = self.http_base_url.rstrip("/")
        discovery = self._request_json(f"{base}/.well-known/aamp")
        api_url = discovery.get("api", {}).get("url")
        if not api_url:
            raise RuntimeError("AAMP discovery did not return api.url")
        self._api_url = urljoin(f"{base}/", api_url)
        return self._api_url

    def _send_via_http(
        self,
        *,
        to: str,
        subject: str,
        text: str,
        aamp_headers: dict[str, str],
        attachments: list[Attachment] | None = None,
    ) -> str:
        if not self.auth_token:
            raise RuntimeError("HTTP send fallback is not configured")
        api_url = f"{self._resolve_aamp_api_url()}?{urlencode({'action': 'aamp.mailbox.send'})}"
        payload = {
            "to": to,
            "subject": subject,
            "text": text,
            "aampHeaders": aamp_headers,
            "attachments": [
                {
                    "filename": item.filename,
                    "contentType": item.content_type,
                    "content": base64.b64encode(item.as_bytes()).decode("ascii"),
                }
                for item in (attachments or [])
            ],
        }
        response = self._request_json(
            api_url,
            method="POST",
            body=payload,
            headers={"Authorization": f"Basic {self.auth_token}"},
        )
        return str(response.get("messageId", ""))

    def _send_smtp(
        self,
        *,
        to: str,
        subject: str,
        text: str,
        aamp_headers: dict[str, str],
        in_reply_to: str | None = None,
        attachments: list[Attachment] | None = None,
    ) -> str:
        message = EmailMessage()
        message["From"] = self.user
        message["To"] = to
        message["Subject"] = _sanitize(subject)
        message["Message-ID"] = make_msgid(domain=self._sender_domain() or None)
        if in_reply_to:
            message["In-Reply-To"] = in_reply_to
            message["References"] = in_reply_to
        for name, value in aamp_headers.items():
            message[name] = value
        message.set_content(text)

        for attachment in attachments or []:
            main_type, _, sub_type = attachment.content_type.partition("/")
            message.add_attachment(
                attachment.as_bytes(),
                maintype=main_type or "application",
                subtype=sub_type or "octet-stream",
                filename=attachment.filename,
            )

        context = _ssl_context(self.reject_unauthorized)
        if self.secure:
            client: smtplib.SMTP = smtplib.SMTP_SSL(self.host, self.port, context=context)
        else:
            client = smtplib.SMTP(self.host, self.port)

        with client:
            client.ehlo()
            if not self.secure:
                client.starttls(context=context)
                client.ehlo()
            client.login(self.user, self.password)
            client.send_message(message)
        return str(message["Message-ID"] or "")

    def _dispatch(
        self,
        *,
        to: str,
        subject: str,
        text: str,
        aamp_headers: dict[str, str],
        in_reply_to: str | None = None,
        attachments: list[Attachment] | None = None,
    ) -> str:
        if self._should_use_http_fallback(to):
            return self._send_via_http(
                to=to,
                subject=subject,
                text=text,
                aamp_headers=aamp_headers,
                attachments=attachments,
            )
        return self._send_smtp(
            to=to,
            subject=subject,
            text=text,
            aamp_headers=aamp_headers,
            in_reply_to=in_reply_to,
            attachments=attachments,
        )

    def send_task(
        self,
        *,
        to: str,
        title: str,
        body_text: str = "",
        task_id: str | None = None,
        priority: str = "normal",
        expires_at: str | None = None,
        context_links: list[str] | None = None,
        dispatch_context: dict[str, str] | None = None,
        parent_task_id: str | None = None,
        attachments: list[Attachment] | None = None,
    ) -> tuple[str, str]:
        resolved_task_id = task_id or str(uuid.uuid4())
        headers = build_dispatch_headers(
            resolved_task_id,
            priority=priority,
            expires_at=expires_at,
            context_links=context_links or [],
            dispatch_context=dispatch_context,
            parent_task_id=parent_task_id,
        )
        text = "\n".join(
            item
            for item in [
                f"Task: {title}",
                f"Task ID: {resolved_task_id}",
                f"Priority: {priority}",
                f"Expires At: {expires_at or 'none'}",
                f"Context:\n" + "\n".join(f"  {link}" for link in (context_links or []))
                if context_links
                else "",
                body_text,
                "",
                "--- This email was sent by AAMP. Reply directly to submit your result. ---",
            ]
            if item
        )
        message_id = self._dispatch(
            to=to,
            subject=f"[AAMP Task] {_sanitize(title)}",
            text=text,
            aamp_headers=headers,
            attachments=attachments,
        )
        return resolved_task_id, message_id

    def send_result(
        self,
        *,
        to: str,
        task_id: str,
        status: str,
        output: str,
        error_msg: str | None = None,
        structured_result: Any | None = None,
        in_reply_to: str | None = None,
        attachments: list[Attachment] | None = None,
    ) -> None:
        headers = build_result_headers(
            task_id,
            status=status,
            output=output,
            error_msg=error_msg,
            structured_result=structured_result,
        )
        text = "\n".join(
            item
            for item in [
                "AAMP Task Result",
                "",
                f"Task ID: {task_id}",
                f"Status: {status}",
                "",
                "Output:",
                output,
                f"\nError: {error_msg}" if error_msg else "",
            ]
            if item != ""
        )
        self._dispatch(
            to=to,
            subject=f"[AAMP Result] Task {task_id} - {status}",
            text=text,
            aamp_headers=headers,
            in_reply_to=in_reply_to,
            attachments=attachments,
        )

    def send_help(
        self,
        *,
        to: str,
        task_id: str,
        question: str,
        blocked_reason: str,
        suggested_options: list[str] | None = None,
        in_reply_to: str | None = None,
        attachments: list[Attachment] | None = None,
    ) -> None:
        options = suggested_options or []
        headers = build_help_headers(
            task_id,
            question=question,
            blocked_reason=blocked_reason,
            suggested_options=options,
        )
        options_block = "\n".join(f"  {index}. {value}" for index, value in enumerate(options, start=1))
        text = "\n".join(
            item
            for item in [
                "AAMP Task Help Request",
                "",
                f"Task ID: {task_id}",
                "",
                f"Question: {question}",
                "",
                f"Blocked reason: {blocked_reason}",
                "",
                f"Suggested options:\n{options_block}" if options_block else "",
            ]
            if item
        )
        self._dispatch(
            to=to,
            subject=f"[AAMP Help] Task {task_id} needs assistance",
            text=text,
            aamp_headers=headers,
            in_reply_to=in_reply_to,
            attachments=attachments,
        )

    def send_cancel(
        self,
        *,
        to: str,
        task_id: str,
        body_text: str = "The dispatcher cancelled this task.",
        in_reply_to: str | None = None,
    ) -> None:
        self._dispatch(
            to=to,
            subject=f"[AAMP Cancel] Task {task_id}",
            text=body_text,
            aamp_headers=build_cancel_headers(task_id),
            in_reply_to=in_reply_to,
        )

    def send_ack(self, *, to: str, task_id: str, in_reply_to: str | None = None) -> None:
        self._dispatch(
            to=to,
            subject=f"[AAMP ACK] Task {task_id}",
            text="",
            aamp_headers=build_ack_headers(task_id),
            in_reply_to=in_reply_to,
        )

    def send_stream_opened(
        self,
        *,
        to: str,
        task_id: str,
        stream_id: str,
        in_reply_to: str | None = None,
    ) -> None:
        self._dispatch(
            to=to,
            subject=f"[AAMP Stream] Task {task_id}",
            text=f"AAMP task stream is ready.\n\nTask ID: {task_id}\nStream ID: {stream_id}",
            aamp_headers=build_stream_opened_headers(task_id, stream_id),
            in_reply_to=in_reply_to,
        )

    def send_card_query(
        self,
        *,
        to: str,
        body_text: str = "Please share your agent card and capability details.",
        task_id: str | None = None,
        in_reply_to: str | None = None,
    ) -> tuple[str, str]:
        resolved_task_id = task_id or str(uuid.uuid4())
        message_id = self._dispatch(
            to=to,
            subject=f"[AAMP Card Query] {resolved_task_id}",
            text=body_text.strip(),
            aamp_headers=build_card_query_headers(resolved_task_id),
            in_reply_to=in_reply_to,
        )
        return resolved_task_id, message_id

    def send_card_response(
        self,
        *,
        to: str,
        task_id: str,
        summary: str,
        body_text: str,
        in_reply_to: str | None = None,
    ) -> None:
        self._dispatch(
            to=to,
            subject=f"[AAMP Card] {_sanitize(summary)}",
            text=body_text,
            aamp_headers=build_card_response_headers(task_id, summary),
            in_reply_to=in_reply_to,
        )
