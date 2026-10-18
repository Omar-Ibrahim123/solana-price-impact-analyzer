/* core/glossary.js: every term the course uses, in plain language.
 *
 * Entry shape (id = kebab-case key, used by Term() and #/glossary/<id>):
 *   { term: "Spread", aliases: ["bid-ask spread"], def: "1–3 plain sentences",
 *     project: "optional 'in this project' note", related: ["mid-price", ...], chapter: 2 }
 *
 * Writing rules: a curious 17-year-old with no finance/crypto/CS background must understand
 * `def` on its own. Use an everyday analogy where it helps. `related` ids must exist (the test
 * page checks). Inline markup allowed in def/project: **bold**, *italic*, `code`.
 *
 *   OBZ.glossary.get(id)       entry or null      OBZ.glossary.has(id)
 *   OBZ.glossary.all()         [{id, ...entry}] sorted A–Z
 *   OBZ.glossary.search(q)     entries matching term, alias or definition text
 *   OBZ.glossary.resolve(text) id for a term or alias ("Bids" -> "bid"), or null
 */
(function (OBZ) {
  "use strict";

  const E = {
    // ---------------------------------------------------------------- 1. markets
    market: {
      term: "Market", chapter: 1,
      def: "Any place, physical or online, where buyers and sellers meet to trade something. A farmers' market, a concert-ticket resale site and a stock exchange are all markets.",
      related: ["exchange", "buyer", "seller", "price"],
    },
    exchange: {
      term: "Exchange", aliases: ["venue", "trading venue"], chapter: 1,
      def: "A business or a program that runs a market: it collects orders, decides who trades with whom, and records every trade. In this course the word **venue** means the same thing.",
      project: "We compare three venues: Phoenix (on Solana), Kraken and Coinbase (both companies).",
      related: ["market", "matching-engine", "cex", "dex"],
    },
    buyer: {
      term: "Buyer", chapter: 1,
      def: "Someone who wants to get the thing being traded and pays money for it. In this course a buyer usually wants SOL and pays US dollars.",
      related: ["seller", "bid"],
    },
    seller: {
      term: "Seller", chapter: 1,
      def: "Someone who gives up the thing being traded in exchange for money. Here a seller hands over SOL and receives dollars.",
      related: ["buyer", "ask"],
    },
    price: {
      term: "Price", chapter: 1,
      def: "How much money one unit of something costs. In this course: how many US dollars one SOL costs (about $104 on 18 October 2026).",
      related: ["mid-price", "tick"],
    },
    trade: {
      term: "Trade", aliases: ["execution"], chapter: 1,
      def: "The moment a buyer and a seller agree: the item changes hands at one price. Exchanges also call this an execution or a fill.",
      related: ["fill", "order"],
    },
    order: {
      term: "Order", chapter: 1,
      def: "An instruction you give an exchange, like \"buy 5 SOL, paying at most $104 each.\" It says which side you are on, how much, and (usually) your worst acceptable price.",
      related: ["limit-order", "market-order", "side", "order-id"],
    },
    side: {
      term: "Side", chapter: 1,
      def: "Whether an order buys or sells. Buy orders are called bids and sell orders are called asks.",
      related: ["bid", "ask"],
    },
    bid: {
      term: "Bid", aliases: ["bids", "buy order"], chapter: 1,
      def: "An offer to **buy**: \"I'll pay up to $103.94 for one SOL.\" Bids are the buyers' orders. In this course bids are always green and marked ▲ BID.",
      related: ["ask", "best-bid", "buyer", "order-book"],
    },
    ask: {
      term: "Ask", aliases: ["asks", "offer", "sell order"], chapter: 1,
      def: "An offer to **sell**: \"I'll sell one SOL for at least $103.95.\" Asks are the sellers' orders, also called offers. In this course asks are always red and marked ▼ ASK.",
      related: ["bid", "best-ask", "seller", "order-book"],
    },
    quote: {
      term: "Quote", aliases: ["quotes"], chapter: 1,
      def: "A price someone is willing to trade at, posted to the market as a bid or an ask. \"Quoting\" means keeping such orders in the book.",
      related: ["bid", "ask", "market-maker"],
    },
    "trading-pair": {
      term: "Trading pair", aliases: ["pair", "base asset", "quote asset"], chapter: 1,
      def: "The two things a market swaps, written like SOL/USDC: you trade the first (the **base**, SOL) and prices are measured in the second (the **quote**, USDC). \"104 SOL/USDC\" means one SOL costs 104 USDC.",
      related: ["sol", "usdc"],
    },
    sol: {
      term: "SOL", chapter: 1,
      def: "The native currency of the Solana blockchain. In this course it is the thing being bought and sold; one SOL cost about $104 on 18 October 2026.",
      related: ["solana", "token", "lamport"],
    },
    usdc: {
      term: "USDC", chapter: 1,
      def: "A stablecoin: a token designed to always be worth one US dollar, so on a blockchain it works like digital dollars.",
      project: "Phoenix trades SOL/USDC; Kraken and Coinbase trade SOL/USD with real dollars. We treat 1 USDC as $1.",
      related: ["stablecoin", "token", "trading-pair"],
    },
    stablecoin: {
      term: "Stablecoin", chapter: 1,
      def: "A token whose value is pinned to something stable, usually one US dollar, typically by keeping real dollars or bonds in reserve.",
      related: ["usdc", "token"],
    },
    token: {
      term: "Token", aliases: ["tokens"], chapter: 1,
      def: "A unit of digital money or a digital asset recorded on a blockchain, like SOL or USDC. Owning a token means the blockchain's records say it is yours.",
      related: ["blockchain", "sol", "usdc"],
    },
    notional: {
      term: "Notional", aliases: ["notional value"], chapter: 5,
      def: "The dollar value of an order or trade: price × size. Ten SOL at $104 has a notional of $1,040. We size test trades by notional ($1K, $10K, $100K, $1M) so venues are compared fairly.",
      related: ["price-impact", "size"],
    },
    percent: {
      term: "Percent", aliases: ["%"], chapter: 2,
      def: "Parts per hundred. 1% of $104 is $1.04. For tiny trading costs we use basis points instead: 1% = 100 bps.",
      related: ["basis-point"],
    },
    "basis-point": {
      term: "Basis point", aliases: ["bps", "basis points", "bp"], chapter: 2,
      def: "One hundredth of a percent: 1 bps = 0.01%, and 100 bps = 1%. Trading costs are tiny, so \"2 bps\" is easier to say than \"0.02%\". To turn a fraction into bps, multiply by 10,000.",
      project: "Spread, price impact and fees are all reported in bps, so SOL at $104 and BTC at $100,000 can be compared directly.",
      related: ["percent", "spread", "price-impact"],
    },
    "reservation-price": {
      term: "Reservation price", aliases: ["walk-away price", "maximum price", "minimum price", "willingness to pay"], chapter: 1,
      def: "The most a buyer would pay, or the least a seller would accept, before walking away. If your friend would pay at most $90 for your concert ticket, $90 is his reservation price. A trade is possible only when the buyer's is at or above the seller's.",
      related: ["buyer", "seller", "bid", "ask"],
    },
    "price-discovery": {
      term: "Price discovery", chapter: 1,
      def: "How a market finds a price: buyers and sellers post bids and asks, trade, and adjust, until the price settles where they meet. Nobody announces the price; it is wherever the latest trades happen.",
      related: ["price", "bid", "ask", "order-book"],
    },

    // ---------------------------------------------------------------- 2. the order book
    "order-book": {
      term: "Order book", aliases: ["book", "limit order book", "LOB", "order books"], chapter: 2,
      def: "The list of every order waiting to trade on one market: buyers' bids on one side, sellers' asks on the other, each sorted best price first. Think of a notice board covered in \"will buy at…\" and \"will sell at…\" cards, tidied so the most generous cards are on top.",
      project: "orderbook.py keeps the book; this page runs a JavaScript port of the same engine.",
      related: ["bid", "ask", "ladder", "price-level", "matching-engine"],
    },
    ladder: {
      term: "Ladder", aliases: ["price ladder", "DOM", "depth of market"], chapter: 2,
      def: "A way of drawing an order book as one column of prices: asks stacked above, bids below, so the best prices meet in the middle with the spread between them. Each row is one price level.",
      related: ["order-book", "price-level", "spread"],
    },
    "price-level": {
      term: "Price level", aliases: ["level", "levels", "price levels"], chapter: 2,
      def: "All the orders resting at exactly one price. One row of a ladder is one price level; its size is the total of every order at that price.",
      project: "Each level is a PriceLevel: a queue of orders kept as a doubly linked list.",
      related: ["ladder", "order-book", "fifo", "doubly-linked-list"],
    },
    "best-bid": {
      term: "Best bid", aliases: ["highest bid"], chapter: 2,
      def: "The highest price any buyer is offering right now. If you want to sell immediately, that is the best price you can get.",
      related: ["bid", "best-ask", "spread", "top-of-book"],
    },
    "best-ask": {
      term: "Best ask", aliases: ["lowest ask", "best offer"], chapter: 2,
      def: "The lowest price any seller is asking right now. If you want to buy immediately, that is the cheapest you can pay.",
      related: ["ask", "best-bid", "spread", "top-of-book"],
    },
    "top-of-book": {
      term: "Top of book", aliases: ["BBO", "best bid and offer"], chapter: 2,
      def: "The best bid and the best ask together: the two prices closest to each other, where the next trade will most likely happen.",
      related: ["best-bid", "best-ask", "spread"],
    },
    spread: {
      term: "Spread", aliases: ["bid-ask spread"], chapter: 2,
      def: "The gap between the best ask and the best bid. It is like a used-games shop that buys your game for $20 and sells it for $25: the $5 gap is the shop's spread. A small spread means buyers and sellers nearly agree.",
      project: "On 18 Oct 2026, 04:31 UTC: Kraken's spread was about 1 bps, Phoenix's about 58 bps.",
      related: ["best-bid", "best-ask", "mid-price", "basis-point", "half-spread"],
    },
    "mid-price": {
      term: "Mid price", aliases: ["mid", "midpoint", "mid-market price"], chapter: 2,
      def: "Halfway between the best bid and the best ask: (best bid + best ask) ÷ 2. It is the usual stand-in for \"the price right now\", even though nobody may be willing to trade exactly there.",
      related: ["spread", "best-bid", "best-ask", "reference-mid"],
    },
    depth: {
      term: "Depth", aliases: ["market depth", "deep", "thin"], chapter: 2,
      def: "How much is available to trade at each price, or in total within some distance of the mid. A **deep** book can absorb a big order without the price moving much; a **thin** one can't.",
      project: "We measure depth as dollars resting within 0.5%, 1% and 2% of the mid.",
      related: ["liquidity", "depth-chart", "price-impact"],
    },
    "depth-chart": {
      term: "Depth chart", chapter: 2,
      def: "A chart that starts at the mid and adds up all the size available as you move outward in price: bids to the left, asks to the right. Steep walls mean lots of liquidity close to the price.",
      related: ["depth", "liquidity"],
    },
    liquidity: {
      term: "Liquidity", aliases: ["liquid", "illiquid"], chapter: 2,
      def: "How easily you can trade a lot without moving the price much. Selling a popular phone is easy (liquid); selling a rare painting quickly means accepting a worse price (illiquid). In an order book, liquidity is the size resting near the mid.",
      related: ["depth", "spread", "market-maker", "price-impact"],
    },
    size: {
      term: "Size", aliases: ["quantity", "amount"], chapter: 2,
      def: "How much of the asset an order or level holds, in SOL here. A level's size is the total of all orders at that price.",
      related: ["notional", "lot"],
    },
    "resting-order": {
      term: "Resting order", aliases: ["rests", "resting", "resting orders"], chapter: 3,
      def: "A limit order that didn't trade straight away and now sits (rests) in the book, waiting for someone to trade with it. Every order you see in a ladder is resting.",
      related: ["limit-order", "maker", "order-book"],
    },

    // ---------------------------------------------------------------- 3. orders
    "limit-order": {
      term: "Limit order", aliases: ["limit orders", "limit price"], chapter: 3,
      def: "\"Buy 5 SOL at $103.90 or better.\" It only trades at your price or better. Whatever can't trade right away rests in the book until someone takes it or you cancel.",
      related: ["market-order", "resting-order", "maker", "crossing-the-spread"],
    },
    "market-order": {
      term: "Market order", aliases: ["market orders"], chapter: 3,
      def: "\"Buy 5 SOL now, at whatever prices are available.\" It trades immediately against the best resting orders, moving to worse prices if it must, and never rests in the book.",
      project: "In orderbook.py, market_order() can take an optional limit price as price protection.",
      related: ["limit-order", "taker", "price-impact", "price-protection"],
    },
    maker: {
      term: "Maker", aliases: ["makers", "liquidity maker"], chapter: 3,
      def: "The trader whose order was already resting in the book when a trade happened. Makers \"make\" the market by offering prices others can trade against. Every trade happens at the maker's price.",
      related: ["taker", "resting-order", "market-maker", "maker-fee"],
    },
    taker: {
      term: "Taker", aliases: ["takers", "liquidity taker"], chapter: 3,
      def: "The trader whose incoming order trades with resting orders right away, \"taking\" liquidity out of the book. Takers get speed and certainty and usually pay a higher fee than makers.",
      related: ["maker", "market-order", "taker-fee"],
    },
    fill: {
      term: "Fill", aliases: ["fills", "filled"], chapter: 3,
      def: "One trade between one taker and one maker: an amount at a price. A big order can produce many fills, one per resting order it trades with.",
      project: "The engine returns a list of Fill(maker_order_id, price_ticks, size_lots).",
      related: ["partial-fill", "trade", "average-fill-price"],
    },
    "partial-fill": {
      term: "Partial fill", aliases: ["partially filled", "partial fills"], chapter: 3,
      def: "When only part of an order trades. A resting order that is partly filled keeps its place in the queue with its smaller remaining size; the unfilled part of a market order is simply dropped.",
      related: ["fill", "queue-position", "price-time-priority"],
    },
    "crossing-the-spread": {
      term: "Crossing the spread", aliases: ["crosses the spread", "cross", "crossing"], chapter: 3,
      def: "When a buy order's price is at or above the best ask (or a sell's is at or below the best bid). Such an order can trade immediately, so it acts as a taker first and only rests whatever is left.",
      related: ["limit-order", "taker", "crossed-book"],
    },
    "crossed-book": {
      term: "Crossed book", chapter: 3,
      def: "An impossible state where the best bid is at or above the best ask. A real matching engine never lets it happen: the orders that would cross trade instead.",
      project: "snapshot.validate() rejects any crossed snapshot, because loading one would produce fake trades.",
      related: ["crossing-the-spread", "spread"],
    },
    cancel: {
      term: "Cancel", aliases: ["cancels", "cancelled", "cancellation"], chapter: 3,
      def: "Taking your resting order out of the book before anyone trades with it.",
      project: "cancel_order(id) returns False for an unknown id instead of crashing: the order may have just been filled.",
      related: ["order-id", "race-condition", "idempotent", "hash-map"],
    },
    "order-id": {
      term: "Order ID", aliases: ["order id", "id"], chapter: 3,
      def: "A unique number the exchange gives each order, like a receipt number, so it can find the order later to cancel it or report whose order traded.",
      related: ["cancel", "hash-map"],
    },
    ioc: {
      term: "IOC (immediate-or-cancel)", aliases: ["immediate-or-cancel", "IOC"], chapter: 3,
      def: "An order that trades whatever it can right now, up to a price limit, and cancels the rest. It never rests in the book.",
      project: "A market order with a limit price behaves exactly like an IOC; every impact measurement in this project uses one.",
      related: ["market-order", "limit-order", "price-protection"],
    },
    "market-maker": {
      term: "Market maker", aliases: ["market makers", "market making"], chapter: 3,
      def: "A trader, usually a firm running software, that keeps both bids and asks in the book all day. It earns the spread when others trade with it, and takes the risk of the price moving against it.",
      related: ["maker", "liquidity", "spread", "prop-amm"],
    },
    "time-in-force": {
      term: "Time in force", aliases: ["TIF"], chapter: 3,
      def: "The part of a limit order that says what happens to whatever can't trade straight away: keep it waiting in the book (GTC) or cancel it at once (IOC).",
      project: "orderbook.py's add_order takes tif=TimeInForce.GTC (the default) or TimeInForce.IOC.",
      related: ["gtc", "ioc", "limit-order"],
    },
    gtc: {
      term: "GTC (good-til-cancelled)", aliases: ["good-til-cancelled", "good-till-cancelled", "GTC"], chapter: 3,
      def: "The usual kind of limit order: whatever doesn't trade at once rests in the book at your price until someone trades with it or you cancel it. The resting part makes you a maker.",
      related: ["time-in-force", "ioc", "resting-order", "maker"],
    },

    // ---------------------------------------------------------------- 4. priority
    "price-time-priority": {
      term: "Price-time priority", aliases: ["price/time priority", "time priority"], chapter: 4,
      def: "The rule for who trades first. Better price first; at the same price, whoever arrived first. Like a ticket queue where anyone offering more money jumps to the front, but equal offers wait in arrival order.",
      related: ["fifo", "queue-position", "matching-engine"],
    },
    fifo: {
      term: "FIFO", aliases: ["first in, first out", "first-in-first-out"], chapter: 4,
      def: "First in, first out: the oldest item leaves first, like a lunch line. Each price level in the book is a FIFO queue.",
      related: ["price-time-priority", "queue-position", "linked-list"],
    },
    "queue-position": {
      term: "Queue position", aliases: ["place in line", "queue"], chapter: 4,
      def: "Where your order stands in line at its price. Position 1 trades next. New orders join at the back; a partial fill does not lose its place.",
      related: ["fifo", "price-time-priority", "partial-fill"],
    },
    "matching-engine": {
      term: "Matching engine", aliases: ["engine"], chapter: 4,
      def: "The program at the heart of an exchange. It takes in orders one at a time, decides who trades with whom using price-time priority, and updates the book.",
      project: "orderbook.py in Python, and engine.js on this page, which reproduces the Python engine's fills exactly.",
      related: ["matching-loop", "order-book", "price-time-priority", "determinism"],
    },
    "matching-loop": {
      term: "Matching loop", chapter: 4,
      def: "The core of the matching engine: take the best opposite order, trade as much as possible, remove it if it is used up, and repeat until the incoming order is done or prices get too bad.",
      project: "OrderBook._match() in orderbook.py, shared by limit and market orders.",
      related: ["matching-engine", "walking-the-book", "fill"],
    },
    "pro-rata": {
      term: "Pro-rata matching", aliases: ["pro rata"], chapter: 4,
      def: "An alternative to time priority: an incoming order is shared among all the resting orders at a price in proportion to their size, so an order twice as big gets twice the fill no matter when it arrived. Some futures exchanges use it.",
      related: ["price-time-priority", "fifo", "price-level"],
    },

    // ---------------------------------------------------------------- 5. impact
    "price-impact": {
      term: "Price impact", aliases: ["impact", "market impact"], chapter: 5,
      def: "How much worse your average price was than the mid before you traded, in bps. A big order uses up the best prices and pays more for the rest. For a buy: (average fill − mid) ÷ mid × 10,000.",
      project: "impact.py simulates real market orders on real snapshots to measure this at $1K, $10K, $100K and $1M.",
      related: ["average-fill-price", "walking-the-book", "slippage", "depth", "basis-point"],
    },
    "average-fill-price": {
      term: "Average fill price", aliases: ["average fill", "avg fill", "average price"], chapter: 5,
      def: "Total dollars paid ÷ total SOL received, across all the fills of one order. Fills that traded more SOL count for more (a size-weighted average).",
      related: ["fill", "price-impact"],
    },
    slippage: {
      term: "Slippage", chapter: 5,
      def: "The difference between the price you expected and the price you actually got. People often use it loosely to mean price impact.",
      related: ["price-impact", "price-protection"],
    },
    "walking-the-book": {
      term: "Walking the book", aliases: ["walks the book", "sweep", "sweeping"], chapter: 5,
      def: "What a large order does when it uses up the best price level and has to keep trading at worse and worse levels, like a shopper who empties the cheap shelf and moves on to the pricier one.",
      related: ["price-impact", "matching-loop", "depth"],
    },
    "half-spread": {
      term: "Half-spread", chapter: 5,
      def: "Half the gap between best bid and best ask: the distance from the mid to either side. Even the tiniest market order pays it, because it trades at the best ask (or bid), not at the mid.",
      related: ["spread", "mid-price", "price-impact"],
    },
    "impact-curve": {
      term: "Impact curve", chapter: 5,
      def: "A chart of price impact (up) against trade size (across, usually on a log scale). Spread decides where it starts; depth decides how steeply it climbs.",
      related: ["price-impact", "log-scale"],
    },
    "log-scale": {
      term: "Log scale", aliases: ["logarithmic scale", "log axis"], chapter: 5,
      def: "An axis where each step multiplies instead of adds: $1K, $10K, $100K, $1M are evenly spaced. It lets one chart show both small and huge trades clearly.",
      related: ["impact-curve"],
    },
    "price-protection": {
      term: "Price protection", aliases: ["protection band", "slippage limit"], chapter: 11,
      def: "A limit on how far from the mid a taker order may trade. It stops a big order from filling against absurd prices when the book runs thin.",
      project: "Every simulated order uses a 10% band: it will not trade more than 10% away from the mid.",
      related: ["junk-quote", "ioc", "market-order"],
    },
    "reference-mid": {
      term: "Reference mid", chapter: 11,
      def: "A shared \"fair price\" used to compare venues that disagree slightly: here, the average of the Kraken and Coinbase mids at the same moment.",
      project: "AMM routes have no mid of their own, so they can only be compared on the reference mid.",
      related: ["mid-price", "price-impact"],
    },

    // ---------------------------------------------------------------- 6. data structures
    "data-structure": {
      term: "Data structure", aliases: ["data structures"], chapter: 6,
      def: "A way of arranging data in memory so that certain operations are fast. Picking the right ones is most of the work of designing a matching engine.",
      related: ["array", "hash-map", "linked-list", "sorted-map", "big-o"],
    },
    array: {
      term: "Array", aliases: ["list", "arrays"], chapter: 6,
      def: "Items stored side by side and numbered 0, 1, 2… Reading item number n is instant, but inserting into the middle means shifting everything after it, like squeezing into a full row of seats.",
      related: ["index", "linked-list", "data-structure"],
    },
    index: {
      term: "Index", aliases: ["indices", "indexes"], chapter: 6,
      def: "An item's position number in an array. Programs often store an index instead of a memory address to point at another item.",
      related: ["array", "pointer"],
    },
    "sorted-map": {
      term: "Sorted map", aliases: ["sorted dict", "SortedDict", "ordered map"], chapter: 6,
      def: "A collection of key → value pairs kept in key order, such as price → level. Finding, adding and removing a key take O(log n) steps, and the smallest or largest key (the best price) is always at hand.",
      project: "orderbook.py uses SortedDict from sortedcontainers; Phoenix uses a red-black tree.",
      related: ["hash-map", "red-black-tree", "o-log-n", "price-level"],
    },
    "hash-map": {
      term: "Hash map", aliases: ["hash table", "dict", "dictionary", "map"], chapter: 6,
      def: "A key → value lookup with near-instant find, insert and delete (O(1) on average) but no ordering. Like a coat check: hand over ticket 57 and get coat 57 back without searching the racks.",
      project: "The engine keeps order_id → order node in a dict, so a cancel finds its order in O(1).",
      related: ["sorted-map", "o-1", "order-id", "cancel"],
    },
    "linked-list": {
      term: "Linked list", aliases: ["linked lists"], chapter: 6,
      def: "A chain of items where each item holds a pointer to the next one, like a scavenger hunt where each clue tells you where the next is. Adding at the end is instant, but reaching the 100th item takes 100 steps.",
      related: ["doubly-linked-list", "node", "pointer", "array"],
    },
    "doubly-linked-list": {
      term: "Doubly linked list", aliases: ["doubly-linked list"], chapter: 6,
      def: "A linked list where every item also points back to the one before it. Because an item knows both neighbours, it can be unlinked from the middle in O(1): just connect the neighbours to each other.",
      project: "Each PriceLevel is a doubly linked list of orders, oldest at the head.",
      related: ["linked-list", "fifo", "price-level", "o-1"],
    },
    node: {
      term: "Node", aliases: ["nodes"], chapter: 6,
      def: "One item in a linked list or a tree: the data itself plus the pointers to its neighbours or children.",
      related: ["linked-list", "tree", "pointer"],
    },
    pointer: {
      term: "Pointer", aliases: ["pointers", "reference"], chapter: 6,
      def: "A value that says where another piece of data lives: a memory address, a reference in Python or JavaScript, or an index into an array.",
      project: "Phoenix's trees use 4-byte array indices as pointers, because a Solana account can't hold memory addresses.",
      related: ["node", "index", "linked-list"],
    },
    "big-o": {
      term: "Big-O", aliases: ["big O", "big-O notation", "complexity", "time complexity"], chapter: 6,
      def: "A shorthand for how the work an operation does grows as the data grows, ignoring constant factors. O(1) stays the same, O(log n) grows very slowly, O(n) grows in proportion to the data.",
      related: ["o-1", "o-log-n", "o-n"],
    },
    "o-1": {
      term: "O(1)", aliases: ["constant time"], chapter: 6,
      def: "Constant time: the operation takes the same number of steps whether there are 10 items or 10 million. Looking up a coat-check ticket is O(1).",
      related: ["big-o", "hash-map", "doubly-linked-list"],
    },
    "o-log-n": {
      term: "O(log n)", aliases: ["logarithmic time"], chapter: 6,
      def: "Logarithmic time: each step halves the remaining work, so a million items take only about 20 steps. Guessing a number between 1 and 1,000,000 with \"higher or lower\" hints is O(log n).",
      related: ["big-o", "binary-search", "sorted-map", "red-black-tree"],
    },
    "o-n": {
      term: "O(n)", aliases: ["linear time"], chapter: 6,
      def: "Linear time: the work grows in step with the data. Checking every item in a list one by one is O(n).",
      related: ["big-o", "array"],
    },
    "binary-search": {
      term: "Binary search", chapter: 6,
      def: "Finding an item in a sorted list by checking the middle, throwing away the half it can't be in, and repeating. It takes O(log n) steps.",
      related: ["o-log-n", "binary-search-tree"],
    },
    tree: {
      term: "Tree", aliases: ["trees"], chapter: 6,
      def: "A structure of nodes that starts from one root, where each node can have children, like a family tree drawn upside down.",
      related: ["node", "binary-search-tree", "red-black-tree"],
    },
    "binary-search-tree": {
      term: "Binary search tree", aliases: ["BST"], chapter: 6,
      def: "A tree where each node has at most two children: smaller keys go left, larger keys go right. Finding a key means turning left or right at each node, about log n turns if the tree is balanced.",
      related: ["tree", "red-black-tree", "binary-search", "o-log-n"],
    },
    "red-black-tree": {
      term: "Red-black tree", aliases: ["red black tree", "balanced tree", "self-balancing tree"], chapter: 9,
      def: "A binary search tree that keeps itself balanced: each node is coloured red or black, and a few simple rules stop any branch from getting too long, so find, insert and delete always stay O(log n).",
      project: "Phoenix stores each side of its book as a red-black tree inside a fixed array of 64-byte nodes.",
      related: ["binary-search-tree", "sorted-map", "free-list", "o-log-n"],
    },
    heap: {
      term: "Heap", aliases: ["priority queue"], chapter: 6,
      def: "A tree-shaped structure that always keeps the smallest (or largest) item on top, cheap to add to and to pop the top from. It can't quickly find or remove an item from the middle, which is why order books use sorted maps instead.",
      related: ["sorted-map", "tree"],
    },
    nanosecond: {
      term: "Nanosecond", aliases: ["ns", "nanoseconds"], chapter: 6,
      def: "A billionth of a second (0.000000001 s). Light travels about 30 cm in one nanosecond. A microsecond (µs) is 1,000 nanoseconds.",
      project: "The benchmark times each engine call in nanoseconds: about 600 ns for a cancel, 1,100–1,700 ns for an add, 4,000 ns for a market order, in pure Python.",
      related: ["big-o", "latency", "throughput"],
    },

    // ---------------------------------------------------------------- 7. integers
    determinism: {
      term: "Determinism", aliases: ["deterministic"], chapter: 7,
      def: "Same inputs, exactly the same outputs, every time and on every computer. A blockchain needs it because thousands of validators must all compute the identical result for every trade.",
      related: ["validator", "floating-point", "integer", "matching-engine"],
    },
    "floating-point": {
      term: "Floating point", aliases: ["float", "floats", "floating-point number"], chapter: 7,
      def: "The usual way computers store decimals: fast, but approximate. In most languages 0.1 + 0.2 gives 0.30000000000000004. Tiny rounding differences can depend on the order of operations, which is dangerous when many computers must agree.",
      related: ["integer", "determinism", "tick", "lot"],
    },
    integer: {
      term: "Integer", aliases: ["integers", "whole number"], chapter: 7,
      def: "A whole number: …, −1, 0, 1, 2, … Computers do integer arithmetic exactly, which is why exchanges store prices as a whole number of ticks and sizes as a whole number of lots.",
      related: ["floating-point", "tick", "lot", "u64"],
    },
    tick: {
      term: "Tick", aliases: ["ticks"], chapter: 7,
      def: "The smallest price step a market allows, and the whole-number unit prices are stored in. If one tick is $0.001, the price $104.350 is stored as the integer 104,350.",
      project: "Phoenix SOL/USDC: 1 tick = $0.001. Kraken and Coinbase snapshots use 1 tick = $0.000001.",
      related: ["tick-size", "lot", "integer"],
    },
    "tick-size": {
      term: "Tick size", chapter: 7,
      def: "How many dollars one tick is worth. Price in $ = ticks × tick size.",
      project: "Phoenix stores it in its market header as quote atoms per base unit per tick; decoded, it is $0.001 for SOL/USDC.",
      related: ["tick", "lot-size"],
    },
    lot: {
      term: "Lot", aliases: ["lots"], chapter: 7,
      def: "The smallest size step a market allows, and the whole-number unit sizes are stored in. If one lot is 0.001 SOL, an order for 25 SOL is stored as 25,000 lots.",
      project: "Phoenix SOL/USDC: 1 lot = 0.001 SOL.",
      related: ["lot-size", "tick", "integer"],
    },
    "lot-size": {
      term: "Lot size", chapter: 7,
      def: "How much of the asset one lot is. Size in SOL = lots × lot size.",
      related: ["lot", "tick-size"],
    },
    decimals: {
      term: "Decimals", aliases: ["token decimals"], chapter: 7,
      def: "How many digits after the decimal point a token uses. SOL has 9 and USDC has 6, so blockchains store amounts as integers of the smallest unit: 1 SOL is stored as 1,000,000,000.",
      related: ["lamport", "integer", "token"],
    },
    lamport: {
      term: "Lamport", aliases: ["lamports", "atom", "atoms", "base atoms"], chapter: 7,
      def: "The smallest unit of SOL: 0.000000001 SOL (one billionth). Every SOL amount on Solana is stored as a whole number of lamports; the general word for a token's smallest unit is an atom.",
      related: ["sol", "decimals"],
    },
    consensus: {
      term: "Consensus", chapter: 7,
      def: "How the computers running a blockchain agree on one shared history. Each validator re-runs the transactions and checks it got the same result as the others, so a program must give identical answers on every machine.",
      related: ["validator", "determinism", "blockchain"],
    },
    "rounding-error": {
      term: "Rounding error", aliases: ["rounding errors", "float drift"], chapter: 7,
      def: "The tiny difference between a number and the closest value a computer can store, like writing 1/3 as 0.333. Each floating-point step can add one, and they pile up: adding 0.1 ten times gives 0.9999999999999999, not 1.",
      related: ["floating-point", "integer", "determinism"],
    },

    // ---------------------------------------------------------------- 8. solana + bytes
    blockchain: {
      term: "Blockchain", aliases: ["chain"], chapter: 7,
      def: "A shared record of transactions that many independent computers keep identical copies of and agree on, so no single company controls it. Imagine a class notebook where everyone holds a copy and a page is only added when most agree it is correct.",
      related: ["solana", "validator", "transaction", "determinism"],
    },
    solana: {
      term: "Solana", chapter: 8,
      def: "A fast public blockchain that adds a new block about every 0.4 seconds and can run complex programs, such as a full order-book exchange, directly on the chain.",
      related: ["blockchain", "slot", "account", "program", "sol"],
    },
    validator: {
      term: "Validator", aliases: ["validators"], chapter: 7,
      def: "One of the many computers that run a blockchain. Validators execute every transaction and check each other's results, so they must all get identical answers.",
      related: ["blockchain", "determinism", "slot"],
    },
    account: {
      term: "Account (Solana)", aliases: ["accounts", "account"], chapter: 8,
      def: "Solana stores all data in accounts: fixed-size boxes of bytes, each with an address and an owner program that is allowed to change it. Anyone can read any account.",
      project: "Phoenix keeps an entire market (header, bids, asks, trader seats) in one account of about 1.2 MB. We download its bytes and decode them ourselves.",
      related: ["program", "address", "byte", "phoenix"],
    },
    program: {
      term: "Program", aliases: ["programs", "smart contract", "smart contracts"], chapter: 8,
      def: "Code deployed on Solana, often called a smart contract. Programs hold no data themselves; they read and write accounts when a transaction asks them to.",
      related: ["account", "transaction", "solana"],
    },
    address: {
      term: "Address", aliases: ["public key", "pubkey"], chapter: 8,
      def: "The 32-byte name of a Solana account, usually written as a text string like 4DoNfFBf…5pRgg. It works like a street address for data.",
      project: "Phoenix SOL/USDC market: 4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg.",
      related: ["account"],
    },
    slot: {
      term: "Slot", aliases: ["slots"], chapter: 8,
      def: "Solana's clock tick: a window of about 400 milliseconds in which one validator may add a block. Slot numbers only go up, so a slot number pins a snapshot to a moment.",
      project: "Our Phoenix snapshot is from slot 458,302,883.",
      related: ["solana", "validator", "snapshot"],
    },
    transaction: {
      term: "Transaction", aliases: ["transactions"], chapter: 8,
      def: "A signed bundle of instructions sent to a blockchain, such as \"place this order on Phoenix\". It either happens completely or not at all.",
      related: ["program", "account", "blockchain"],
    },
    rpc: {
      term: "RPC", aliases: ["RPC node", "JSON-RPC", "remote procedure call"], chapter: 8,
      def: "Remote procedure call: asking another computer to run a function for you over the internet. Apps read a blockchain by sending RPC requests to a node.",
      project: "phoenix.py calls getAccountInfo, which returns the market account's bytes (base64-encoded) and the slot.",
      related: ["account", "api", "latency"],
    },
    "on-chain": {
      term: "On-chain", chapter: 8,
      def: "Happening on the blockchain itself, so every validator runs and checks it and anyone can verify it. Phoenix's matching is on-chain; Kraken's happens on Kraken's own servers (off-chain).",
      related: ["off-chain", "phoenix", "dex"],
    },
    "off-chain": {
      term: "Off-chain", chapter: 8,
      def: "Happening outside the blockchain, on someone's own computers. Faster and cheaper, but you have to trust whoever runs it.",
      related: ["on-chain", "cex"],
    },
    bit: {
      term: "Bit", aliases: ["bits"], chapter: 8,
      def: "The smallest piece of computer data: a single 0 or 1.",
      related: ["byte"],
    },
    byte: {
      term: "Byte", aliases: ["bytes"], chapter: 8,
      def: "Eight bits: a number from 0 to 255. Everything a computer stores (text, images, order books) is ultimately a long row of bytes.",
      related: ["bit", "hex", "offset"],
    },
    hex: {
      term: "Hex", aliases: ["hexadecimal", "base 16"], chapter: 8,
      def: "Writing numbers in base 16 with the digits 0–9 and a–f (a = 10 … f = 15). One byte is always exactly two hex digits, from 00 to ff, which makes hex the standard way to show raw bytes.",
      related: ["byte", "little-endian"],
    },
    "little-endian": {
      term: "Little-endian", aliases: ["little endian", "endianness"], chapter: 8,
      def: "Storing a multi-byte number with its smallest byte first. The number 4,096 (hex 00 00 10 00 written big-first) is stored as 00 10 00 00 … It's like writing a date day-first: same date, opposite order.",
      project: "All of Phoenix's integers are little-endian; the decoder reads them with struct format \"<Q\".",
      related: ["byte", "hex", "u64"],
    },
    u64: {
      term: "u64", aliases: ["uint64"], chapter: 8,
      def: "An unsigned 64-bit integer: a whole number from 0 to about 18 quintillion, stored in 8 bytes. \"Unsigned\" means it can't be negative.",
      related: ["u32", "i32", "integer", "little-endian"],
    },
    u32: {
      term: "u32", aliases: ["uint32"], chapter: 8,
      def: "An unsigned 32-bit integer: a whole number from 0 to about 4.3 billion, stored in 4 bytes.",
      related: ["u64", "i32"],
    },
    i32: {
      term: "i32", aliases: ["int32"], chapter: 9,
      def: "A signed 32-bit integer: 4 bytes holding a whole number between about −2.1 billion and +2.1 billion.",
      project: "Phoenix's tree nodes use i32 array indices as pointers (0 means \"none\").",
      related: ["u32", "pointer"],
    },
    offset: {
      term: "Offset", aliases: ["byte offset"], chapter: 8,
      def: "A position inside a block of bytes, counted from the start (the first byte is offset 0). \"The bids size is a u64 at offset 16\" means bytes 16 to 23.",
      related: ["byte", "header"],
    },
    header: {
      term: "Header", aliases: ["market header"], chapter: 8,
      def: "The first part of a file or account that describes the rest: how big things are and how to read them.",
      project: "Phoenix's market header is the first 576 bytes: tree sizes, token decimals, lot sizes and the tick size.",
      related: ["offset", "account", "padding"],
    },
    padding: {
      term: "Padding", chapter: 8,
      def: "Unused bytes left on purpose, to keep later fields at neat positions or to leave room for future fields.",
      project: "Phoenix has 256 bytes of padding right after its header.",
      related: ["header", "offset"],
    },
    decoding: {
      term: "Decoding", aliases: ["decode", "decoder", "parse", "parsing"], chapter: 8,
      def: "Turning raw bytes back into meaningful values: reading 8 bytes at the right offset as a u64, for example, and knowing it means \"number of bid slots\".",
      project: "phoenix.py is a decoder: no Phoenix SDK, just struct.unpack at the right offsets.",
      related: ["byte", "offset", "little-endian"],
    },
    base64: {
      term: "Base64", chapter: 8,
      def: "A way to write any bytes using only 64 safe text characters (A–Z, a–z, 0–9, + and /), so binary data can travel inside JSON.",
      related: ["byte", "rpc", "json"],
    },

    // ---------------------------------------------------------------- 9. trees in arrays
    "free-list": {
      term: "Free list", aliases: ["free lists"], chapter: 9,
      def: "A linked list of empty slots that can be reused. When an order leaves the book its slot goes onto the free list, and the next new order takes that slot instead of growing the array, like a parking lot reusing spaces.",
      project: "Phoenix's node allocator keeps a bump index (next never-used slot) and a free-list head; the decoder skips freed nodes.",
      related: ["red-black-tree", "array", "linked-list", "index"],
    },

    // ---------------------------------------------------------------- 10. AMMs and venues
    amm: {
      term: "AMM (automated market maker)", aliases: ["AMM", "AMMs", "automated market maker"], chapter: 10,
      def: "A way to trade without an order book: a pool holds two tokens and a formula sets the price. You trade against the pool, not against other people's orders.",
      related: ["liquidity-pool", "constant-product", "xyk", "prop-amm"],
    },
    "liquidity-pool": {
      term: "Liquidity pool", aliases: ["pool", "pools"], chapter: 10,
      def: "A pot of two tokens, such as USDC and SOL, held by a program that anyone can trade against. People who deposit into it (liquidity providers) earn the trading fees.",
      related: ["amm", "liquidity-provider", "constant-product"],
    },
    "liquidity-provider": {
      term: "Liquidity provider", aliases: ["LP", "LPs"], chapter: 10,
      def: "Someone who deposits tokens into a liquidity pool so others can trade, earning a share of the fees in return.",
      related: ["liquidity-pool", "amm"],
    },
    "constant-product": {
      term: "Constant product", aliases: ["constant-product AMM", "constant product formula"], chapter: 10,
      def: "The simplest AMM rule: after every trade (ignoring fees), the pool's two balances multiplied together must equal the same number as before. It is written x·y = k.",
      project: "amm.py and amm.js implement it, and build a pool \"as deep as\" a real book for comparison.",
      related: ["xyk", "amm", "spot-price"],
    },
    xyk: {
      term: "x·y = k", aliases: ["x*y=k", "xy=k", "x·y=k"], chapter: 10,
      def: "The constant-product formula: x is the pool's dollars, y its SOL, and k stays fixed. Buying SOL adds dollars (x grows), so the pool's SOL (y) must shrink to keep x·y = k, and each extra SOL costs a bit more than the last.",
      related: ["constant-product", "spot-price", "amm"],
    },
    "spot-price": {
      term: "Spot price", chapter: 10,
      def: "The price for a tiny trade right now. For an x·y = k pool it is x ÷ y: dollars in the pool divided by SOL in the pool.",
      related: ["xyk", "mid-price"],
    },
    "prop-amm": {
      term: "Prop AMM", aliases: ["proprietary AMM", "prop AMMs"], chapter: 10,
      def: "A proprietary AMM: a pool run by one professional market maker, whose program re-prices it from the firm's own model many times a second instead of following a fixed curve. Much of Solana's SOL/USDC volume now flows through prop AMMs.",
      project: "A recorded $100K Jupiter quote routed entirely through prop AMMs (Kipseli, BisonFi, TesseraV).",
      related: ["amm", "solfi", "market-maker", "jupiter"],
    },
    solfi: {
      term: "SolFi", chapter: 10,
      def: "A prop AMM on Solana run by Ellipsis Labs, the team behind Phoenix. It quotes SOL/USDC from its own pricing model rather than from an order book.",
      related: ["prop-amm", "ellipsis-labs", "jupiter"],
    },
    jupiter: {
      term: "Jupiter", chapter: 10,
      def: "Solana's most widely used aggregator. Ask it for a quote and it searches many pools and books, then splits your trade across them for the best overall price.",
      project: "jupiter.py records real Jupiter quotes for $1K–$1M buys and sells, filtered by DEX.",
      related: ["aggregator", "route", "prop-amm"],
    },
    aggregator: {
      term: "Aggregator", aliases: ["DEX aggregator"], chapter: 10,
      def: "A service that checks many venues at once and splits your trade among them to get the best total price, like a flight-search site that compares every airline.",
      related: ["jupiter", "route"],
    },
    route: {
      term: "Route", aliases: ["routes", "routing"], chapter: 10,
      def: "The path a trade takes through one or more pools or venues, as chosen by an aggregator, e.g. 46% through one pool and 54% through another.",
      related: ["aggregator", "jupiter"],
    },
    dex: {
      term: "DEX", aliases: ["decentralized exchange", "DEXs"], chapter: 10,
      def: "A decentralized exchange: it runs as a program on a blockchain, and no company holds your money while you trade. Phoenix is a DEX; so is every AMM.",
      related: ["cex", "phoenix", "amm", "on-chain"],
    },
    cex: {
      term: "CEX", aliases: ["centralized exchange", "CEXs"], chapter: 10,
      def: "A centralized exchange: a company that runs the order book on its own servers and holds its customers' money. Kraken and Coinbase are CEXs.",
      related: ["dex", "kraken", "coinbase", "off-chain"],
    },
    kraken: {
      term: "Kraken", chapter: 1,
      def: "A large centralized crypto exchange based in the US. Its public API publishes the SOL/USD order book.",
      project: "kraken snapshot: 400 levels per side, aggregated by price.",
      related: ["cex", "coinbase", "api"],
    },
    coinbase: {
      term: "Coinbase", chapter: 1,
      def: "The largest US centralized crypto exchange. Coinbase Advanced publishes its full SOL/USD order book through a public API.",
      related: ["cex", "kraken", "api"],
    },
    phoenix: {
      term: "Phoenix", chapter: 8,
      def: "An order-book exchange that runs entirely on Solana, built by Ellipsis Labs. A market's whole book lives in one Solana account, and trades are matched and settled inside the same transaction.",
      project: "We read the SOL/USDC market account directly and decode its bytes with our own code.",
      related: ["ellipsis-labs", "crankless", "account", "dex", "red-black-tree"],
    },
    "ellipsis-labs": {
      term: "Ellipsis Labs", chapter: 13,
      def: "The company that builds Phoenix (the on-chain order book and Phoenix perpetuals) and the SolFi prop AMM.",
      related: ["phoenix", "solfi"],
    },
    crankless: {
      term: "Crankless", aliases: ["crank"], chapter: 8,
      def: "Phoenix finishes (settles) every trade inside the same transaction that matched it. Older Solana order books such as Serum needed a separate \"crank\" transaction afterwards to finish trades.",
      related: ["phoenix", "transaction"],
    },
    "perpetual-futures": {
      term: "Perpetual futures", aliases: ["perps", "perpetuals"], chapter: 13,
      def: "Contracts that let you bet on a price going up or down without owning the asset, and that never expire. Phoenix perpetuals is Ellipsis Labs' newer product.",
      related: ["phoenix", "ellipsis-labs"],
    },

    // ---------------------------------------------------------------- 11. real data
    fee: {
      term: "Fee", aliases: ["fees", "trading fee"], chapter: 11,
      def: "What a venue charges for each trade, usually a small percentage of the notional, quoted in bps.",
      related: ["taker-fee", "maker-fee", "all-in-cost"],
    },
    "taker-fee": {
      term: "Taker fee", aliases: ["taker fees"], chapter: 11,
      def: "The fee charged to the taker of a trade. It is paid on top of any price impact.",
      project: "Phoenix SOL/USDC: 2 bps (read from the market account). Kraken: 40 bps and Coinbase: 120 bps at the lowest volume tier; big traders pay far less.",
      related: ["fee", "maker-fee", "taker", "all-in-cost"],
    },
    "maker-fee": {
      term: "Maker fee", aliases: ["rebate", "maker rebate"], chapter: 11,
      def: "The fee charged to the maker of a trade. It is usually lower than the taker fee, sometimes even negative (a rebate), to reward traders for adding liquidity.",
      related: ["taker-fee", "maker", "fee"],
    },
    "all-in-cost": {
      term: "All-in cost", aliases: ["all-in"], chapter: 11,
      def: "The total cost of a trade: price impact plus fees, both in bps. We always show the two parts separately too, so neither hides the other.",
      related: ["price-impact", "taker-fee"],
    },
    snapshot: {
      term: "Snapshot", aliases: ["snapshots", "book snapshot"], chapter: 11,
      def: "A copy of a whole order book at one instant, like a photo of the notice board. It shows what could have traded at that moment, not what happened after.",
      project: "The built-in snapshots: Phoenix, Kraken and Coinbase, fetched within half a second of each other on 18 Oct 2026 at 04:31 UTC.",
      related: ["order-book", "slot", "time-series"],
    },
    "junk-quote": {
      term: "Junk quote", aliases: ["junk quotes", "stub quote"], chapter: 11,
      def: "An order priced absurdly far from the market, like an ask at $9,999,999,999 or a bid at $0.001. Nobody expects it to trade, but a market order without price protection would happily fill against it.",
      project: "Phoenix's real book had both. They are why every simulated order carries a 10% price-protection band.",
      related: ["price-protection", "order-book"],
    },
    "time-series": {
      term: "Time series", chapter: 11,
      def: "The same measurement taken again and again over time, like a daily temperature log. Here: spread and depth every 5 minutes for 24 hours.",
      related: ["snapshot", "median", "percentile"],
    },
    median: {
      term: "Median", chapter: 11,
      def: "The middle value once everything is sorted: half the measurements are below it and half above. Unlike the average, one crazy value can't drag it far.",
      related: ["percentile", "time-series"],
    },
    percentile: {
      term: "Percentile", aliases: ["p10", "p90", "percentiles"], chapter: 11,
      def: "The value below which a given percentage of measurements fall. The 90th percentile (p90) of spread is the spread that was beaten 90% of the time: a \"bad but not worst\" day.",
      related: ["median", "time-series"],
    },
    twap: {
      term: "TWAP", aliases: ["time-weighted average price", "child order", "parent order"], chapter: 11,
      def: "Time-weighted average price: splitting one big (parent) order into small (child) orders spread evenly over time, so the book has time to refill between them and each child pays less impact.",
      related: ["price-impact", "liquidity"],
    },
    latency: {
      term: "Latency", chapter: 12,
      def: "How long something takes to arrive: for example, the time between asking an exchange for its book and receiving it. Measured in milliseconds (ms).",
      related: ["rpc", "api", "rate-limit"],
    },
    "rate-limit": {
      term: "Rate limit", aliases: ["rate limits", "429"], chapter: 12,
      def: "The most requests a server will accept from you per second or minute. Go over it and you get an error (HTTP 429 \"Too Many Requests\") and must wait.",
      related: ["exponential-backoff", "api"],
    },
    "exponential-backoff": {
      term: "Exponential backoff", aliases: ["backoff", "retry", "retries"], chapter: 12,
      def: "After a failed request, waiting longer before each retry (1 s, 2 s, 4 s…) plus a little randomness, so you don't hammer a server that is already struggling.",
      related: ["rate-limit", "fault-isolation"],
    },
    api: {
      term: "API", aliases: ["APIs", "REST API"], chapter: 11,
      def: "Application programming interface: an agreed way for programs to ask each other for things. Kraken and Coinbase publish public APIs that return their order books as JSON.",
      related: ["json", "rpc", "rate-limit"],
    },
    json: {
      term: "JSON", chapter: 11,
      def: "A simple text format for data, made of lists [ … ] and labelled values { \"price\": 104.35 }. Most web APIs speak it, and the course's data files are JSON.",
      related: ["api"],
    },
    uptime: {
      term: "Uptime", chapter: 12,
      def: "The share of time a system works when you need it. If 287 of 288 fetches in a day succeed, that venue's uptime is 99.7%.",
      related: ["fault-isolation", "collector"],
    },

    // ---------------------------------------------------------------- 12. system design
    pipeline: {
      term: "Pipeline", chapter: 12,
      def: "A chain of steps where each step's output feeds the next, like an assembly line: fetch → store → measure → report.",
      related: ["collector", "database"],
    },
    collector: {
      term: "Collector", chapter: 12,
      def: "The part of this project that wakes up every 5 minutes, fetches every venue at the same moment, and saves the results.",
      project: "collector.py: aligned ticks, concurrent fetches, retries with backoff, resume after a crash.",
      related: ["pipeline", "database", "fault-isolation"],
    },
    database: {
      term: "Database", aliases: ["DB"], chapter: 12,
      def: "An organized store of data that you can search and add to safely, even if the program crashes halfway through a write.",
      related: ["sqlite", "collector"],
    },
    sqlite: {
      term: "SQLite", chapter: 12,
      def: "A complete database stored in one ordinary file, built into Python. No server to run.",
      project: "The 24-hour collector run writes everything into one SQLite file.",
      related: ["database"],
    },
    "fault-isolation": {
      term: "Fault isolation", aliases: ["failure isolation"], chapter: 12,
      def: "Designing a system so one broken part can't take the others down. If Coinbase times out, Kraken and Phoenix are still recorded for that tick.",
      related: ["collector", "uptime", "exponential-backoff"],
    },
    sharding: {
      term: "Sharding", aliases: ["shard", "shards"], chapter: 12,
      def: "Splitting a system into independent pieces that run side by side, such as one matching engine per market. Each shard stays simple and single-threaded inside.",
      related: ["single-threaded", "sequencer", "throughput"],
    },
    sequencer: {
      term: "Sequencer", chapter: 12,
      def: "The part of an exchange that puts all incoming orders into one agreed order (a sequence) before the matching engine sees them, so everyone agrees on who came first.",
      project: "On Solana, the validator producing the current slot effectively sequences the transactions in its block.",
      related: ["determinism", "matching-engine", "sharding"],
    },
    "single-threaded": {
      term: "Single-threaded", aliases: ["thread", "threads"], chapter: 12,
      def: "Doing one thing at a time, strictly in order. Matching engines are usually single-threaded so the result never depends on timing, and replaying the same orders gives the same book.",
      related: ["determinism", "sharding", "sequencer"],
    },
    throughput: {
      term: "Throughput", chapter: 12,
      def: "How much work a system finishes per second, such as orders matched per second.",
      related: ["latency", "sharding"],
    },
    idempotent: {
      term: "Idempotent", aliases: ["idempotence"], chapter: 12,
      def: "Doing it twice has the same effect as doing it once. Pressing a lift button again doesn't call a second lift; cancelling an already-gone order just returns false.",
      related: ["cancel", "race-condition"],
    },
    "race-condition": {
      term: "Race condition", aliases: ["race", "races"], chapter: 12,
      def: "When the outcome depends on which of two things happens first, like a cancel arriving a split second after the order was filled. Good systems handle both orders of events safely.",
      related: ["idempotent", "cancel"],
    },

    // ---------------------------------------------------------------- 13. interview
    "spaced-repetition": {
      term: "Spaced repetition", chapter: 13,
      def: "A study method: review each flashcard just before you would forget it. Cards you know come back later and later; cards you miss come back soon.",
      related: [],
    },
  };

  // ---- lookup helpers ---------------------------------------------------------------
  const ids = Object.keys(E);
  const aliasIndex = new Map();
  const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, " ").replace(/[·*]/g, "·").trim();
  for (const id of ids) {
    aliasIndex.set(norm(id), id);
    aliasIndex.set(norm(E[id].term), id);
    for (const a of E[id].aliases || []) if (!aliasIndex.has(norm(a))) aliasIndex.set(norm(a), id);
  }

  function get(id) { return Object.prototype.hasOwnProperty.call(E, id) ? Object.assign({ id }, E[id]) : null; }
  function has(id) { return Object.prototype.hasOwnProperty.call(E, id); }
  function all() { return ids.map(get).sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" })); }
  function resolve(text) { return aliasIndex.get(norm(text)) || null; }
  function search(q) {
    const s = norm(q || "");
    if (!s) return all();
    const scored = [];
    for (const e of all()) {
      const name = norm(e.term), al = (e.aliases || []).map(norm);
      let score = 0;
      if (name === s || al.includes(s)) score = 100;
      else if (name.startsWith(s) || al.some((a) => a.startsWith(s))) score = 60;
      else if (name.includes(s) || al.some((a) => a.includes(s))) score = 40;
      else if (norm(e.def).includes(s) || (e.project && norm(e.project).includes(s))) score = 10;
      if (score) scored.push([score, e]);
    }
    return scored.sort((a, b) => b[0] - a[0] || a[1].term.localeCompare(b[1].term)).map((x) => x[1]);
  }

  OBZ.glossary = { entries: E, get, has, all, resolve, search };
})(window.OBZ = window.OBZ || {});
