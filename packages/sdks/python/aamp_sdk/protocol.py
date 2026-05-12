"""Protocol helpers for AAMP."""

from __future__ import annotations

import base64
import json
import re
from email.header import decode_header
from typing import Any, Mapping

AAMP_PROTOCOL_VERSION = "1.1"

AAMP_HEADER = {
    "VERSION": "X-AAMP-Version",
    "INTENT": "X-AAMP-Intent",
    "TASK_ID": "X-AAMP-TaskId",
    "DISPATCH_CONTEXT": "X-AAMP-Dispatch-Context",
    "PRIORITY": "X-AAMP-Priority",
    "EXPIRES_AT": "X-AAMP-Expires-At",
    "STATUS": "X-AAMP-Status",
    "ERROR_MSG": "X-AAMP-ErrorMsg",
    "STRUCTURED_RESULT": "X-AAMP-StructuredResult",
    "SUGGESTED_OPTIONS": "X-AAMP-SuggestedOptions",
    "STREAM_ID": "X-AAMP-Stream-Id",
    "PARENT_TASK_ID": "X-AAMP-ParentTaskId",
    "CARD_SUMMARY": "X-AAMP-Card-Summary",
}

_DISPATCH_CONTEXT_KEY_RE = re.compile(r"^[a-z0-9_-]+$")


def normalize_headers(headers: Mapping[str, Any]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, value in headers.items():
        header_value = value[0] if isinstance(value, (list, tuple)) else value
        normalized[str(key).lower()] = str(header_value)
    return normalized


def parse_dispatch_context_header(value: str | None) -> dict[str, str] | None:
    if not value:
        return None

    context: dict[str, str] = {}
    for part in value.split(";"):
        segment = part.strip()
        if not segment or "=" not in segment:
            continue
        raw_key, raw_value = segment.split("=", 1)
        key = raw_key.strip().lower()
        encoded_value = raw_value.strip()
        if not _DISPATCH_CONTEXT_KEY_RE.match(key):
            continue
        try:
            from urllib.parse import unquote

            context[key] = unquote(encoded_value)
        except Exception:
            context[key] = encoded_value

    return context or None


def serialize_dispatch_context_header(context: Mapping[str, Any] | None) -> str | None:
    if not context:
        return None

    from urllib.parse import quote

    parts: list[str] = []
    for raw_key, raw_value in context.items():
        key = str(raw_key).strip().lower()
        value = str(raw_value).strip()
        if not value or not _DISPATCH_CONTEXT_KEY_RE.match(key):
            continue
        parts.append(f"{key}={quote(value, safe='')}")

    return "; ".join(parts) or None


def _encode_structured_result(value: Any | None) -> str | None:
    if value is None:
        return None
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_structured_result(value: str | None) -> Any | None:
    if not value:
        return None
    padding = "=" * (-len(value) % 4)
    decoded = base64.urlsafe_b64decode((value + padding).encode("ascii"))
    return json.loads(decoded.decode("utf-8"))


def _decode_subject(value: str | None) -> str:
    if not value:
        return ""

    parts: list[str] = []
    for piece, encoding in decode_header(value):
        if isinstance(piece, bytes):
            parts.append(piece.decode(encoding or "utf-8", errors="replace"))
        else:
            parts.append(piece)
    return "".join(parts).strip()


def _normalize_body_text(value: str | None) -> str:
    return (value or "").replace("\r\n", "\n").strip()


def _extract_body_section(body_text: str, label: str, next_labels: list[str]) -> str:
    if not body_text:
        return ""
    next_pattern = "|".join(re.escape(item) for item in next_labels)
    if next_pattern:
        pattern = rf"(?:^|\n){re.escape(label)}:\s*([\s\S]*?)(?=\n(?:{next_pattern}):|$)"
    else:
        pattern = rf"(?:^|\n){re.escape(label)}:\s*([\s\S]*?)$"
    match = re.search(pattern, body_text, flags=re.IGNORECASE)
    return match.group(1).strip() if match else ""


def _parse_suggested_options(block: str) -> list[str]:
    if not block.strip():
        return []
    lines: list[str] = []
    for line in block.splitlines():
        cleaned = re.sub(r"^\s*(?:[-*]|\d+\.)\s*", "", line).strip()
        if cleaned:
            lines.append(cleaned)
    return lines


def _parse_task_result_body(body_text: str | None) -> dict[str, Any]:
    normalized = _normalize_body_text(body_text)
    if not normalized:
        return {"output": ""}

    output = _extract_body_section(normalized, "Output", ["Error"])
    error_msg = _extract_body_section(normalized, "Error", [])

    if output or error_msg:
        payload: dict[str, Any] = {"output": output}
        if error_msg:
            payload["errorMsg"] = error_msg
        return payload

    return {"output": normalized}


def _parse_task_help_body(body_text: str | None) -> dict[str, Any]:
    normalized = _normalize_body_text(body_text)
    if not normalized:
        return {"question": "", "blockedReason": "", "suggestedOptions": []}

    question = _extract_body_section(normalized, "Question", ["Blocked reason", "Suggested options"])
    blocked_reason = _extract_body_section(normalized, "Blocked reason", ["Suggested options"])
    suggested_options = _parse_suggested_options(
        _extract_body_section(normalized, "Suggested options", [])
    )

    if question or blocked_reason or suggested_options:
        return {
            "question": question,
            "blockedReason": blocked_reason,
            "suggestedOptions": suggested_options,
        }

    return {"question": normalized, "blockedReason": "", "suggestedOptions": []}


def build_dispatch_headers(
    task_id: str,
    priority: str | None = None,
    expires_at: str | None = None,
    dispatch_context: Mapping[str, Any] | None = None,
    parent_task_id: str | None = None,
) -> dict[str, str]:
    headers = {
        AAMP_HEADER["VERSION"]: AAMP_PROTOCOL_VERSION,
        AAMP_HEADER["INTENT"]: "task.dispatch",
        AAMP_HEADER["TASK_ID"]: task_id,
        AAMP_HEADER["PRIORITY"]: priority or "normal",
    }
    if expires_at:
        headers[AAMP_HEADER["EXPIRES_AT"]] = expires_at
    serialized_context = serialize_dispatch_context_header(dispatch_context)
    if serialized_context:
        headers[AAMP_HEADER["DISPATCH_CONTEXT"]] = serialized_context
    if parent_task_id:
        headers[AAMP_HEADER["PARENT_TASK_ID"]] = parent_task_id
    return headers


def build_cancel_headers(task_id: str) -> dict[str, str]:
    return {
        AAMP_HEADER["VERSION"]: AAMP_PROTOCOL_VERSION,
        AAMP_HEADER["INTENT"]: "task.cancel",
        AAMP_HEADER["TASK_ID"]: task_id,
    }


def build_ack_headers(task_id: str) -> dict[str, str]:
    return {
        AAMP_HEADER["VERSION"]: AAMP_PROTOCOL_VERSION,
        AAMP_HEADER["INTENT"]: "task.ack",
        AAMP_HEADER["TASK_ID"]: task_id,
    }


def build_stream_opened_headers(task_id: str, stream_id: str) -> dict[str, str]:
    return {
        AAMP_HEADER["VERSION"]: AAMP_PROTOCOL_VERSION,
        AAMP_HEADER["INTENT"]: "task.stream.opened",
        AAMP_HEADER["TASK_ID"]: task_id,
        AAMP_HEADER["STREAM_ID"]: stream_id,
    }


def build_result_headers(
    task_id: str,
    status: str,
    output: str,
    error_msg: str | None = None,
    structured_result: Any | None = None,
) -> dict[str, str]:
    headers = {
        AAMP_HEADER["VERSION"]: AAMP_PROTOCOL_VERSION,
        AAMP_HEADER["INTENT"]: "task.result",
        AAMP_HEADER["TASK_ID"]: task_id,
        AAMP_HEADER["STATUS"]: status,
    }
    if error_msg:
        headers[AAMP_HEADER["ERROR_MSG"]] = error_msg
    encoded_structured_result = _encode_structured_result(structured_result)
    if encoded_structured_result:
        headers[AAMP_HEADER["STRUCTURED_RESULT"]] = encoded_structured_result
    return headers


def build_help_headers(
    task_id: str,
    question: str,
    blocked_reason: str,
    suggested_options: list[str] | None = None,
) -> dict[str, str]:
    del question, blocked_reason
    return {
        AAMP_HEADER["VERSION"]: AAMP_PROTOCOL_VERSION,
        AAMP_HEADER["INTENT"]: "task.help_needed",
        AAMP_HEADER["TASK_ID"]: task_id,
        AAMP_HEADER["SUGGESTED_OPTIONS"]: "|".join(suggested_options or []),
    }


def build_card_query_headers(task_id: str) -> dict[str, str]:
    return {
        AAMP_HEADER["VERSION"]: AAMP_PROTOCOL_VERSION,
        AAMP_HEADER["INTENT"]: "card.query",
        AAMP_HEADER["TASK_ID"]: task_id,
    }


def build_card_response_headers(task_id: str, summary: str) -> dict[str, str]:
    return {
        AAMP_HEADER["VERSION"]: AAMP_PROTOCOL_VERSION,
        AAMP_HEADER["INTENT"]: "card.response",
        AAMP_HEADER["TASK_ID"]: task_id,
        AAMP_HEADER["CARD_SUMMARY"]: summary,
    }


def parse_aamp_headers(meta: Mapping[str, Any]) -> dict[str, Any] | None:
    headers = normalize_headers(meta.get("headers", {}))
    intent = headers.get(AAMP_HEADER["INTENT"].lower())
    task_id = headers.get(AAMP_HEADER["TASK_ID"].lower())
    protocol_version = headers.get(AAMP_HEADER["VERSION"].lower(), AAMP_PROTOCOL_VERSION)
    if not intent or not task_id:
        return None

    from_value = str(meta.get("from", "")).strip("<>")
    to_value = str(meta.get("to", "")).strip("<>")
    subject = _decode_subject(meta.get("subject"))
    message_id = meta.get("messageId") or meta.get("message_id", "")
    body_text = meta.get("bodyText") or meta.get("body_text", "")

    base = {
        "protocolVersion": protocol_version,
        "intent": intent,
        "taskId": task_id,
        "from": from_value,
        "to": to_value,
        "messageId": message_id,
        "subject": subject,
    }

    if intent == "task.dispatch":
        return {
            **base,
            "title": subject.replace("[AAMP Task]", "").strip() or subject,
            "priority": headers.get(AAMP_HEADER["PRIORITY"].lower(), "normal"),
            "expiresAt": headers.get(AAMP_HEADER["EXPIRES_AT"].lower()),
            "dispatchContext": parse_dispatch_context_header(
                headers.get(AAMP_HEADER["DISPATCH_CONTEXT"].lower())
            ),
            "parentTaskId": headers.get(AAMP_HEADER["PARENT_TASK_ID"].lower()),
            "bodyText": _normalize_body_text(body_text),
        }

    if intent == "task.cancel":
        return {**base, "bodyText": _normalize_body_text(body_text)}

    if intent == "task.result":
        payload = _parse_task_result_body(body_text)
        structured_result = _decode_structured_result(
            headers.get(AAMP_HEADER["STRUCTURED_RESULT"].lower())
        )
        return {
            **base,
            "status": headers.get(AAMP_HEADER["STATUS"].lower(), "completed"),
            "output": payload.get("output", ""),
            "errorMsg": payload.get("errorMsg") or headers.get(AAMP_HEADER["ERROR_MSG"].lower()),
            "structuredResult": structured_result,
        }

    if intent == "task.help_needed":
        payload = _parse_task_help_body(body_text)
        return {**base, **payload}

    if intent == "task.ack":
        return base

    if intent == "task.stream.opened":
        return {**base, "streamId": headers.get(AAMP_HEADER["STREAM_ID"].lower(), "")}

    if intent == "card.query":
        return {**base, "bodyText": _normalize_body_text(body_text)}

    if intent == "card.response":
        return {
            **base,
            "summary": headers.get(AAMP_HEADER["CARD_SUMMARY"].lower(), ""),
            "bodyText": _normalize_body_text(body_text),
        }

    return None
