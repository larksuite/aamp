"""A tiny event emitter used by the Python SDK."""

from __future__ import annotations

import threading
from collections import defaultdict
from typing import Any, Callable


Listener = Callable[..., Any]


class TinyEmitter:
    def __init__(self) -> None:
        self._listeners: dict[str, list[Listener]] = defaultdict(list)
        self._once_wrappers: dict[tuple[str, Listener], Listener] = {}
        self._lock = threading.RLock()

    def on(self, event: str, listener: Listener) -> "TinyEmitter":
        with self._lock:
            self._listeners[event].append(listener)
        return self

    def once(self, event: str, listener: Listener) -> "TinyEmitter":
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            self.off(event, listener)
            return listener(*args, **kwargs)

        with self._lock:
            self._once_wrappers[(event, listener)] = wrapped
            self._listeners[event].append(wrapped)
        return self

    def off(self, event: str, listener: Listener) -> "TinyEmitter":
        with self._lock:
            wrapped = self._once_wrappers.pop((event, listener), None)
            target = wrapped or listener
            bucket = self._listeners.get(event, [])
            self._listeners[event] = [item for item in bucket if item is not target]
            if not self._listeners[event]:
                self._listeners.pop(event, None)
        return self

    def emit(self, event: str, *args: Any, **kwargs: Any) -> bool:
        with self._lock:
            listeners = list(self._listeners.get(event, []))
        for listener in listeners:
            listener(*args, **kwargs)
        return bool(listeners)
