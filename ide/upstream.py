"""Kept-open connections to the Ripple server.

A suggestion is a 50 ms request. Opening a new TCP connection for each one costs a
round trip to the server before the request can leave (through an SSH forward it is
also a new channel). This pool keeps connections open and uses them again.
"""

from __future__ import annotations

import http.client
import threading
from collections.abc import Iterator
from urllib.parse import urlsplit

MAX_IDLE_PER_HOST = 8
# What a kept connection shows when the server closed it while it was idle. The request
# did not reach the server, so it is safe to send it again on a new connection.
STALE = (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


class Response:
    """An HTTP response whose connection goes back to the pool when it was read to the end."""

    def __init__(self, raw: http.client.HTTPResponse, release) -> None:
        self._raw = raw
        self._release = release
        self._closed = False
        self.status = raw.status

    def read(self, amount: int | None = None) -> bytes:
        return self._raw.read() if amount is None else self._raw.read(amount)

    def __iter__(self) -> Iterator[bytes]:
        return iter(self._raw)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        reusable = self._raw.isclosed() and not self._raw.will_close  # fully read, and the server keeps it open
        if not reusable:
            self._raw.close()
        self._release(reusable)

    def __enter__(self) -> Response:
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class Pool:
    def __init__(self) -> None:
        self._idle: dict[tuple[str, str, int], list[http.client.HTTPConnection]] = {}
        self._active: dict[tuple[str, str, int], int] = {}
        self._lock = threading.Lock()
        self.opened = 0  # connections made so far

    def _take(self, key: tuple[str, str, int]) -> http.client.HTTPConnection | None:
        with self._lock:
            idle = self._idle.get(key)
            return idle.pop() if idle else None

    @staticmethod
    def _key(url: str) -> tuple[str, str, int]:
        parts = urlsplit(url)
        return (parts.scheme, parts.hostname or "", parts.port or (443 if parts.scheme == "https" else 80))

    def active(self, url: str) -> int:
        """Answers from the server of `url` that are being read right now (a stream in flight counts)."""
        with self._lock:
            return self._active.get(self._key(url), 0)

    def _give(self, key: tuple[str, str, int], connection: http.client.HTTPConnection, reusable: bool) -> None:
        with self._lock:
            self._active[key] = max(0, self._active.get(key, 0) - 1)
        if reusable:
            with self._lock:
                idle = self._idle.setdefault(key, [])
                if len(idle) < MAX_IDLE_PER_HOST:
                    idle.append(connection)
                    return
        connection.close()

    def request(self, method: str, url: str, body: bytes | None = None, headers: dict | None = None,
                timeout: float = 60.0) -> Response:
        parts = urlsplit(url)
        secure = parts.scheme == "https"
        key = self._key(url)
        target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        connection = self._take(key)
        kept = connection is not None
        while True:
            if connection is None:
                maker = http.client.HTTPSConnection if secure else http.client.HTTPConnection
                connection = maker(key[1], key[2], timeout=timeout)
                with self._lock:
                    self.opened += 1
            else:
                connection.timeout = timeout
                if connection.sock is not None:
                    connection.sock.settimeout(timeout)
            try:
                connection.request(method, target, body=body, headers=headers or {})
                raw = connection.getresponse()
            except STALE:
                connection.close()
                if not kept:
                    raise
                connection, kept = None, False  # once more, on a new connection
                continue
            except BaseException:
                connection.close()
                raise
            used = connection
            with self._lock:
                self._active[key] = self._active.get(key, 0) + 1
            return Response(raw, lambda reusable: self._give(key, used, reusable))

    def close(self) -> None:
        with self._lock:
            idle, self._idle = self._idle, {}
        for connections in idle.values():
            for connection in connections:
                connection.close()


POOL = Pool()
