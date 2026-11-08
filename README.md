# AutoPoker

A retro, pixel-art table display for live poker. A vision model watches the
physical table and reads the board cards; players bet by sending SOL from
their Solana wallet app to a single pot wallet. The table screen shows the
board, the pot, every player's seat and stack, the dealer button and blinds.

No build step, no dependencies: plain HTML, CSS and JavaScript modules, plus a
small Python server.

## Run it

```bash
py server.py          # or: python3 server.py
```

Then open:

| Page | URL | What it is |
|---|---|---|
| Table | http://localhost:8080/ | The table display (runs a demo until connected) |
| Simulator | http://localhost:8080/sim.html | Stand-in for the vision model and the pot wallet, for testing |

Open the simulator and the table switches itself into simulator mode. The two
pages talk through the server, so they can be in different browsers or on
different devices on your network (for example the table on a TV).

## Connecting the real thing

All settings are URL parameters on the table page:

```
http://localhost:8080/?pot=<POT_WALLET_ADDRESS>&ws=ws://<vision-backend>:8765
```

| Param | Meaning |
|---|---|
| `pot` | Solana pot wallet address. The page reads its transactions to see who sent what. |
| `ws` | WebSocket of the vision backend that sends the board cards. |
| `rpc` | Solana RPC URL (default: public mainnet). Use your own for heavier use. |
| `buyin`, `sb`, `bb` | Default buy-in and blinds. The in-page **SETUP** dialog overrides these. |
| `sim` | Take cards and deposits from `sim.html` instead. |

### Vision backend messages

The backend sends JSON over the WebSocket:

```json
{"type": "board", "street": "flop", "cards": [{"code": "As", "conf": 0.97}, {"code": "Td", "conf": 0.91}, {"code": "7h", "conf": 0.72}]}
{"type": "reset"}
{"type": "reset", "dealer": "<wallet address>"}
```

- Card codes are rank + suit: `A K Q J T 9 … 2` (or `10`) and `s h d c`.
- `conf` is the model's confidence. Below 0.8 the card is flagged as `??`.
- `reset` starts a new hand: it clears the board and moves the dealer button
  (or puts it on the given wallet).

## Game rules on the table

- **Joining:** a wallet's first deposit to the pot gives it the next seat
  (PLAYER 1, 2, …) with a stack of one buy-in, and that deposit is its first bet.
- **Stacks:** bets come off the stack and pots won go back on.
- **All in:** with less than a big blind left, a player can only go all in.
- **Bust and rebuy:** at zero the player is out and skipped for the button and
  blinds. Sending SOL again rebuys them for a fresh buy-in.
- **Dealer and blinds:** they move one seat each hand, and the dealer posts the
  small blind when only two are playing. Click a seat to move the button by hand.
- **New session** (in SETUP) clears all seats. Only pot transactions from then on count.

## Files

| File | What it does |
|---|---|
| `index.html`, `style.css` | Table page |
| `app.js` | Board, players, stacks, blinds, Solana polling, demo and sim modes |
| `pixel.js` | Pixel-art renderers: cards, coins, chips, avatars |
| `sim.html` | Simulator for the vision model and the pot wallet |
| `sim-link.js` | Messaging between the simulator and the table |
| `server.py` | Static server plus the simulator message relay |

> Betting real money is regulated as gambling in most places. Use devnet or
> play money unless you've checked the rules where you are.
