from benchmarks.order_flow import Add, Cancel, Market, generate


def test_same_seed_same_stream():
    assert list(generate(1_000, seed=7)) == list(generate(1_000, seed=7))


def test_mix_and_invariants():
    events = list(generate(20_000, seed=1))
    added: set[int] = set()
    counts = {Add: 0, Cancel: 0, Market: 0}
    for e in events:
        counts[type(e)] += 1
        if isinstance(e, Add):
            assert e.order_id not in added
            assert (e.price_ticks < 15_000) if e.side == "bid" else (e.price_ticks > 15_000)
            assert e.size_lots > 0
            added.add(e.order_id)
        elif isinstance(e, Cancel):
            assert e.order_id in added  # never cancels an id that was never placed
    assert 0.55 < counts[Add] / len(events) < 0.65
    assert 0.25 < counts[Cancel] / len(events) < 0.35
