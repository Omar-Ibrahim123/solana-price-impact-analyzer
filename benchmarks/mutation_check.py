"""Do the engine's tests actually catch bugs? Inject some and see.

    python -m benchmarks.mutation_check

Each "mutant" below is a copy of ``orderbook.py`` with one realistic bug
planted in it (the kind of slip that is easy to make in a linked-list
order book). For every mutant we copy the package to a temporary folder,
plant the bug, and run the engine test files against it. A test suite is
only as good as the bugs it catches: every mutant should be "caught" (some
test fails). A mutant that survives points at a missing test.

This is called mutation testing. It never touches the real source files.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PACKAGE = REPO / "src" / "impact_analyzer"
TESTS = ["tests/test_engine_properties.py", "tests/test_orderbook.py"]

I2, I3, I5 = " " * 8, " " * 12, " " * 20  # indentation levels inside orderbook.py

# (name, text to find in orderbook.py, what to replace it with)
MUTANTS: list[tuple[str, str, str]] = [
    (
        "cancel leaves an empty price level behind",
        f"{I2}if not level:\n{I3}del book[order.price_ticks]\n{I2}return True",
        f"{I2}return True",
    ),
    (
        "a partial fill sends the maker to the back of the queue",
        f"{I5}maker.size_lots -= traded\n{I5}level.total_size -= traded\n",
        f"{I5}maker.size_lots -= traded\n{I5}level.total_size -= traded\n"
        f"{I5}level.remove(maker)\n{I5}level.append(maker)\n",
    ),
    (
        "tail not updated when the only node is removed",
        f"{I2}if order.next is None:\n{I3}self.tail = order.prev",
        f"{I2}if order.next is None and order.prev is not None:\n{I3}self.tail = order.prev",
    ),
    (
        "a sell's limit price is off by one tick",
        "too_cheap = side is Side.ASK and price < limit_price",
        "too_cheap = side is Side.ASK and price <= limit_price",
    ),
    (
        "level total not reduced when an order is removed",
        f"{I2}self.total_size -= order.size_lots\n{I2}self.count -= 1",
        f"{I2}self.count -= 1",
    ),
    (
        "fills print at the taker's limit instead of the maker's price",
        "fills.append(Fill(maker.order_id, price, traded))",
        "fills.append(Fill(maker.order_id, limit_price or price, traded))",
    ),
    (
        "a fully filled maker stays in the id map",
        f"{I5}level.remove(maker)\n{I5}del self.orders[maker.order_id]",
        f"{I5}level.remove(maker)",
    ),
    (
        "an IOC order rests its remainder like a GTC order",
        "if remaining > 0 and tif is TimeInForce.GTC:",
        "if remaining > 0:",
    ),
]


def run_mutant(name: str, find: str, replace: str, workdir: Path) -> bool:
    """Plant one bug in a copy of the package; return True if the tests catch it."""
    target = workdir / "impact_analyzer"
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(PACKAGE, target, ignore=shutil.ignore_patterns("__pycache__"))
    source = (target / "orderbook.py").read_text(encoding="utf-8")
    if source.count(find) != 1:
        raise RuntimeError(f"mutant {name!r}: its text isn't in orderbook.py exactly once")
    (target / "orderbook.py").write_text(source.replace(find, replace), encoding="utf-8")
    # PYTHONPATH puts the mutated copy ahead of the real package on the import path.
    env = {**os.environ, "PYTHONPATH": str(workdir), "HYPOTHESIS_PROFILE": "ci"}
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider", *TESTS],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
    )
    return result.returncode != 0  # a failing test run means the bug was caught


def main() -> int:
    caught = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name, find, replace in MUTANTS:
            hit = run_mutant(name, find, replace, Path(tmp))
            caught += hit
            print(f"{'caught  ' if hit else 'SURVIVED'}  {name}")
    print(f"\n{caught}/{len(MUTANTS)} planted bugs caught by the engine tests")
    return 0 if caught == len(MUTANTS) else 1


if __name__ == "__main__":
    sys.exit(main())
