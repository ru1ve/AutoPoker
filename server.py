"""Local dev server for Poker Vis.

Serves the site and relays simulator messages between sim.html and the table
page, so they work across different browsers and devices on your network
(e.g. the table on a TV, the simulator on a laptop).

    py server.py            # http://localhost:8080
    py server.py 9000       # another port

Endpoints:
    GET  /sim/events   Server-Sent Events stream of simulator messages
    POST /sim/send     broadcast one JSON message to every connected page
"""

import json
import queue
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
clients: list[queue.Queue] = []
clients_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # never let the browser run stale JS/CSS while developing
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith("/sim/"):  # keep the relay chatter out of the log
            super().log_message(fmt, *args)

    def do_GET(self):
        if self.path.split("?")[0] == "/sim/events":
            return self.stream_events()
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/sim/send":
            return self.send_error(404)
        length = int(self.headers.get("Content-Length", 0))
        if length > 1_000_000:
            return self.send_error(413)
        body = self.rfile.read(length)
        try:
            json.loads(body)
        except ValueError:
            return self.send_error(400, "body must be JSON")
        with clients_lock:
            for q in clients:
                q.put(body.decode("utf-8"))
        self.send_response(204)
        self.end_headers()

    def stream_events(self):
        q: queue.Queue = queue.Queue()
        with clients_lock:
            clients.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=15)
                    self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")  # keep the connection alive
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with clients_lock:
                clients.remove(q)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("", port), partial(Handler, directory=str(ROOT)))
    server.daemon_threads = True
    print(f"Poker Vis on http://localhost:{port}  (simulator: http://localhost:{port}/sim.html)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
