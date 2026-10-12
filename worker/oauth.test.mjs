import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import worker from "./worker.js";

async function d1() {
  const sqlite = new DatabaseSync(":memory:");
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  sqlite.exec(schema);
  return {
    sqlite,
    prepare(sql) {
      let args = [];
      const statement = sqlite.prepare(sql);
      const bound = { bind(...values) { args = values; return bound; } };
      bound.first = () => statement.get(...args) || null;
      bound.all = () => ({ results: statement.all(...args) });
      bound.run = () => ({ success: true, meta: { changes: Number(statement.run(...args).changes) } });
      return bound;
    },
  };
}

function cookieValue(response, name) {
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.find(value => value.startsWith(name + "="));
  return cookie && cookie.slice(name.length + 1).split(";", 1)[0];
}

function request(path, { cookie, method = "GET", body } = {}) {
  return new Request("https://priceguessinggame.com" + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const envWithProviders = db => ({
  DB: db,
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
  X_CLIENT_ID: "x-client",
  X_CLIENT_SECRET: "x-secret",
});

function start(env, provider) {
  return worker.fetch(request("/api/auth/oauth/start?provider=" + provider), env, { waitUntil() {} });
}

async function callback(env, state, nonce, code = "fake-code") {
  return worker.fetch(request("/api/auth/oauth/callback?state=" + encodeURIComponent(state) + "&code=" + encodeURIComponent(code), {
    cookie: "pgg_oauth_nonce=" + nonce,
  }), env, { waitUntil() {} });
}

function mockProviderFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("github.com/login/oauth/access_token")) return Response.json({ access_token: "gh-access" });
    if (url.includes("api.github.com/user/emails")) return Response.json([{ email: "same@example.com", verified: true, primary: true }]);
    if (url.includes("api.github.com/user")) return Response.json({ id: 701, name: "GitHub Player", login: "gh-player", avatar_url: "https://avatars.example/gh.png" });
    if (url.includes("api.x.com/2/oauth2/token")) return Response.json({ access_token: "x-access" });
    if (url.includes("api.x.com/2/users/me")) return Response.json({ data: { id: "902", name: "X Player", username: "x-player", profile_image_url: "https://images.example/x.png" } });
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "google-access" });
    if (url.includes("openidconnect.googleapis.com/v1/userinfo") || url.includes("www.googleapis.com/oauth2/v3/userinfo")) {
      return Response.json({ sub: "google-existing-sub", name: "Google Player", email: "same@example.com", email_verified: true, picture: "https://images.example/google.png" });
    }
    return Response.json({});
  };
  return () => { globalThis.fetch = original; };
}

test("OAuth state is cookie-bound, expires, and can only be consumed once", async () => {
  const db = await d1();
  const env = envWithProviders(db);
  const configured = await worker.fetch(request("/api/auth/providers"), env, { waitUntil() {} });
  assert.deepEqual((await configured.json()).providers, ["google", "github", "x"]);
  const begun = await start(env, "github");
  assert.equal(begun.status, 302);
  const authorize = new URL(begun.headers.get("location"));
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://priceguessinggame.com/api/auth/oauth/callback");
  const state = authorize.searchParams.get("state");
  const nonce = cookieValue(begun, "pgg_oauth_nonce");
  assert.ok(state && nonce);
  const xStart = await start(env, "x");
  const xAuthorize = new URL(xStart.headers.get("location"));
  assert.equal(xAuthorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(xAuthorize.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await callback(env, state, "wrong-nonce")).status, 400);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE state = ?").get(state).n, 1);
  assert.equal((await callback(env, state, nonce, "")).status, 400);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE state = ?").get(state).n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE state = ?").get(xAuthorize.searchParams.get("state")).n, 1);
  assert.equal((await callback(env, state, nonce)).status, 400);

  db.sqlite.prepare("INSERT INTO oauth_states (state, nonce, provider, expires_at) VALUES (?, ?, ?, ?)")
    .run("expired-state", "expired-nonce", "github", Date.now() - 1);
  assert.equal((await callback(env, "expired-state", "expired-nonce")).status, 400);
  db.sqlite.close();
});

test("OAuth profile failure consumes state without creating a user, and preview callbacks canonicalize", async () => {
  const db = await d1();
  const env = envWithProviders(db);
  const preview = await worker.fetch(new Request("https://priceguessinggame.pages.dev/api/auth/oauth/callback?code=c&state=s"), env, { waitUntil() {} });
  assert.equal(preview.status, 302);
  assert.equal(preview.headers.get("location"), "https://priceguessinggame.com/api/auth/oauth/callback?code=c&state=s");

  const begun = await start(env, "github");
  const authorize = new URL(begun.headers.get("location"));
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("provider unavailable"); };
  try {
    const failed = await callback(env, authorize.searchParams.get("state"), cookieValue(begun, "pgg_oauth_nonce"));
    assert.equal(failed.status, 401);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states").get().n, 0);
  } finally {
    globalThis.fetch = restoreFetch;
    db.sqlite.close();
  }
});

test("Google keeps its raw subject and historical ranking; GitHub and X identities stay provider-scoped", async () => {
  const db = await d1();
  const env = envWithProviders(db);
  db.sqlite.prepare("INSERT INTO users (sub, name, email) VALUES (?, ?, ?)").run("google-existing-sub", "Old Google Name", "same@example.com");
  db.sqlite.prepare("INSERT INTO scores (day, player_id, name, total, greens, guesses) VALUES (?, ?, ?, ?, ?, ?)")
    .run("2026-10-11", "g-google-existing-sub", "Old Google Name", 400, 3, "[1,2,3,4,5]");
  const restoreFetch = mockProviderFetch();
  try {
    const googleStart = await start(env, "google");
    const google = new URL(googleStart.headers.get("location"));
    const googleCallback = await callback(env, google.searchParams.get("state"), cookieValue(googleStart, "pgg_oauth_nonce"));
    assert.equal(googleCallback.status, 302);
    const googleSid = cookieValue(googleCallback, "pgg_session");
    assert.ok(googleSid);
    const me = await worker.fetch(request("/api/auth/me", { cookie: "pgg_session=" + googleSid }), env, { waitUntil() {} });
    assert.equal((await me.json()).sub, "google-existing-sub");
    assert.equal(db.sqlite.prepare("SELECT player_id FROM scores WHERE day = ?").get("2026-10-11").player_id, "g-google-existing-sub");

    for (const [provider, expectedSub] of [["github", "github-701"], ["x", "x-902"]]) {
      const begun = await start(env, provider);
      const url = new URL(begun.headers.get("location"));
      const completed = await callback(env, url.searchParams.get("state"), cookieValue(begun, "pgg_oauth_nonce"));
      assert.equal(completed.status, 302);
      const sid = cookieValue(completed, "pgg_session");
      const profile = await worker.fetch(request("/api/auth/me", { cookie: "pgg_session=" + sid }), env, { waitUntil() {} });
      assert.equal((await profile.json()).sub, expectedSub);
    }
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get("same@example.com").n, 2);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 3);
  } finally {
    restoreFetch();
    db.sqlite.close();
  }
});

test("anonymous scores still work and logout returns /me to anonymous", async () => {
  const db = await d1();
  const env = envWithProviders(db);
  const anonymous = await worker.fetch(request("/api/score", {
    method: "POST",
    body: { day: "2026-10-12", pid: "anonymous-player-1", name: "Anonymous", guesses: [100, 100, 100, 100, 100] },
  }), env, { waitUntil() {} });
  assert.equal(anonymous.status, 200);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM scores WHERE player_id = ?").get("anonymous-player-1").n, 1);

  db.sqlite.prepare("INSERT INTO users (sub, name) VALUES (?, ?)").run("github-701", "GitHub Player");
  db.sqlite.prepare("INSERT INTO sessions (sid, sub, expires_at) VALUES (?, ?, ?)").run("session-1", "github-701", Date.now() + 60_000);
  const loggedOut = await worker.fetch(request("/api/auth/logout", { method: "POST", cookie: "pgg_session=session-1" }), env, { waitUntil() {} });
  assert.equal(loggedOut.status, 200);
  assert.equal((await (await worker.fetch(request("/api/auth/me", { cookie: "pgg_session=session-1" }), env, { waitUntil() {} })).json()).ok, false);
  db.sqlite.close();
});
