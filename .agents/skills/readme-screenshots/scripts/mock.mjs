// Serves dist/ and a fixed snapshot on /api/stream, so the dashboard can be photographed without live data.
// usage: node mock.mjs <dist dir> <state.demo.json> <port>
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const [dist, stateFile, port] = [process.argv[2], process.argv[3], Number(process.argv[4])];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = () => res.write(`data: ${fs.readFileSync(stateFile, "utf8")}\n\n`);
    send(); const t = setInterval(send, 5000); req.on("close", () => clearInterval(t)); return;
  }
  if (url.pathname.startsWith("/api/")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ points: [] })); return; }
  let f = path.join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  if (!fs.existsSync(f)) f = path.join(dist, "index.html");
  res.writeHead(200, { "Content-Type": types[path.extname(f)] ?? "application/octet-stream" }); res.end(fs.readFileSync(f));
}).listen(port, "127.0.0.1");
