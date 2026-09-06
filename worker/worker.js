// Price Guessing Game — edge API + static proxy
// Routes:
//   POST /api/score            — submit daily unit score (server-side scoring, anti-cheat)
//   GET  /api/leaderboard      — today's board + all-time board + community stats
//   GET  /api/health           — liveness
//   POST /api/auth/google      — verify Google ID token, create session, merge anon scores
//   GET  /api/auth/me          — current session identity
//   POST /api/auth/logout      — destroy session
// Everything else is proxied to the Pages deployment.
import { ITEMS } from "./items.mjs";

const EPOCH = { y: 2026, m: 9, d: 4 }; // puzzle #1
const ITEMS_PER_UNIT = 5;
const SESSION_TTL = 30 * 86400; // 30 days

// ---------- deterministic unit builder (must mirror app.js exactly) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function buildUnit(seedStr) {
  const rng = mulberry32(hashStr(seedStr));
  const sorted = ITEMS.slice().sort((a, b) => a.p - b.p);
  const q = Math.floor(sorted.length / ITEMS_PER_UNIT);
  const picks = [];
  for (let i = 0; i < ITEMS_PER_UNIT; i++) {
    const lo = i * q;
    const hi = i === ITEMS_PER_UNIT - 1 ? sorted.length : (i + 1) * q;
    picks.push(sorted[lo + Math.floor(rng() * (hi - lo))]);
  }
  for (let j = picks.length - 1; j > 0; j--) {
    const k = Math.floor(rng() * (j + 1));
    [picks[j], picks[k]] = [picks[k], picks[j]];
  }
  return picks;
}
function scoreItem(guess, price) {
  const diffPct = Math.abs(guess - price) / price * 100;
  return Math.max(0, Math.round(100 - diffPct));
}

// ---------- helpers ----------
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
// reflect origin for known hosts so pages.dev can send credentialed fetches
const CORS_ALLOW = ["https://priceguessinggame.com", "https://priceguessinggame.pages.dev"];
function withCors(request, resp) {
  const o = request.headers.get("Origin") || "";
  const out = new Response(resp.body, resp);
  if (CORS_ALLOW.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) {
    out.headers.set("access-control-allow-origin", o);
    out.headers.set("access-control-allow-credentials", "true");
    out.headers.append("vary", "Origin");
  }
  return out;
}
function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return false;
  const t = Date.parse(day + "T00:00:00Z");
  if (isNaN(t)) return false;
  const epoch = Date.UTC(EPOCH.y, EPOCH.m - 1, EPOCH.d);
  const tomorrow = Date.now() + 86400000; // tolerate timezone-ahead clients
  return t >= epoch && t <= tomorrow;
}
function cleanName(name) {
  let n = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!n) n = "Anonymous Bidder";
  return n.slice(0, 24);
}
async function readBody(request) {
  try { return await request.json(); } catch (e) { return null; }
}
function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const m = new RegExp("(?:^|;\\s*)" + name + "=([A-Za-z0-9-]+)").exec(cookie);
  return m ? m[1] : null;
}

// ---------- session helpers ----------
async function sessionUser(request, env) {
  const sid = getCookie(request, "pgg_session");
  if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT u.sub, u.name, u.email, u.picture FROM sessions s
     JOIN users u ON u.sub = s.sub
     WHERE s.sid = ?1 AND s.expires_at > ?2`
  ).bind(sid, Date.now()).first();
  return row || null;
}
function sessionCookie(sid, maxAge) {
  return { "set-cookie": `pgg_session=${sid}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/` };
}

// ---------- Google ID token verification (RS256 via JWKS) ----------
let jwksCache = null, jwksAt = 0;
async function getJwks() {
  if (jwksCache && Date.now() - jwksAt < 3600000) return jwksCache;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  jwksCache = await r.json();
  jwksAt = Date.now();
  return jwksCache;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function verifyGoogleIdToken(token, clientId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  if (header.alg !== "RS256") throw new Error("bad alg");
  if (!["https://accounts.google.com", "accounts.google.com"].includes(payload.iss)) throw new Error("bad issuer");
  if (payload.aud !== clientId) throw new Error("bad audience");
  if (!payload.sub || typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) throw new Error("expired");

  const jwks = await getJwks();
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]).buffer, data);
  if (!ok) throw new Error("bad signature");
  return payload;
}

// ---------- POST /api/auth/google ----------
async function handleAuthGoogle(request, env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) return json({ ok: false, error: "auth not configured" }, 503);
  const body = await readBody(request);
  if (!body || !body.credential) return json({ ok: false, error: "missing credential" }, 400);

  let payload;
  try { payload = await verifyGoogleIdToken(body.credential, clientId); }
  catch (e) { return json({ ok: false, error: "invalid token: " + e.message }, 401); }

  const sub = payload.sub;
  const name = cleanName(payload.name || payload.email || "Bidder");
  const email = typeof payload.email === "string" ? payload.email.slice(0, 120) : null;
  const picture = typeof payload.picture === "string" && /^https:\/\//.test(payload.picture) ? payload.picture : null;

  const db = env.DB;
  await db.prepare(
    `INSERT INTO users (sub, name, email, picture) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(sub) DO UPDATE SET name = ?2, email = ?3, picture = ?4, last_login = datetime('now')`
  ).bind(sub, name, email, picture).run();

  // merge anonymous scores into the Google identity (avoid PK clashes)
  const anonPid = typeof body.anonPid === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.anonPid) && !body.anonPid.startsWith("g-") ? body.anonPid : null;
  if (anonPid) {
    await db.prepare(
      `UPDATE scores SET player_id = ?1, name = ?2
       WHERE player_id = ?3
         AND day NOT IN (SELECT day FROM scores WHERE player_id = ?1)`
    ).bind("g-" + sub, name, anonPid).run();
  }

  const sid = crypto.randomUUID() + "-" + Date.now().toString(36);
  await db.prepare(`INSERT INTO sessions (sid, sub, expires_at) VALUES (?1, ?2, ?3)`)
    .bind(sid, sub, Date.now() + SESSION_TTL * 1000).run();

  return json({ ok: true, name, picture, sub }, 200, sessionCookie(sid, SESSION_TTL));
}

// ---------- GET /api/auth/config ----------
async function handleAuthConfig(env) {
  return json({ ok: true, clientId: env.GOOGLE_CLIENT_ID || null });
}

// ---------- GET /api/auth/me ----------
async function handleAuthMe(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false }, 401);
  return json({ ok: true, sub: user.sub, name: user.name, picture: user.picture });
}

// ---------- POST /api/auth/logout ----------
async function handleAuthLogout(request, env) {
  const sid = getCookie(request, "pgg_session");
  if (sid) await env.DB.prepare(`DELETE FROM sessions WHERE sid = ?1`).bind(sid).run();
  return json({ ok: true }, 200, sessionCookie("", 0));
}

// ---------- POST /api/score ----------
async function handleScore(request, env) {
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "bad json" }, 400);

  const day = String(body.day || "");
  const guesses = Array.isArray(body.guesses) ? body.guesses : null;

  if (!validDay(day)) return json({ ok: false, error: "bad day" }, 400);
  if (!guesses || guesses.length !== ITEMS_PER_UNIT ||
      !guesses.every(g => Number.isInteger(g) && g >= 1 && g <= 9999999)) {
    return json({ ok: false, error: "bad guesses" }, 400);
  }

  // identity: Google session wins over anonymous client-provided id
  const user = await sessionUser(request, env);
  let pid, name;
  if (user) {
    pid = "g-" + user.sub;
    name = user.name;
  } else {
    pid = String(body.pid || "");
    name = cleanName(body.name);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(pid)) return json({ ok: false, error: "bad pid" }, 400);
  }

  // server-side scoring from the canonical item set (anti-cheat)
  const unit = buildUnit("daily-" + day);
  let total = 0, greens = 0;
  for (let i = 0; i < ITEMS_PER_UNIT; i++) {
    const s = scoreItem(guesses[i], unit[i].p);
    total += s;
    const diffPct = Math.abs(guesses[i] - unit[i].p) / unit[i].p * 100;
    if (diffPct <= 10) greens++;
  }

  const db = env.DB;
  await db.prepare(
    `INSERT INTO scores (day, player_id, name, total, greens, guesses)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(day, player_id) DO UPDATE SET
       name = ?3, total = excluded.total, greens = excluded.greens,
       guesses = ?6, updated_at = datetime('now')
     WHERE excluded.total > scores.total`
  ).bind(day, pid, name, total, greens, JSON.stringify(guesses)).run();

  const stats = await db.prepare(
    `SELECT COUNT(*) AS players, AVG(total) AS avg_total FROM scores WHERE day = ?1`
  ).bind(day).first();
  const better = await db.prepare(
    `SELECT COUNT(*) AS n FROM scores WHERE day = ?1 AND total > ?2`
  ).bind(day, total).first();

  // community average bid per item (sample cap 500)
  let community = null;
  const rows = await db.prepare(
    `SELECT guesses FROM scores WHERE day = ?1 ORDER BY updated_at DESC LIMIT 500`
  ).bind(day).all();
  if (rows.results && rows.results.length) {
    community = [0, 0, 0, 0, 0];
    let cnt = 0;
    for (const r of rows.results) {
      try {
        const g = JSON.parse(r.guesses);
        if (Array.isArray(g) && g.length === ITEMS_PER_UNIT) {
          for (let i = 0; i < ITEMS_PER_UNIT; i++) community[i] += g[i];
          cnt++;
        }
      } catch (e) { /* skip malformed */ }
    }
    if (cnt > 0) community = community.map(v => Math.round(v / cnt));
    else community = null;
  }

  const players = stats ? stats.players : 0;
  return json({
    ok: true,
    total,
    greens,
    rank: (better ? better.n : 0) + 1,
    players,
    avgTotal: stats && stats.avg_total != null ? Math.round(stats.avg_total) : null,
    community,
  });
}

// ---------- GET /api/leaderboard ----------
async function handleLeaderboard(request, env, url) {
  const day = url.searchParams.get("day") || "";
  if (!validDay(day)) return json({ ok: false, error: "bad day" }, 400);
  const db = env.DB;

  const today = await db.prepare(
    `SELECT player_id, name, total, greens FROM scores
     WHERE day = ?1 ORDER BY total DESC, updated_at ASC LIMIT 20`
  ).bind(day).all();
  const stats = await db.prepare(
    `SELECT COUNT(*) AS players, AVG(total) AS avg_total FROM scores WHERE day = ?1`
  ).bind(day).first();
  const alltime = await db.prepare(
    `SELECT g.player_id AS player_id, g.name AS name, g.best AS best, c.games AS games
     FROM (SELECT player_id, name, MAX(total) AS best FROM scores GROUP BY player_id ORDER BY best DESC LIMIT 20) g
     JOIN (SELECT player_id, COUNT(*) AS games FROM scores GROUP BY player_id) c
       ON c.player_id = g.player_id
     ORDER BY g.best DESC LIMIT 20`
  ).all();

  return json({
    ok: true,
    today: {
      list: today.results || [],
      players: stats ? stats.players : 0,
      avgTotal: stats && stats.avg_total != null ? Math.round(stats.avg_total) : null,
    },
    alltime: alltime.results || [],
  });
}

// ---------- fetch handler ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      }));
    }

    if (path === "/api/health") return withCors(request, json({ ok: true, ts: Date.now() }));

    if (path === "/api/auth/config" && request.method === "GET") {
      try { return withCors(request, await handleAuthConfig(env)); }
      catch (e) { return json({ ok: false, error: "server error" }, 500); }
    }

    if (path === "/api/auth/google" && request.method === "POST") {
      try { return withCors(request, await handleAuthGoogle(request, env)); }
      catch (e) { return json({ ok: false, error: "server error" }, 500); }
    }
    if (path === "/api/auth/me" && request.method === "GET") {
      try { return withCors(request, await handleAuthMe(request, env)); }
      catch (e) { return json({ ok: false, error: "server error" }, 500); }
    }
    if (path === "/api/auth/logout" && request.method === "POST") {
      try { return withCors(request, await handleAuthLogout(request, env)); }
      catch (e) { return json({ ok: false, error: "server error" }, 500); }
    }

    if (path === "/api/score" && request.method === "POST") {
      try { return withCors(request, await handleScore(request, env)); }
      catch (e) { return json({ ok: false, error: "server error" }, 500); }
    }

    if (path === "/api/leaderboard" && request.method === "GET") {
      try { return withCors(request, await handleLeaderboard(request, env, url)); }
      catch (e) { return json({ ok: false, error: "server error" }, 500); }
    }

    // everything else → Pages
    url.hostname = "priceguessinggame.pages.dev";
    const resp = await fetch(new Request(url.toString(), request));
    const out = new Response(resp.body, resp);
    out.headers.delete("set-cookie");
    return out;
  },
};
