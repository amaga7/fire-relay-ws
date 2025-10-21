// Relay WebSocket multi-canale (publisher/subscriber) con Express+ws
// Canali: /pub/:camId  (il tuo script Python manda i frame)
//         /sub/:camId  (la dashboard riceve i frame)
// Autenticazione facoltativa via query ?key=... (RELAY_KEY env)

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { parse } from "url";

const PORT = process.env.PORT || 8765;
const RELAY_KEY = "segreto123"; // lascia vuoto se vuoi disattivare l'auth

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Stato in memoria: un “room” per ogni camera
// rooms[camId] = { viewers: Set<WebSocket>, lastFrame: string|null }
const rooms = Object.create(null);

// Pagina minimale di test
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h1>🔥 Fire Relay WS attivo</h1>
    <p>Publisher: <code>wss://HOST/pub/cam1?key=SECRET</code></p>
    <p>Viewer: <code>wss://HOST/sub/cam1?key=SECRET</code></p>
  `);
});

// Healthcheck
app.get("/healthz", (_req, res) => res.send("ok"));

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parse(req.url, true);
  const path = pathname || "/";
  const key = (query?.key || "").toString();

  if (RELAY_KEY && key !== RELAY_KEY) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Accetta solo /pub/:camId o /sub/:camId
  const pubMatch = path.match(/^\/pub\/([A-Za-z0-9_\-\.]+)$/);
  const subMatch = path.match(/^\/sub\/([A-Za-z0-9_\-\.]+)$/);

  if (!pubMatch && !subMatch) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const camId = (pubMatch || subMatch)[1];
    const role = pubMatch ? "publisher" : "viewer";
    handleWS(ws, camId, role);
  });
});

function getRoom(camId) {
  if (!rooms[camId]) rooms[camId] = { viewers: new Set(), lastFrame: null };
  return rooms[camId];
}

function handleWS(ws, camId, role) {
  const room = getRoom(camId);
  ws.isAlive = true;

  ws.on("pong", () => (ws.isAlive = true));

  if (role === "viewer") {
    room.viewers.add(ws);
    // Invia subito l’ultimo frame disponibile (se c’è)
    if (room.lastFrame) {
      safeSend(ws, JSON.stringify({ frame: room.lastFrame }));
    }
  }

  ws.on("message", (msg) => {
    if (role !== "publisher") return;
    // Ci aspettiamo JSON: { frame: "<base64 JPEG>" }
    // Puoi estendere con { meta: {...} } per inviare metadati YOLO
    try {
      const data = JSON.parse(msg.toString());
      if (typeof data.frame === "string") {
        room.lastFrame = data.frame;
        // broadcast ai viewer
        for (const v of room.viewers) {
          if (v.readyState === 1) safeSend(v, JSON.stringify({ frame: data.frame }));
        }
      }
    } catch { /* ignore parse errors */ }
  });

  ws.on("close", () => {
    if (role === "viewer") room.viewers.delete(ws);
  });
}

// Evita crash se il client è lento / backpressure
function safeSend(ws, payload) {
  if (ws.bufferedAmount > 5 * 1024 * 1024) {
    // Se il buffer supera 5MB, evitare di inondare: drop frame
    return;
  }
  ws.send(payload);
}

// Heartbeat per chiudere connessioni morte
setInterval(() => {
  for (const clients of [ ...Object.values(rooms) ].map(r => r.viewers)) {
    for (const ws of clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`✅ Relay in ascolto su :${PORT}`);
  if (RELAY_KEY) console.log("🔐 Auth attiva: query ?key=RELAY_KEY richiesta");
});
