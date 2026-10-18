"""Retries and backoff, tested against a fake server (httpx.MockTransport): no network."""

import httpx
import pytest

from impact_analyzer.net import FetchError, Http, HttpStatusError


def scripted(*responses):
    """A transport that replays ``responses`` in order; each is a Response or an exception."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        item = responses[len(calls) - 1]
        if isinstance(item, Exception):
            raise item
        return item

    return httpx.MockTransport(handler), calls


def make_http(transport, sleeps, retries=3, clock=lambda: 1000.0):
    return Http(transport=transport, sleep=sleeps.append, retries=retries, clock=clock)


def test_success_first_try():
    transport, calls = scripted(httpx.Response(200, json={"ok": 1}))
    sleeps = []
    resp = make_http(transport, sleeps).get_json("https://x.test/a")
    assert resp.body == {"ok": 1} and resp.attempts == 1 and sleeps == []
    assert calls[0].headers["User-Agent"].startswith("solana-price-impact-analyzer")


def test_429_honours_retry_after():
    transport, _ = scripted(
        httpx.Response(429, headers={"Retry-After": "7"}), httpx.Response(200, json={})
    )
    sleeps = []
    resp = make_http(transport, sleeps).get_json("https://x.test/a")
    assert resp.attempts == 2 and sleeps == [7.0]


def test_429_waits_for_ratelimit_reset():
    # Jupiter style: no Retry-After, but the unix time the window reopens.
    transport, _ = scripted(
        httpx.Response(429, headers={"x-ratelimit-reset": "1004"}), httpx.Response(200, json={})
    )
    sleeps = []
    make_http(transport, sleeps, clock=lambda: 1000.0).get_json("https://x.test/a")
    assert sleeps == [pytest.approx(4.25)]


def test_5xx_and_timeouts_retry_with_growing_backoff():
    transport, calls = scripted(
        httpx.Response(503),
        httpx.ReadTimeout("slow"),
        httpx.Response(502),
        httpx.Response(200, json={"ok": True}),
    )
    sleeps = []
    resp = make_http(transport, sleeps).get_json("https://x.test/a")
    assert resp.attempts == 4 and len(calls) == 4
    # 1 s, 2 s, 4 s, each with jitter in [0.5, 1.5).
    for wait, base in zip(sleeps, (1, 2, 4), strict=True):
        assert 0.5 * base <= wait < 1.5 * base


def test_gives_up_after_retries():
    transport, calls = scripted(*[httpx.Response(500)] * 3)
    with pytest.raises(FetchError) as info:
        make_http(transport, [], retries=2).get_json("https://x.test/a")
    assert info.value.attempts == 3 and len(calls) == 3


def test_4xx_is_not_retried_and_keeps_body():
    transport, calls = scripted(httpx.Response(400, text='{"errorCode": "NO_ROUTES_FOUND"}'))
    with pytest.raises(HttpStatusError) as info:
        make_http(transport, []).get_json("https://x.test/a")
    assert info.value.status == 400 and "NO_ROUTES_FOUND" in info.value.body
    assert len(calls) == 1


def test_broken_response_body_is_retried():
    # A corrupt gzip body raises httpx.DecodingError (a RequestError, not a TransportError).
    transport, calls = scripted(httpx.DecodingError("bad gzip"), httpx.Response(200, json={}))
    resp = make_http(transport, []).get_json("https://x.test/a")
    assert resp.attempts == 2 and len(calls) == 2
