// Price Guessing Game — edge API + static proxy
// Routes:
//   POST /api/score        — submit daily unit score (server-side scoring, anti-cheat)
//   GET  /api/leaderboard  — today's board + all-time board + community stats
//   GET  /api/health       — liveness
// Everything else is proxied to the Pages deployment.
import { ITEMS } from "./items.mjs";

const EPOCH = { y: 2026, m: 9, d: 4 }; // puzzle #1
const ITEMS_PER_UNIT = 5;

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
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
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

// ---------- POST /api/score ----------
async function handleScore(request, env) {
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "bad json" }, 400);

  const day = String(body.day || "");
  const pid = String(body.pid || "");
  const name = cleanName(body.name);
  const guesses = Array.isArray(body.guesses) ? body.guesses : null;

  if (!validDay(day)) return json({ ok: false, error: "bad day" }, 400);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(pid)) return json({ ok: false, error: "bad pid" }, 400);
  if (!guesses || guesses.length !== ITEMS_PER_UNIT ||
      !guesses.every(g => Number.isInteger(g) && g >= 1 && g <= 9999999)) {
    return json({ ok: false, error: "bad guesses" }, 400);
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
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (path === "/api/health") return json({ ok: true, ts: Date.now() });

    if (path === "/api/score" && request.method === "POST") {
      try { return await handleScore(request, env); }
      catch (e) { return json({ ok: false, error: "server error" }, 500); }
    }

    if (path === "/api/leaderboard" && request.method === "GET") {
      try { return await handleLeaderboard(request, env, url); }
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
