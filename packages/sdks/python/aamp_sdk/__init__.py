"""Python SDK for portable AAMP integrations."""

from .client import AampClient
from .events import TinyEmitter
from .jmap_push import JmapPushClient
from .protocol import (
    AAMP_HEADER,
    AAMP_PROTOCOL_VERSION,
    build_ack_headers,
    build_cancel_headers,
    build_card_query_headers,
    build_card_response_headers,
    build_dispatch_headers,
    build_help_headers,
    build_result_headers,
    build_stream_opened_headers,
    normalize_headers,
    parse_aamp_headers,
    parse_dispatch_context_header,
    serialize_dispatch_context_header,
)
from .smtp import Attachment, SmtpSender, derive_mailbox_service_defaults

__all__ = [
    "AampClient",
    "AAMP_HEADER",
    "AAMP_PROTOCOL_VERSION",
    "Attachment",
    "JmapPushClient",
    "SmtpSender",
    "TinyEmitter",
    "build_ack_headers",
    "build_cancel_headers",
    "build_card_query_headers",
    "build_card_response_headers",
    "build_dispatch_headers",
    "build_help_headers",
    "build_result_headers",
    "build_stream_opened_headers",
    "derive_mailbox_service_defaults",
    "normalize_headers",
    "parse_aamp_headers",
    "parse_dispatch_context_header",
    "serialize_dispatch_context_header",
]
