// Message link between sim.html and the table page.
//
// Two transports, used together:
//  - BroadcastChannel: instant, but only between tabs of the same browser.
//  - server.py relay (/sim/events + /sim/send): works across browsers and
//    devices. Silently unavailable when the site is served by a plain static
//    server, in which case BroadcastChannel alone is used.
// Messages arriving over both are de-duplicated.

export function createSimLink(onMessage) {
  const id = Math.random().toString(36).slice(2);
  let counter = 0;
  const seen = new Set();
  let relay = false;

  const handle = (env) => {
    if (!env || env.from === id || seen.has(env.mid)) return;
    seen.add(env.mid);
    if (seen.size > 2000) seen.clear();
    onMessage(env.msg);
  };

  let bc = null;
  try {
    bc = new BroadcastChannel('pokervis-sim');
    bc.onmessage = (e) => handle(e.data);
  } catch { /* very old browser */ }

  try {
    const es = new EventSource('sim/events');
    es.onopen = () => { relay = true; };
    es.onmessage = (e) => {
      try { handle(JSON.parse(e.data)); } catch { /* ignore junk */ }
    };
    es.onerror = () => {
      // never connected → no relay on this server; stop retrying
      if (!relay) es.close();
    };
  } catch { /* EventSource unsupported */ }

  return {
    get relay() { return relay; },
    postMessage(msg) {
      const env = { from: id, mid: `${id}:${counter++}`, msg };
      if (bc) bc.postMessage(env);
      if (relay) {
        fetch('sim/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(env),
        }).catch(() => {});
      }
    },
  };
}
