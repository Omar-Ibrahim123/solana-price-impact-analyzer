# Solana Price Impact Analyzer

How much does a large market order move the price on an on-chain order book (Phoenix, Solana)
compared with a centralized exchange? This project rebuilds a price-time priority matching engine,
loads a live Phoenix SOL/USDC snapshot into it, and simulates $1K to $1M market orders against it,
Kraken and Coinbase, plus a constant-product AMM for reference.

## Findings

> Fill this in after a live run (`python -m impact_analyzer run`): paste the table, embed
> `docs/impact.png` with `![Impact vs. trade size](docs/impact.png)`, and write two or three
> sentences on what the numbers say.

## How it works

```
Solana RPC ──getAccountInfo──▶ phoenix.py ─┐
Kraken REST ─────────────────▶ cex.py ─────┼──▶ BookSnapshot ──▶ convert.py ──▶ OrderBook
Coinbase REST ───────────────▶ cex.py ─────┘   (ticks + lots)                  (matching engine)
                                                                                     │
                                       impact.py: one market order per size ◀────────┘
                                                     │
                                  table · results.json · plot.py chart · playground export
```

1. **Fetch.** Phoenix stores a whole market in one Solana account. `phoenix.py` downloads its raw
   bytes over JSON-RPC and decodes them with `struct`, using the same layout as Ellipsis Labs'
   own Python client (`phoenix-trade`). Kraken and Coinbase publish their books as JSON.
2. **Normalize.** Every venue becomes a `BookSnapshot` of integer ticks and lots, best price first
   and oldest first within a price, so the rest of the pipeline is identical for every venue.
3. **Match.** `convert.py` replays the snapshot into the engine. `impact.py` then sends a market
   order of each size to a fresh copy of the book and records the fills.
4. **Measure.** Impact is `(average fill − mid) / mid × 10,000` bps for buys (sign flipped for
   sells). It includes the half-spread, so spread dominates small trades and depth dominates large
   ones.

### The matching engine

| Structure | Why |
| --- | --- |
| `SortedDict` of price → level per side | best price in O(1), a new price level in O(log L) |
| Doubly linked list of orders per level | FIFO time priority; unlink from anywhere in O(1) |
| `dict` of order id → node | cancel jumps straight to the node in O(1) |

Fills always print at the resting (maker) order's price; a partially filled maker keeps its place
at the head of the queue. Prices and sizes are integers end to end, as on-chain programs require
(every validator must compute the same result, which floats don't guarantee).

`python -m benchmarks.bench_engine` replays 1M random adds, cancels and market orders through it.

## Run it

Requires Python 3.11+.

```sh
python -m venv .venv
source .venv/bin/activate          # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -e ".[dev]"
pytest                             # offline test suite
python -m impact_analyzer demo     # whole pipeline on synthetic books, no network
python -m impact_analyzer run      # live: fetch all three venues, analyze, chart
```

Other commands: `fetch` (save snapshots to `data/`), `analyze [files...]` (re-run on saved
snapshots; defaults to the newest per venue). The public Solana RPC is rate limited; set
`SOLANA_RPC_URL` or pass `--rpc` to use another. `pytest -m network` runs the live smoke test.

`run` also writes `data/playground.json`, which the interactive Order Book Playground can load to
draw the real books and their impact curves side by side.

## Layout

| Path | What it is |
| --- | --- |
| `src/impact_analyzer/orderbook.py` | Limit order book + price-time priority matching engine |
| `src/impact_analyzer/snapshot.py` | Venue-neutral snapshot (ticks, lots), JSON save/load |
| `src/impact_analyzer/phoenix.py` | Fetch and decode a Phoenix market account |
| `src/impact_analyzer/cex.py` | Kraken and Coinbase order books |
| `src/impact_analyzer/convert.py` | Snapshot → engine `OrderBook` |
| `src/impact_analyzer/impact.py` | Average fill price and impact in bps |
| `src/impact_analyzer/amm.py` | Constant-product (x·y=k) pool with equivalent depth |
| `src/impact_analyzer/plot.py` | Impact vs. trade size chart |
| `src/impact_analyzer/synthetic.py` | Made-up books for the offline demo and tests |
| `src/impact_analyzer/__main__.py` | Command line |
| `benchmarks/` | Random order flow + throughput benchmark |
| `tests/` | pytest suite (Phoenix decoder tested on an encoded synthetic account) |

## Caveats

- A snapshot is one instant. Real takers face makers who re-quote, and other takers.
- Kraken and Coinbase return aggregated levels with limited depth (Kraken up to 500 levels,
  Coinbase level 2 top 50). A large order can exhaust what the API shows even when the venue has
  more; the table marks those sizes with `*`.
- Fees are excluded from the order book numbers (Phoenix's taker fee is saved in the snapshot).
- The AMM benchmark is sized to hold the same USD within 2% of mid as the first venue's book. It
  answers "what if this liquidity sat in an x·y=k pool instead?", not what any real pool holds.
