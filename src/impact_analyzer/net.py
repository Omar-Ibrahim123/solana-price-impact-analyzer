"""HTTP with retries, backoff and latency measurement, shared by every fetcher.

The collector calls four public APIs every few minutes for a day. Any of them
can time out, return a 5xx, or rate-limit us with a 429. This module turns
those into a few patient retries, and reports what happened (latency of the
successful attempt, number of attempts) so the collector can store it.

What is retried, and why:

- network errors and timeouts: usually transient;
- 429 Too Many Requests: we were too fast; wait as long as ``Retry-After`` says;
- 5xx: the server's problem, often gone a second later.

Any other 4xx (bad request, not found, "no route") is the caller's problem
and retrying would only repeat it, so it raises ``HttpStatusError`` at once.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

USER_AGENT = "solana-price-impact-analyzer/0.2 (educational project)"
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_RETRY_AFTER_S = 60.0  # never let a server park us for longer than this


class FetchError(RuntimeError):
    """A request failed after every retry. ``attempts`` says how many were made."""

    def __init__(self, message: str, attempts: int) -> None:
        super().__init__(message)
        self.attempts = attempts


class HttpStatusError(FetchError):
    """A non-retryable HTTP error (e.g. 400). ``body`` keeps the server's explanation."""

    def __init__(self, status: int, body: str, attempts: int) -> None:
        super().__init__(f"HTTP {status}: {body[:300]}", attempts)
        self.status = status
        self.body = body


@dataclass(frozen=True, slots=True)
class JsonResponse:
    body: Any  # decoded JSON
    latency_ms: float  # wall time of the attempt that succeeded
    attempts: int  # 1 = first try worked


class Http:
    """A small wrapper around one ``httpx.Client`` (connection reuse keeps latency low).

    ``sleep`` and ``rng`` are injectable so tests run instantly and deterministically.
    ``httpx.Client`` is thread-safe, so one ``Http`` can serve the collector's thread pool.
    """

    def __init__(
        self,
        timeout: float = 15.0,
        retries: int = 3,
        backoff_s: float = 1.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        rng: random.Random | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.client = httpx.Client(
            timeout=timeout, headers={"User-Agent": USER_AGENT}, transport=transport
        )
        self.retries = retries
        self.backoff_s = backoff_s
        self.sleep = sleep
        self.rng = rng or random.Random()
        self.clock = clock

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> Http:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def get_json(self, url: str, params: dict | None = None) -> JsonResponse:
        return self._request("GET", url, params=params)

    def post_json(self, url: str, payload: dict) -> JsonResponse:
        return self._request("POST", url, json=payload)

    def _delay(self, attempt: int, retry_after: str | None, reset_at: str | None = None) -> float:
        """How long to wait before retry number ``attempt`` (1-based).

        ``retry_after`` is the standard ``Retry-After`` header (seconds).
        ``reset_at`` is ``x-ratelimit-reset`` (unix time the window reopens),
        which Jupiter sends instead.
        """
        if retry_after is not None:
            try:
                return min(float(retry_after), MAX_RETRY_AFTER_S)
            except ValueError:
                pass  # an HTTP-date instead of seconds: fall back to our own backoff
        if reset_at is not None:
            try:
                wait = float(reset_at) - self.clock() + 0.25  # small margin for clock skew
            except ValueError:
                wait = -1.0
            if 0 < wait <= MAX_RETRY_AFTER_S:
                return wait
        # Exponential backoff (1 s, 2 s, 4 s, ...) with jitter, so many clients
        # that failed together don't all retry at the same instant.
        return self.backoff_s * 2 ** (attempt - 1) * (0.5 + self.rng.random())

    def _request(self, method: str, url: str, **kwargs: Any) -> JsonResponse:
        last_error = ""
        for attempt in range(1, self.retries + 2):  # first try + `retries` retries
            start = time.perf_counter()
            try:
                resp = self.client.request(method, url, **kwargs)
            except httpx.TransportError as e:  # timeouts, DNS, refused connections
                last_error = f"{type(e).__name__}: {e}"
                retry_after = reset_at = None
            else:
                latency_ms = (time.perf_counter() - start) * 1000
                if resp.status_code < 400:
                    return JsonResponse(resp.json(), latency_ms, attempt)
                if resp.status_code not in RETRY_STATUSES:
                    raise HttpStatusError(resp.status_code, resp.text, attempt)
                last_error = f"HTTP {resp.status_code}"
                retry_after = resp.headers.get("Retry-After")
                reset_at = resp.headers.get("x-ratelimit-reset")
            if attempt <= self.retries:
                self.sleep(self._delay(attempt, retry_after, reset_at))
        raise FetchError(f"{method} {url} failed: {last_error}", self.retries + 1)
