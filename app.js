import {
  renderCard, renderBack, renderPile, renderAvatar, renderChip, spinCoin, cardLabel, parseCard,
} from './pixel.js';
import { createSimLink } from './sim-link.js';

// ---------------------------------------------------------------------------
// Config — override with URL params, e.g.
//   index.html?pot=<POT_WALLET_ADDRESS>&ws=ws://localhost:8765&rpc=https://...
//   pot     Solana pot wallet address (no pot → demo players/deposits)
//   ws      vision backend WebSocket (no ws → demo card feed)
//   rpc     Solana RPC URL            sim     driven by sim.html instead
//   buyin / sb / bb   defaults for the SETUP dialog (saved settings win)
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const CONFIG = {
  potAddress: params.get('pot') || '',
  rpcUrl: params.get('rpc') || 'https://api.mainnet-beta.solana.com',
  wsUrl: params.get('ws') || '',
  sim: params.has('sim'), // driven by sim.html instead of the camera + Solana
  pollMs: Number(params.get('poll')) || 5000,
  solPerCoin: Number(params.get('coin')) || 0.05,
  buyIn: Number(params.get('buyin')) || 1,
  smallBlind: Number(params.get('sb')) || 0.05,
  bigBlind: Number(params.get('bb')) || 0.1,
  historyLimit: 100, // how many past pot transactions to read on load
  lowConfidence: 0.8,
};
const LAMPORTS = 1_000_000_000;
const EPS = 1e-9;

// Saved settings (from the SETUP dialog) win over URL defaults.
const SETTINGS_KEY = 'pokervis.settings';
const SESSION_KEY = `pokervis.session.${CONFIG.potAddress || 'demo'}`;
function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}
const saved = load(SETTINGS_KEY) || {};
for (const k of ['buyIn', 'smallBlind', 'bigBlind']) if (saved[k] > 0) CONFIG[k] = saved[k];

// Session: when it started (older pot transactions are ignored). Stacks and
// rebuys are rebuilt from the pot's transaction history. Only persisted for a real pot.
let session = (CONFIG.potAddress && load(SESSION_KEY)) || { start: 0 };
const saveSession = () => CONFIG.potAddress && save(SESSION_KEY, session);
const STREETS = { preflop: 'NEW HAND', flop: 'THE FLOP!', turn: 'THE TURN!', river: 'THE RIVER!', showdown: 'SHOWDOWN!' };

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (addr) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;
const fmt = (sol) => sol.toFixed(3);

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
const slots = [...document.querySelectorAll('.slot')].map((el) => ({
  el,
  canvas: el.querySelector('canvas'),
  label: el.querySelector('.label'),
  code: null,
  token: 0,
}));

function clearSlot(s) {
  s.code = null;
  s.token++;
  s.el.className = 'slot empty';
  s.label.textContent = '';
  s.canvas.getContext('2d').clearRect(0, 0, s.canvas.width, s.canvas.height);
}

async function revealSlot(s, code, conf, delay) {
  const token = ++s.token;
  s.code = code;
  await sleep(delay);
  if (token !== s.token) return;

  // 1. AI "scan" lock-on with the card back showing
  renderBack(s.canvas);
  s.el.className = 'slot scanning';
  s.label.textContent = 'SCANNING';
  await sleep(650);
  if (token !== s.token) return;

  // 2. flip: squash to nothing, swap to the face, expand back
  s.el.classList.add('flip-out');
  await sleep(160);
  if (token !== s.token) return;
  renderCard(s.canvas, code);
  s.el.className = 'slot revealed flip-in';

  const pct = conf == null ? '' : ` ${Math.round(conf * 100)}%`;
  const low = conf != null && conf < CONFIG.lowConfidence;
  const p = parseCard(code);
  const text = cardLabel(code);
  s.label.innerHTML = '';
  s.label.append((low ? '?? ' : '') + text.slice(0, -1));
  const suit = document.createElement('i');
  suit.textContent = text.slice(-1);
  s.label.append(suit, pct);
  s.label.dataset.suit = p ? p.suit : '';
  if (low) s.el.classList.add('low');
}

/** cards: [{ code: 'As', conf: 0.97 }, ...] (or plain strings) */
function setBoard(cards) {
  let stagger = 0;
  slots.forEach((s, i) => {
    const c = cards[i];
    if (!c) return s.code && clearSlot(s);
    const code = typeof c === 'string' ? c : c.code;
    const conf = typeof c === 'string' ? null : c.conf;
    if (code !== s.code) {
      revealSlot(s, code, conf, stagger);
      stagger += 300;
    }
  });
}

let bannerTimer;
function banner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.classList.remove('show');
  void b.offsetWidth; // restart animation
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), 1800);
}

let currentStreet = null;
function handleMessage(msg, animate = true) {
  if (msg.type === 'reset') {
    // new hand → move the dealer button (backend may name the dealer wallet explicitly)
    if (msg.dealer && players.has(msg.dealer)) dealerWallet = msg.dealer;
    else rotateDealer();
    lockRoles();
    renderSeats();
    slots.forEach(clearSlot);
    currentStreet = 'preflop';
    $('#street').textContent = 'PRE-FLOP';
    if (animate) banner(STREETS.preflop);
    return;
  }
  if (msg.type === 'board') {
    const street = msg.street || ['preflop', , , 'flop', 'turn', 'river'][msg.cards.length] || 'preflop';
    if (street !== currentStreet) {
      currentStreet = street;
      $('#street').textContent = street.toUpperCase();
      if (STREETS[street] && animate) banner(STREETS[street]);
    }
    setBoard(msg.cards || []);
  }
}

// ---------------------------------------------------------------------------
// Card feed: WebSocket from the vision backend, or demo
// ---------------------------------------------------------------------------
function setStatus(id, state, text) {
  const el = $(id);
  el.dataset.state = state;
  el.querySelector('b').textContent = text;
}

function connectWs() {
  setStatus('#cam-status', 'wait', 'CONNECTING');
  const ws = new WebSocket(CONFIG.wsUrl);
  ws.onopen = () => setStatus('#cam-status', 'live', 'LIVE');
  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch (err) { console.warn('Bad message', e.data, err); }
  };
  ws.onclose = () => {
    setStatus('#cam-status', 'error', 'OFFLINE');
    setTimeout(connectWs, 2000);
  };
}

function shuffledDeck() {
  const deck = [];
  for (const r of 'A23456789TJQK') for (const s of 'shdc') deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

async function demoCards() {
  setStatus('#cam-status', 'demo', 'DEMO');
  while (true) {
    const deck = shuffledDeck().map((code) => ({
      code, conf: Math.random() < 0.12 ? 0.6 + Math.random() * 0.18 : 0.88 + Math.random() * 0.11,
    }));
    handleMessage({ type: 'reset' });
    if (potDemo) potDemo.reset();
    await sleep(6000);
    handleMessage({ type: 'board', street: 'flop', cards: deck.slice(0, 3) });
    await sleep(7000);
    handleMessage({ type: 'board', street: 'turn', cards: deck.slice(0, 4) });
    await sleep(6000);
    handleMessage({ type: 'board', street: 'river', cards: deck.slice(0, 5) });
    await sleep(7000);
  }
}

// ---------------------------------------------------------------------------
// Players — a player is a wallet that has sent SOL to the pot.
// First deposit = takes the next seat (PLAYER 1, PLAYER 2, ...).
// Each player starts with a stack of one buy-in. Bets they send come off it,
// pots they win go on it. Below a big blind they can only go all in; at zero
// they are out until they rebuy by sending SOL again (a fresh buy-in).
// ---------------------------------------------------------------------------
const players = new Map(); // wallet → { wallet, num, bet, win, sent, received, funded, el }

const stackOf = (p) => p.funded - p.sent + p.received;

/** 'ok' | 'short' (all-in only) | 'allin' (shoved this hand) | 'busted' | 'over' (sent more than stack) */
function statusOf(p) {
  const s = stackOf(p);
  if (s < -EPS) return p.bet > 0 ? 'over' : 'busted';
  if (s <= EPS) return p.bet > 0 ? 'allin' : 'busted';
  if (s + EPS < CONFIG.bigBlind) return 'short';
  return 'ok';
}
const isOut = (p) => statusOf(p) === 'busted';

function seatPosition(i, n) {
  // spread evenly around the oval, starting at the bottom centre
  const a = Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
  // radius > 50% so seats sit just outside the rim and never cover the pot
  return { left: 50 + 55 * Math.cos(a), top: 50 + 72 * Math.sin(a) };
}

// ---------------------------------------------------------------------------
// Dealer button + blinds (busted players are skipped)
// ---------------------------------------------------------------------------
let dealerWallet = null;

function rotateDealer() {
  const list = [...players.values()];
  if (!list.length) return;
  const i = list.findIndex((p) => p.wallet === dealerWallet); // -1 → start at first player
  for (let k = 1; k <= list.length; k++) {
    const p = list[(i + k + list.length) % list.length];
    if (!isOut(p)) { dealerWallet = p.wallet; return; }
  }
}

/** Dealer / SB / BB wallets from the current active (not busted) players. */
function computeRoles() {
  const active = [...players.values()].filter((p) => !isOut(p));
  const n = active.length;
  if (n < 2) return null;
  let d = active.findIndex((p) => p.wallet === dealerWallet);
  if (d < 0) {
    rotateDealer();
    d = Math.max(0, active.findIndex((p) => p.wallet === dealerWallet));
  }
  // heads-up: the dealer posts the small blind
  const sb = n === 2 ? d : (d + 1) % n;
  const bb = (sb + 1) % n;
  return { dealer: active[d].wallet, sb: active[sb].wallet, bb: active[bb].wallet };
}

// Roles are locked for the whole hand, so joins and rebuys mid-hand only
// take effect from the next hand.
let handRoles = null;
function lockRoles() { handRoles = computeRoles(); }

/** Seat indexes for dealer / small blind / big blind, or null with < 2 active players. */
function roles() {
  // re-lock if a role holder left or busted (e.g. the payout landed after the new-hand signal)
  const stale = (w) => !players.has(w) || isOut(players.get(w));
  if (!handRoles || [handRoles.dealer, handRoles.sb, handRoles.bb].some(stale)) lockRoles();
  if (!handRoles) return null;
  const list = [...players.values()];
  const idx = (w) => list.findIndex((p) => p.wallet === w);
  return { dealer: idx(handRoles.dealer), sb: idx(handRoles.sb), bb: idx(handRoles.bb), list };
}

const badges = {};
function setupBadges() {
  const defs = { dealer: ['D', '#f4ecd8'], sb: ['SB', '#4cc9f0'], bb: ['BB', '#ff6b6b'] };
  for (const [key, [text, color]] of Object.entries(defs)) {
    const c = document.createElement('canvas');
    c.className = `px badge badge-${key}`;
    renderChip(c, text, color);
    c.hidden = true;
    $('#oval').appendChild(c);
    badges[key] = c;
  }
  updateBlindLabels();
}

function updateBlindLabels() {
  $('#blinds').textContent = `BLINDS ${CONFIG.smallBlind}/${CONFIG.bigBlind} · BUY-IN ${CONFIG.buyIn}`;
  badges.dealer.title = 'Dealer';
  badges.sb.title = `Small blind ${fmt(CONFIG.smallBlind)} SOL`;
  badges.bb.title = `Big blind ${fmt(CONFIG.bigBlind)} SOL`;
}

function placeBadges(r) {
  for (const key of Object.keys(badges)) badges[key].hidden = !r;
  if (!r) return;
  const n = r.list.length;
  const place = (el, i, nudge) => {
    // between the seat and the pot, nudged sideways so D and SB don't stack heads-up
    const a = Math.PI / 2 + (i * 2 * Math.PI) / n + nudge;
    el.style.left = `${50 + 39 * Math.cos(a)}%`;
    el.style.top = `${50 + 38 * Math.sin(a)}%`;
  };
  place(badges.dealer, r.dealer, -0.32);
  place(badges.sb, r.sb, r.sb === r.dealer ? 0.32 : 0);
  place(badges.bb, r.bb, 0);
}

function createSeat(p) {
  const el = document.createElement('div');
  el.className = 'seat joined';
  el.addEventListener('click', () => {
    if (isOut(p)) return;
    dealerWallet = p.wallet;
    lockRoles();
    renderSeats();
  });
  el.innerHTML = `
    <div class="flag" hidden></div>
    <canvas class="px avatar"></canvas>
    <div class="name">PLAYER ${p.num}</div>
    <div class="wallet" title="${p.wallet}">${short(p.wallet)}</div>
    <div class="stack"></div>
    <div class="bet"></div>
    <div class="rebuy" hidden>SEND SOL<br />TO REBUY</div>`;
  renderAvatar(el.querySelector('canvas'), p.wallet);
  el.addEventListener('animationend', () => el.classList.remove('joined'), { once: true });
  $('#seats').appendChild(el);
  return el;
}

const FLAGS = { short: 'ALL IN ONLY', allin: 'ALL IN!', busted: 'OUT', over: 'OVER STACK' };

function renderSeats() {
  const list = [...players.values()];
  const r = roles();
  list.forEach((p, i) => {
    if (!p.el) p.el = createSeat(p);
    const pos = seatPosition(i, list.length);
    p.el.style.left = `${pos.left}%`;
    p.el.style.top = `${pos.top}%`;

    const st = statusOf(p);
    const stack = stackOf(p);
    const blind = !r ? 0 : i === r.bb ? CONFIG.bigBlind : i === r.sb ? CONFIG.smallBlind : 0;
    // a short stack posts whatever it has left
    const toPost = Math.min(blind - p.bet, Math.max(0, stack));
    const owes = blind > 0 && toPost > EPS && !p.win;

    p.el.querySelector('.stack').textContent =
      stack < -EPS ? `OVER ${fmt(-stack)}` : `STACK ${fmt(Math.max(0, stack))}`;
    p.el.querySelector('.stack').classList.toggle('neg', stack < -EPS);

    const bet = p.el.querySelector('.bet');
    if (p.win) bet.textContent = `WIN +${fmt(p.win)}`;
    else if (owes) bet.textContent = `POST ${fmt(toPost)}`;
    else bet.textContent = p.bet > 0 ? `${fmt(p.bet)} SOL` : '—';
    bet.classList.toggle('owes', owes);

    const flag = p.el.querySelector('.flag');
    flag.hidden = !FLAGS[st];
    flag.textContent = FLAGS[st] || '';
    p.el.querySelector('.rebuy').hidden = st !== 'busted';

    for (const s of ['short', 'allin', 'busted', 'over']) p.el.classList.toggle(s, st === s);
    p.el.classList.toggle('in-hand', p.bet > 0);
    p.el.classList.toggle('is-dealer', !!r && i === r.dealer);
    p.el.title = st === 'busted'
      ? `Out: send SOL to the pot from this wallet to rebuy for ${CONFIG.buyIn} SOL`
      : 'Click to make this player the dealer';
  });
  placeBadges(r);
  $('#table-empty').hidden = list.length > 0;
  if (simChannel) queueMicrotask(publishState);
}

function onDeposit(wallet, sol, animate) {
  let p = players.get(wallet);
  let rebought = false;
  if (!p) {
    p = { wallet, num: players.size + 1, bet: 0, win: 0, sent: 0, received: 0, funded: CONFIG.buyIn, el: null };
    players.set(wallet, p);
    if (animate) banner(`PLAYER ${p.num} JOINED!`);
  } else if (isOut(p)) {
    // Rebuy: a busted player sending SOL gets a fresh buy-in, and this
    // deposit is their first bet from it (any debt from over-sending carries over).
    p.funded += CONFIG.buyIn;
    rebought = true;
    if (animate) banner(`PLAYER ${p.num} REBUYS!`);
  }
  p.bet += sol;
  p.sent += sol;
  p.win = 0;
  renderSeats();
  if (animate) {
    if (statusOf(p) === 'allin' && !rebought) banner(`PLAYER ${p.num} ALL IN!`);
    flyCoins(p, 'in', Math.max(1, Math.min(5, Math.round(sol / CONFIG.solPerCoin))));
    bump(p.el);
  }
}

function onPayout(wallet, sol, animate) {
  players.forEach((p) => { p.bet = 0; p.win = 0; });
  const winner = players.get(wallet);
  if (winner) {
    winner.win = animate ? sol : 0; // the "WIN +x" label is only for live payouts, not replays
    winner.received += sol;
    if (animate) {
      banner(`PLAYER ${winner.num} WINS!`);
      flyCoins(winner, 'out', 6);
      winner.el.classList.add('winner');
      setTimeout(() => {
        winner.el.classList.remove('winner');
        winner.win = 0;
        renderSeats();
      }, 5000);
    }
  }
  renderSeats();
}

/** Coins fly from a seat to the pot ('in') or from the pot to a seat ('out'). */
function flyCoins(p, dir, n) {
  const oval = $('#oval');
  const seat = { left: p.el.style.left, top: p.el.style.top };
  const pot = { left: '50%', top: '40%' };
  const [from, to] = dir === 'in' ? [seat, pot] : [pot, seat];
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const c = document.createElement('canvas');
      c.className = 'fly';
      Object.assign(c.style, from);
      const stop = spinCoin(c, 10, 14);
      oval.appendChild(c);
      void c.offsetWidth;
      Object.assign(c.style, to);
      setTimeout(() => { stop(); c.remove(); }, 650);
    }, i * 110);
  }
}

function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

// ---------------------------------------------------------------------------
// Pot total
// ---------------------------------------------------------------------------
let potSol = 0;

function renderPot(sol, animate = false) {
  const grew = sol > potSol + 1e-9;
  potSol = sol;
  $('#pot-amount').textContent = fmt(sol);
  const coins = Math.min(49, Math.ceil(sol / CONFIG.solPerCoin - 1e-9));
  // let flying coins land before the pile grows
  setTimeout(() => renderPile($('#pile'), coins), animate && grew ? 550 : 0);
  if (animate && grew) setTimeout(() => bump($('#pot-amount')), 550);
}

// ---------------------------------------------------------------------------
// Solana: read pot wallet transactions to find who sent what
// ---------------------------------------------------------------------------
async function rpc(method, rpcParams) {
  const res = await fetch(CONFIG.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: rpcParams }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

/** Work out the pot's balance change and the other side of it from a parsed tx. */
function applyTx(tx, animate) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const potIdx = keys.indexOf(CONFIG.potAddress);
  if (potIdx < 0) return;
  const deltas = keys.map((_, j) => (tx.meta.postBalances[j] - tx.meta.preBalances[j]) / LAMPORTS);
  const potDelta = deltas[potIdx];
  const others = keys.map((k, j) => ({ k, d: deltas[j] })).filter((_, j) => j !== potIdx);
  if (potDelta > 0) {
    // sender = the account that lost the most
    const sender = others.reduce((a, b) => (b.d < a.d ? b : a));
    onDeposit(sender.k, potDelta, animate);
  } else if (potDelta < 0) {
    // payout: receiver = the account that gained the most
    const receiver = others.reduce((a, b) => (b.d > a.d ? b : a));
    onPayout(receiver.k, -potDelta, animate);
  }
}

const seenSigs = new Set();

async function syncPot(initial) {
  const sigs = await rpc('getSignaturesForAddress', [
    CONFIG.potAddress, { limit: initial ? CONFIG.historyLimit : 20, commitment: 'confirmed' },
  ]);
  const fresh = sigs.filter((s) => !seenSigs.has(s.signature)).reverse(); // oldest first
  for (const s of fresh) {
    // failed txs, and anything from before "NEW SESSION" was pressed, don't count
    if (s.err || (s.blockTime && s.blockTime * 1000 < session.start)) { seenSigs.add(s.signature); continue; }
    const tx = await rpc('getTransaction', [
      s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    if (!tx) break; // not available yet — retry next poll, keeping order
    seenSigs.add(s.signature);
    if (!tx.meta.err) applyTx(tx, !initial);
  }
  const bal = await rpc('getBalance', [CONFIG.potAddress, { commitment: 'confirmed' }]);
  renderPot(bal.value / LAMPORTS, !initial);
}

async function pollPot() {
  let initial = true;
  while (true) {
    try {
      await syncPot(initial);
      initial = false;
      setStatus('#wallet-status', 'live', 'LIVE');
    } catch (err) {
      console.warn('Pot sync failed', err);
      setStatus('#wallet-status', 'error', 'RPC ERROR');
    }
    await sleep(CONFIG.pollMs);
  }
}

// ---------------------------------------------------------------------------
// Demo pot: fake wallets join and bet
// ---------------------------------------------------------------------------
function fakeWallet() {
  const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from({ length: 44 }, () => b58[Math.floor(Math.random() * b58.length)]).join('');
}

function startPotDemo() {
  setStatus('#wallet-status', 'demo', 'DEMO');
  const pool = Array.from({ length: 6 }, fakeWallet);
  let timer;
  // demo players never bet more than their stack; short stacks shove
  const bet = (wallet, amt) => {
    const p = players.get(wallet);
    if (!p) amt = Math.min(amt, CONFIG.buyIn);
    if (p) {
      const stack = stackOf(p);
      if (stack <= EPS) return;
      if (amt > stack || statusOf(p) === 'short') amt = stack;
    }
    onDeposit(wallet, amt, true);
    renderPot(potSol + amt, true);
  };
  const tick = () => {
    const seated = [...players.values()].filter((p) => statusOf(p) === 'ok' || statusOf(p) === 'short');
    const canJoin = players.size < pool.length;
    const wantNew = canJoin && (seated.length < 2 || Math.random() < 0.3);
    if (wantNew || seated.length) {
      const wallet = wantNew ? pool[players.size] : seated[Math.floor(Math.random() * seated.length)].wallet;
      bet(wallet, [0.05, 0.1, 0.1, 0.25, 0.5][Math.floor(Math.random() * 5)]);
    }
    timer = setTimeout(tick, 2500 + Math.random() * 3500);
  };
  const postBlinds = () => {
    const r = roles();
    if (!r) return tick();
    bet(r.list[r.sb].wallet, CONFIG.smallBlind);
    timer = setTimeout(() => {
      bet(r.list[r.bb].wallet, CONFIG.bigBlind);
      timer = setTimeout(tick, 2500);
    }, 1500);
  };
  timer = setTimeout(tick, 1500);
  return {
    reset() {
      clearTimeout(timer);
      const inHand = [...players.values()].filter((p) => p.bet > 0);
      if (potSol > 0 && inHand.length) {
        const winner = inHand[Math.floor(Math.random() * inHand.length)];
        onPayout(winner.wallet, potSol, true);
        renderPot(0);
      }
      // some busted demo players rebuy by sending SOL, a little after the payout
      setTimeout(() => {
        [...players.values()].filter(isOut).forEach((p) => {
          if (Math.random() < 0.5) {
            onDeposit(p.wallet, CONFIG.bigBlind, true);
            renderPot(potSol + CONFIG.bigBlind, true);
          }
        });
      }, 3500);
      timer = setTimeout(postBlinds, 5000);
    },
    clear() {
      clearTimeout(timer);
      renderPot(0);
      timer = setTimeout(tick, 1500);
    },
  };
}

// ---------------------------------------------------------------------------
// SETUP dialog: buy-in, blinds, new session
// ---------------------------------------------------------------------------
function setupDialog() {
  const dlg = $('#setup');
  const fields = { buyIn: $('#set-buyin'), smallBlind: $('#set-sb'), bigBlind: $('#set-bb') };
  $('#setup-btn').addEventListener('click', () => {
    for (const [k, input] of Object.entries(fields)) input.value = CONFIG[k];
    $('#set-error').textContent = '';
    dlg.showModal();
  });
  $('#set-cancel').addEventListener('click', () => dlg.close());
  $('#setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, Number(input.value)]));
    if (!(v.buyIn > 0 && v.smallBlind > 0 && v.bigBlind > 0)) {
      $('#set-error').textContent = 'ALL VALUES MUST BE ABOVE 0';
      return;
    }
    if (v.bigBlind < v.smallBlind) {
      $('#set-error').textContent = 'BIG BLIND MUST BE ≥ SMALL BLIND';
      return;
    }
    Object.assign(CONFIG, v);
    save(SETTINGS_KEY, v);
    updateBlindLabels();
    renderSeats();
    dlg.close();
  });
  $('#new-session').addEventListener('click', () => {
    if (!confirm('Start a new session? All seats and stacks are cleared, and only pot transactions from now on will count.')) return;
    session = { start: Date.now() };
    saveSession();
    clearTable();
    if (potDemo) potDemo.clear();
    if (simChannel) simChannel.postMessage({ type: 'cleared' });
    banner('NEW SESSION');
    dlg.close();
  });
}

function clearTable() {
  players.forEach((p) => p.el && p.el.remove());
  players.clear();
  dealerWallet = null;
  handRoles = null;
  slots.forEach(clearSlot);
  renderPot(0);
  renderSeats();
}

// ---------------------------------------------------------------------------
// Simulator mode (index.html?sim): sim.html stands in for the ML camera and
// the Solana pot wallet. Messages travel over sim-link.js (same-browser
// BroadcastChannel, plus the server.py relay across browsers/devices).
// ---------------------------------------------------------------------------
let simChannel = null;
const TABLE_ID = Math.random().toString(36).slice(2);

function startSim() {
  setStatus('#cam-status', 'demo', 'SIM');
  setStatus('#wallet-status', 'demo', 'SIM');
  const apply = (m, animate) => {
    if (m.type === 'deposit') {
      onDeposit(m.wallet, m.sol, animate);
      renderPot(m.balance, animate);
    } else if (m.type === 'payout') {
      onPayout(m.wallet, m.sol, animate);
      renderPot(m.balance);
    } else if (m.type === 'reset' || m.type === 'board') {
      handleMessage(m, animate);
    }
  };
  simChannel = createSimLink((m) => {
    if (m.type === 'sync') {
      if (m.to && m.to !== TABLE_ID) return;
      // simulator replays its whole history (like reading the pot's tx history)
      clearTable();
      m.events.forEach((ev) => apply(ev, false));
      if (m.board) handleMessage(m.board, false);
      publishState();
    } else if (m.type === 'clear') {
      clearTable();
      banner('NEW SESSION');
    } else if (m.type === 'hello-sim') {
      // keep-alive answer; the simulator sends a full sync the first time it sees this table id
      simChannel.postMessage({ type: 'here', table: TABLE_ID });
    } else {
      apply(m, true);
    }
  });
}

// A plain table page (no pot wallet / camera configured) switches itself into
// simulator mode as soon as a simulator is open, instead of running the demo.
function watchForSimulator() {
  createSimLink((m) => {
    if (m.type === 'hello-sim') {
      const url = new URL(location.href);
      url.searchParams.set('sim', '1');
      location.replace(url);
    }
  });
}

/** Tell the simulator who is seated, their stacks and the blinds, so it can offer shortcuts. */
function publishState() {
  if (!simChannel) return;
  const r = roles();
  const list = [...players.values()];
  simChannel.postMessage({
    type: 'state',
    config: { buyIn: CONFIG.buyIn, smallBlind: CONFIG.smallBlind, bigBlind: CONFIG.bigBlind },
    pot: potSol,
    players: list.map((p, i) => ({
      wallet: p.wallet, num: p.num, stack: stackOf(p), bet: p.bet, status: statusOf(p),
      role: !r ? '' : i === r.dealer && i === r.sb ? 'D/SB' : i === r.dealer ? 'D' : i === r.sb ? 'SB' : i === r.bb ? 'BB' : '',
    })),
  });
}

// ---------------------------------------------------------------------------
// Pot address
// ---------------------------------------------------------------------------
function setupAddress() {
  const addr = CONFIG.potAddress || 'DEMO1111111111111111111111111111111111111111';
  $('#addr').textContent = addr;
  $('#addr-short').textContent = short(addr);
  $('#copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(addr);
      $('#copy').textContent = 'COPIED!';
    } catch {
      $('#copy').textContent = 'COPY FAILED';
    }
    setTimeout(() => ($('#copy').textContent = 'COPY'), 1400);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
spinCoin($('#logo-coin'), 10, 8);
setupAddress();
setupBadges();
setupDialog();
renderPot(0);
renderSeats();
const potDemo = CONFIG.sim || CONFIG.potAddress ? null : startPotDemo();
if (CONFIG.sim) startSim();
else {
  if (!CONFIG.potAddress && !CONFIG.wsUrl) watchForSimulator();
  if (CONFIG.potAddress) pollPot();
  if (CONFIG.wsUrl) connectWs();
  else demoCards();
}
