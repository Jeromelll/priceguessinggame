/* Price Guessing Game — core app
 * Daily deterministic puzzle (same 5 items for everyone), Wordle-style tiers,
 * share card, local streak stats, bonus (infinite) mode, and ?d=YYYY-MM-DD archive play.
 * Pure vanilla JS, no dependencies, no network calls.
 */
"use strict";

(function () {
  // ---------- Config ----------
  var EPOCH = { y: 2026, m: 9, d: 4 }; // puzzle #1
  var ITEMS_PER_UNIT = 5;
  var STORAGE_STATS = "pgg_stats_v1";
  var STORAGE_PID = "pgg_pid_v1";
  var STORAGE_ANON_PID = "pgg_anon_pid_v1";
  var STORAGE_NAME = "pgg_name_v1";
  var dailyPrefix = "pgg_daily_";
  // Google sign-in state (session cookie is authoritative; this mirrors it for UI)
  var auth = { ready: false, user: null, clientId: null };

  // ---------- Utils ----------
  function $(id) { return document.getElementById(id); }

  function fmtMoney(n) {
    return "$" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // Deterministic PRNG (mulberry32)
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function dateKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function puzzleNum(d) {
    var a = Date.UTC(EPOCH.y, EPOCH.m - 1, EPOCH.d);
    var b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.floor((b - a) / 86400000) + 1;
  }

  function fmtDate(d) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  // ---------- Unit builder: 1 item per price quintile, shuffled order ----------
  function buildUnit(seedStr) {
    var rng = mulberry32(hashStr(seedStr));
    var sorted = ITEMS.slice().sort(function (a, b) { return a.p - b.p; });
    var q = Math.floor(sorted.length / ITEMS_PER_UNIT);
    var picks = [];
    for (var i = 0; i < ITEMS_PER_UNIT; i++) {
      var lo = i * q;
      var hi = (i === ITEMS_PER_UNIT - 1) ? sorted.length : (i + 1) * q;
      picks.push(sorted[lo + Math.floor(rng() * (hi - lo))]);
    }
    // Fisher–Yates with same rng
    for (var j = picks.length - 1; j > 0; j--) {
      var k = Math.floor(rng() * (j + 1));
      var tmp = picks[j]; picks[j] = picks[k]; picks[k] = tmp;
    }
    return picks;
  }

  // ---------- Scoring ----------
  function tierOf(diffPct) {
    if (diffPct <= 10) return { emoji: "🟩", label: "Nailed it!", cls: "t-green" };
    if (diffPct <= 25) return { emoji: "🟨", label: "Close call!", cls: "t-yellow" };
    if (diffPct <= 50) return { emoji: "🟧", label: "In the ballpark.", cls: "t-orange" };
    return { emoji: "🟥", label: "Way off!", cls: "t-red" };
  }

  function scoreItem(guess, price) {
    var diffPct = Math.abs(guess - price) / price * 100;
    var score = Math.max(0, Math.round(100 - diffPct));
    return { diffPct: diffPct, score: score, tier: tierOf(diffPct) };
  }

  // ---------- Player identity ----------
  function pidGet() {
    var pid = null;
    try { pid = localStorage.getItem(STORAGE_PID); } catch (e) {}
    if (!pid || !/^[A-Za-z0-9-]{8,64}$/.test(pid)) {
      pid = (crypto && crypto.randomUUID) ? crypto.randomUUID()
        : "pid-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
      try { localStorage.setItem(STORAGE_PID, pid); } catch (e) {}
    }
    return pid;
  }
  function nameGet() {
    var n = null;
    try { n = localStorage.getItem(STORAGE_NAME); } catch (e) {}
    if (!n) {
      n = "Bidder-" + Math.floor(1000 + Math.random() * 9000);
      try { localStorage.setItem(STORAGE_NAME, n); } catch (e) {}
    }
    return n;
  }
  function nameSet(n) {
    n = String(n || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
    if (!n) return nameGet();
    try { localStorage.setItem(STORAGE_NAME, n); } catch (e) {}
    return n;
  }

  // ---------- Leaderboard API ----------
  function apiBase() {
    return location.hostname.indexOf("pages.dev") >= 0 ? "https://priceguessinggame.com" : "";
  }

  // Cookieless first-party analytics. Never send pid/sub/email/IP/bids/file contents.
  // page_view is server-side only (Worker logs HTML GETs) — do not track it here.
  function track(name, x1, x2) {
    try {
      var body = JSON.stringify({ e: name, p: location.pathname, x1: x1 || "", x2: x2 || "" });
      var url = apiBase() + "/api/evt";
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return;
      fetch(url, { method: "POST", body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* analytics must never break the game */ }
  }

  // effective leaderboard identity: Google session maps to "g-"+sub server-side
  function effectivePid() {
    return auth.user && auth.user.sub ? "g-" + auth.user.sub : pidGet();
  }

  // ---------- Google sign-in ----------
  function fetchOpts(extra) {
    var o = { credentials: "include" };
    for (var k in (extra || {})) o[k] = extra[k];
    return o;
  }

  function loadGis(cb) {
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true;
    s.onload = cb;
    document.head.appendChild(s);
  }

  function initAuth() {
    fetch(apiBase() + "/api/auth/config", fetchOpts())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok || !d.clientId) return; // not configured → stay anonymous
        auth.clientId = d.clientId;
        auth.ready = true;
        return fetch(apiBase() + "/api/auth/me", fetchOpts())
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (u) {
            if (u && u.ok) { auth.user = u; updateUserChip(); refreshNameChip(); }
          });
      })
      .then(function () {
        if (!auth.clientId) return;
        loadGis(function () {
          if (!window.google || !google.accounts || !google.accounts.id) return;
          google.accounts.id.initialize({ client_id: auth.clientId, callback: onGoogleCredential });
          renderGButton();
        });
      })
      .catch(function () {});
  }

  function renderGButton() {
    var box = $("gbtn");
    if (!box || !auth.ready || !window.google || !google.accounts || !google.accounts.id) return;
    if (!auth.user && box.childElementCount === 0) {
      google.accounts.id.renderButton(box, { theme: "outline", size: "medium", text: "signin", shape: "pill" });
    }
    box.hidden = !!auth.user;
  }

  function updateUserChip() {
    var chip = $("user-chip"), img = $("user-pic"), nm = $("user-name"), out = $("logout-btn");
    if (!chip) return;
    if (auth.user) {
      nm.textContent = auth.user.name || "Signed in";
      if (auth.user.picture) { img.src = auth.user.picture; img.hidden = false; }
      chip.hidden = false;
      out.hidden = false;
    } else {
      chip.hidden = true;
      out.hidden = true;
    }
    renderGButton();
  }

  function onGoogleCredential(resp) {
    if (!resp || !resp.credential) return;
    fetch(apiBase() + "/api/auth/google", fetchOpts({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: resp.credential, anonPid: pidGet() })
    }))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok) return;
        try { localStorage.setItem(STORAGE_ANON_PID, pidGet()); } catch (e) {}
        auth.user = { sub: d.sub, name: d.name, picture: d.picture };
        updateUserChip();
        refreshNameChip();
        loadLeaderboard();
      })
      .catch(function () {});
  }

  function signOut() {
    fetch(apiBase() + "/api/auth/logout", fetchOpts({ method: "POST" }))
      .catch(function () {})
      .then(function () {
        auth.user = null;
        try {
          var anon = localStorage.getItem(STORAGE_ANON_PID);
          if (anon) localStorage.setItem(STORAGE_PID, anon);
        } catch (e) {}
        updateUserChip();
        refreshNameChip();
        loadLeaderboard();
      });
  }

  function submitScore() {
    if (mode !== "daily" || !date) return;
    var payload = {
      day: dateKey(date),
      pid: pidGet(),
      name: nameGet(),
      guesses: guesses.slice()
    };
    var total = 0;
    for (var i = 0; i < results.length; i++) total += results[i].score;
    el.rankLine.hidden = false;
    el.rankLine.textContent = "Syncing your score…";
    fetch(apiBase() + "/api/score", fetchOpts({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.ok) { el.rankLine.textContent = ""; el.rankLine.hidden = true; return; }
      var pct = d.players ? Math.round((d.rank - 1) / d.players * 100) : 0;
      var line = "🏆 Rank #" + d.rank + " of " + d.players + " bidder" + (d.players === 1 ? "" : "s") +
        " today" + (d.players ? " — top " + Math.max(1, pct + (pct === 0 ? 0 : 1)) + "%" : "");
      if (d.community) {
        el.rankLine.textContent = line;
        augmentResultsList(d.community);
      } else {
        el.rankLine.textContent = line;
      }
      loadLeaderboard();
    }).catch(function () {
      el.rankLine.hidden = true;
    });
  }

  function augmentResultsList(community) {
    var lis = el.resultsList.children;
    for (var i = 0; i < lis.length && i < community.length; i++) {
      var li = lis[i];
      if (li.querySelector(".rl-avg")) continue;
      var avg = document.createElement("span");
      avg.className = "rl-avg";
      avg.textContent = "players avg " + fmtMoney(community[i]);
      avg.title = "Average bid by all players on this item today";
      li.appendChild(avg);
    }
  }

  function loadLeaderboard() {
    var day = dateKey(new Date());
    fetch(apiBase() + "/api/leaderboard?day=" + day, fetchOpts())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok) { el.lbWrap.hidden = true; return; }
        el.lbWrap.hidden = false;
        el.lbStats.textContent = d.today.players
          ? d.today.players + " bidder" + (d.today.players === 1 ? "" : "s") + " played today · average unit " +
            (d.today.avgTotal != null ? d.today.avgTotal : "—") + " / 500"
          : "No bids placed today yet — be the first!";
        renderLbList(el.lbToday, d.today.list, "total");
        renderLbList(el.lbAlltime, d.alltime, "best", "games");
      })
      .catch(function () { el.lbWrap.hidden = true; });
  }

  function renderLbList(ol, list, ptsField, extraField) {
    ol.innerHTML = "";
    if (!list || !list.length) {
      var li = document.createElement("li");
      li.className = "lb-empty";
      li.textContent = "— empty —";
      ol.appendChild(li);
      return;
    }
    var me = effectivePid();
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      var li2 = document.createElement("li");
      var medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1);
      var isMe = row.player_id === me;
      li2.innerHTML = '<span class="lb-rank"></span><span class="lb-name"></span>' +
        '<span class="lb-meta"></span><span class="lb-pts"></span>';
      li2.querySelector(".lb-rank").textContent = medal;
      li2.querySelector(".lb-name").textContent = (row.name || "Anonymous") + (isMe ? " (you)" : "");
      if (isMe) li2.className = "lb-me";
      var meta = [];
      if (row.greens != null) meta.push("🟩" + row.greens);
      if (extraField && row[extraField] != null) meta.push(row[extraField] + " unit" + (row[extraField] === 1 ? "" : "s"));
      li2.querySelector(".lb-meta").textContent = meta.join(" · ");
      li2.querySelector(".lb-pts").textContent = row[ptsField] + "/500";
      ol.appendChild(li2);
    }
  }

  // ---------- Close Call mode (6 iterative guesses, win within 5%) ----------
  var closerPrefix = "pgg_closer_";
  var dailyDate = null;
  var closer = null;

  function closerItemFor(d) {
    var rng = mulberry32(hashStr("closer-" + dateKey(d)));
    return ITEMS[Math.floor(rng() * ITEMS.length)];
  }

  function closerEval(guess, price) {
    var pct = Math.abs(guess - price) / price * 100;
    return {
      pct: pct, win: pct <= 5,
      cls: pct <= 5 ? "cl-green" : (pct <= 25 ? "cl-yellow" : "cl-red"),
      arrow: guess < price ? "▲" : (guess > price ? "▼" : "✓")
    };
  }

  function startCloser() {
    maybeAbandon();
    brStopTimers();
    el.brCard.hidden = true;
    var d = new Date();
    closer = { day: dateKey(d), item: closerItemFor(d), guesses: [], counted: false, done: false, won: false };
    try {
      var saved = JSON.parse(localStorage.getItem(closerPrefix + closer.day));
      if (saved && Array.isArray(saved.guesses)) { closer.guesses = saved.guesses; closer.counted = !!saved.counted; }
    } catch (e) {}
    for (var i = 0; i < closer.guesses.length; i++) {
      if (closerEval(closer.guesses[i], closer.item.p).win) { closer.done = true; closer.won = true; }
    }
    if (closer.guesses.length >= 6) closer.done = true;

    el.itemCard.hidden = true; el.revealCard.hidden = true; el.resultsCard.hidden = true; el.countdown.hidden = true;
    if (el.rummageCard) el.rummageCard.hidden = true;
    if (el.progress) el.progress.hidden = false;
    el.closerEmoji.textContent = closer.item.e;
    el.closerName.textContent = closer.item.n;
    el.closerDesc.textContent = closer.item.d + " (" + closer.item.c + ")";
    el.closerInput.value = "";
    el.closerHint.textContent = "";
    el.closerShareHint.textContent = "";
    el.closerResult.hidden = true;
    el.closerCard.hidden = false;
    renderCloser();
    if (!closer.done) {
      track("game_start", "closer", closer.day);
      setTimeout(function () { el.closerInput.focus(); }, 60);
    }
  }

  function renderCloser() {
    el.closerHistory.innerHTML = "";
    for (var i = 0; i < closer.guesses.length; i++) {
      var g = closer.guesses[i];
      var r = closerEval(g, closer.item.p);
      var li = document.createElement("li");
      li.className = r.cls;
      li.innerHTML = '<span class="cl-guess"></span><span class="cl-arrow"></span><span class="cl-off"></span>';
      li.querySelector(".cl-guess").textContent = fmtMoney(g);
      li.querySelector(".cl-arrow").textContent = r.win ? "✓" : r.arrow;
      li.querySelector(".cl-off").textContent = r.win ? "within 5%" : Math.round(r.pct) + "% off";
      el.closerHistory.appendChild(li);
    }
    var s = statsLoad();
    var c = s.closer;
    el.closerStatsLine.textContent = c && c.played
      ? "🔥 Streak " + (c.streak || 0) + " · " + c.wins + "/" + c.played + " won" + (c.best ? " · Best: " + c.best + " guess" + (c.best === 1 ? "" : "es") : "")
      : "";
    renderCloserDist(c);
    el.closerInputRow.hidden = closer.done;
    if (closer.done) {
      el.closerHint.textContent = "";
      var used = closer.guesses.length;
      el.closerResult.hidden = false;
      if (closer.won) {
        el.closerResultTier.textContent = "🔒 Locked it in " + used + " guess" + (used === 1 ? "" : "es") + "!";
        el.closerResultTier.className = "reveal-tier t-green";
      } else {
        el.closerResultTier.textContent = "💸 Out of guesses!";
        el.closerResultTier.className = "reveal-tier t-red";
      }
      el.closerReal.textContent = fmtMoney(closer.item.p);
      var best = null, bestPct = Infinity;
      for (var j = 0; j < closer.guesses.length; j++) {
        var pct = Math.abs(closer.guesses[j] - closer.item.p) / closer.item.p * 100;
        if (pct < bestPct) { bestPct = pct; best = closer.guesses[j]; }
      }
      el.closerResultLine.innerHTML = "Real price — your closest guess was <strong></strong>";
      el.closerResultLine.querySelector("strong").textContent = fmtMoney(best) + " (" + Math.round(bestPct) + "% off)";
    }
  }

  function closerGuess() {
    if (!closer || closer.done) return;
    var raw = el.closerInput.value.trim();
    if (!/^\d{1,7}$/.test(raw)) {
      el.closerHint.textContent = "Enter a whole dollar amount, e.g. 250.";
      el.closerInput.focus();
      return;
    }
    var guess = parseInt(raw, 10);
    closer.guesses.push(guess);
    el.closerInput.value = "";
    el.closerHint.textContent = "";
    var r = closerEval(guess, closer.item.p);
    if (r.win) { closer.done = true; closer.won = true; }
    else if (closer.guesses.length >= 6) { closer.done = true; }
    persistCloser();
    renderCloser();
    if (closer.done) {
      finishCloser();
    } else {
      el.closerHint.textContent = r.arrow === "▲" ? "Real price is HIGHER ▲" : "Real price is LOWER ▼";
      el.closerInput.focus();
    }
  }

  function persistCloser() {
    try { localStorage.setItem(closerPrefix + closer.day, JSON.stringify({ guesses: closer.guesses, counted: closer.counted })); } catch (e) {}
  }

  function finishCloser() {
    if (!closer.counted) {
      closer.counted = true;
      persistCloser();
      updateCloserStats();
      track("game_complete", "closer", (closer.won ? "win:" : "lose:") + closer.guesses.length);
    }
    renderCloser();
  }

  function updateCloserStats() {
    var s = statsLoad();
    var c = s.closer = s.closer || { played: 0, wins: 0, streak: 0, maxStreak: 0, best: null, dist: [0, 0, 0, 0, 0, 0] };
    if (!c.dist) c.dist = [0, 0, 0, 0, 0, 0];
    c.played++;
    if (closer.won) {
      c.wins++;
      var used = closer.guesses.length;
      c.dist[used - 1]++;
      if (!c.best || used < c.best) c.best = used;
      var y = new Date(); y.setDate(y.getDate() - 1);
      c.streak = (s.lastCloser === dateKey(y)) ? (c.streak || 0) + 1 : 1;
      if ((c.streak || 0) > (c.maxStreak || 0)) c.maxStreak = c.streak;
    } else {
      c.streak = 0;
    }
    s.lastCloser = closer.day;
    statsSave(s);
  }

  function renderCloserDist(c) {
    var ul = el.closerDist;
    if (!ul) return;
    if (!c || !c.played) { ul.hidden = true; return; }
    var dist = c.dist || [0, 0, 0, 0, 0, 0];
    var max = 1;
    for (var i = 0; i < 6; i++) if (dist[i] > max) max = dist[i];
    ul.innerHTML = "";
    ul.hidden = false;
    var title = document.createElement("li");
    title.className = "cd-title";
    title.textContent = "Guess distribution (wins)";
    ul.appendChild(title);
    for (var j = 0; j < 6; j++) {
      var li = document.createElement("li");
      li.innerHTML = '<span class="cd-label"></span><span class="cd-bar-wrap"><span class="cd-bar"></span></span><span class="cd-count"></span>';
      li.querySelector(".cd-label").textContent = j + 1;
      li.querySelector(".cd-bar").style.width = Math.max(8, Math.round(dist[j] / max * 100)) + "%";
      li.querySelector(".cd-count").textContent = dist[j];
      ul.appendChild(li);
    }
  }

  function closerShare() {
    var rows = "";
    for (var i = 0; i < closer.guesses.length; i++) {
      var r = closerEval(closer.guesses[i], closer.item.p);
      rows += r.win ? "✅" : (r.cls === "cl-yellow" ? "🟨" : "🟥");
    }
    var head = "🏷️ Price Guessing Game — Close Call #" + Math.max(1, puzzleNum(new Date()));
    var res = closer.won
      ? "Locked in " + closer.guesses.length + "/6 guesses"
      : "0/6 — the price got away";
    var txt = head + "\n" + rows + "  " + res + "\nCan you lock the price?\nhttps://priceguessinggame.com";
    copyText(txt, el.closerShareHint);
    track("share", "closer", "clipboard");
  }

  function exitCloser() {
    maybeAbandon();
    el.closerCard.hidden = true;
    startUnit(dailyDate, "daily");
  }

  // ---------- Battle Royale mode (live 10-minute rounds) ----------
  var BR_ROUND_MS = 600000;
  var br = null;            // {round, unit, idx, done, timer, clockTimer}
  var brPollTimer = null;
  var brChallenge = 0;      // friend's score from ?battle=N invite link
  var brLastTotal = 0;      // our finished total this round

  function brStopTimers() {
    if (brPollTimer) { clearInterval(brPollTimer); brPollTimer = null; }
  }

  function brPad(n) { return n < 10 ? "0" + n : "" + n; }

  function startBr() {
    maybeAbandon();
    el.itemCard.hidden = true; el.revealCard.hidden = true; el.resultsCard.hidden = true;
    el.countdown.hidden = true; el.closerCard.hidden = true;
    if (el.rummageCard) el.rummageCard.hidden = true;
    if (el.progress) el.progress.hidden = false;
    el.brCard.hidden = false;
    el.brInputRow.hidden = true; el.brResult.hidden = true; el.brShareHint.textContent = "";
    if (brChallenge) {
      el.brChallenge.hidden = false;
      el.brChallenge.textContent = "🏆 Challenge: your friend scored " + brChallenge + "/500 — beat it!";
    } else {
      el.brChallenge.hidden = true;
    }
    el.brHint.textContent = ""; el.brName.textContent = "Loading…"; el.brEmoji.textContent = "⏳";
    brStopTimers();
    fetch(apiBase() + "/api/br/state?pid=" + encodeURIComponent(effectivePid()), fetchOpts())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok) { el.brRoundLine.textContent = "Battle Royale is unavailable right now."; return; }
        br = { round: d.round, idx: d.me ? d.me.idx : 0, done: d.me ? d.me.idx >= 5 : false };
        br.unit = buildUnit("br-" + br.round);
        if (!br.done) track("game_start", "br", String(br.round));
        el.brRoundLine.textContent = "Round ends in --:--";
        renderBrItem();
        brRefreshBoard();
        brPollTimer = setInterval(function () { brRefreshBoard(); }, 3000);
      })
      .catch(function () { el.brRoundLine.textContent = "Battle Royale is unavailable right now."; });
  }

  function renderBrItem() {
    el.brRoundLine.textContent = "Round ends in --:--";
    if (br.idx >= 5) {
      brShowFinished();
      return;
    }
    var it = br.unit[br.idx];
    el.brEmoji.textContent = it.e;
    el.brName.textContent = it.n;
    el.brDesc.textContent = it.d + " (" + it.c + ")";
    el.brProg.textContent = "· item " + (br.idx + 1) + "/5";
    el.brInputRow.hidden = false;
    el.brInput.value = "";
    setTimeout(function () { el.brInput.focus(); }, 60);
  }

  function brGuess() {
    if (!br || br.idx >= 5) return;
    var raw = el.brInput.value.trim();
    if (!/^\d{1,7}$/.test(raw)) {
      el.brHint.textContent = "Enter a whole dollar amount, e.g. 250.";
      el.brInput.focus();
      return;
    }
    var guess = parseInt(raw, 10);
    el.brGuessBtn.disabled = true;
    fetch(apiBase() + "/api/br/guess", fetchOpts({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ round: br.round, idx: br.idx, guess: guess, pid: pidGet(), name: nameGet() })
    }))
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        el.brGuessBtn.disabled = false;
        var d = res.d;
        if (!d || !d.ok) {
          if (res.status === 409 && typeof d.serverIdx === "number") {
            br.idx = d.serverIdx; // resume from server truth
            renderBrItem();
            return;
          }
          if (d && d.error === "round closed") { startBr(); return; } // round rolled over → jump into the new one
          el.brHint.textContent = "Something went wrong — try again.";
          return;
        }
        var r = closerEval(guess, br.unit[br.idx].p);
        el.brHint.textContent = r.win ? "✅ Within 5% — great bid!" : (r.cls === "cl-yellow" ? "🟨 " + Math.round(r.pct) + "% off" : "🟥 " + Math.round(r.pct) + "% off");
        br.idx = d.idx;
        brRefreshFromPayload(d);
        if (br.idx >= 5) {
          track("game_complete", "br", String(d.total));
          brShowFinished(d);
        }
        else renderBrItem();
        renderBrBoard(d.leaders, d.players);
      })
      .catch(function () {
        el.brGuessBtn.disabled = false;
        el.brHint.textContent = "Network hiccup — try again.";
      });
  }

  function brShowFinished(d) {
    el.brInputRow.hidden = true;
    el.brResult.hidden = false;
    if (d) {
      brLastTotal = d.total;
      el.brResultTier.textContent = "🏁 Unit posted: " + d.total + "/500 — rank #" + d.rank + " of " + d.players;
      el.brResultTier.className = "reveal-tier " + (d.total >= 350 ? "t-green" : d.total >= 250 ? "t-yellow" : "t-red");
      var line = "Stick around — the live board keeps updating until the round ends.";
      if (brChallenge) {
        line = d.total >= brChallenge
          ? "🎉 You beat your friend's " + brChallenge + "/500! Challenge someone else."
          : "😖 Your friend scored " + brChallenge + " — another round starts every 10 minutes.";
      }
      el.brResultLine.textContent = line;
    }
  }

  function brShare() {
    var score = brLastTotal || (br && brChallenge) || 0;
    var txt = "⚔️ Battle Royale on Price Guessing Game\nI scored " + score + "/500 in a live 10-minute round — think you can beat me?\nNew round every 10 minutes:\nhttps://priceguessinggame.com/?battle=" + score;
    copyText(txt, el.brShareHint);
    track("share", "br", "clipboard");
  }

  function brRefreshFromPayload(d) {
    el.brRoundLine.dataset.end = String(d.roundEnd);
  }

  function renderBrBoard(leaders, players) {
    var me = effectivePid();
    var ol = el.brBoard;
    ol.innerHTML = "";
    if (!leaders || !leaders.length) {
      var li = document.createElement("li");
      li.className = "lb-empty";
      li.textContent = "No bids yet this round — be first!";
      ol.appendChild(li);
      return;
    }
    for (var i = 0; i < leaders.length; i++) {
      var row = leaders[i];
      var li2 = document.createElement("li");
      var medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1);
      var isMe = row.player_id === me;
      if (isMe) li2.className = "lb-me";
      li2.innerHTML = '<span class="lb-rank"></span><span class="lb-name"></span><span class="lb-meta"></span><span class="lb-pts"></span>';
      li2.querySelector(".lb-rank").textContent = medal;
      li2.querySelector(".lb-name").textContent = (row.name || "Anonymous") + (isMe ? " (you)" : "") + (row.alive ? " 🔴" : "");
      li2.querySelector(".lb-meta").textContent = row.idx + "/5";
      li2.querySelector(".lb-pts").textContent = row.total + " pts";
      ol.appendChild(li2);
    }
  }

  function brRefreshBoard() {
    if (!br) return;
    // local countdown tick
    var endEl = el.brRoundLine;
    fetch(apiBase() + "/api/br/state?round=" + br.round + "&pid=" + encodeURIComponent(effectivePid()), fetchOpts())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok) return;
        if (d.round !== br.round) { startBr(); return; } // round rolled over mid-play
        el.brRoundLine.dataset.end = String(d.roundEnd);
        renderBrBoard(d.leaders, d.players);
        if (d.me && d.me.idx >= 5 && br.idx < 5) { br.idx = 5; brShowFinished(); }
      })
      .catch(function () {});
  }

  // countdown display tick (1s, purely visual)
  setInterval(function () {
    if (el.brCard.hidden) return;
    var end = parseInt(el.brRoundLine.dataset.end || "0", 10);
    if (!end) return;
    var ms = end - Date.now();
    if (ms <= 0) { el.brRoundLine.textContent = "Round over — starting next round…"; return; }
    var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    el.brRoundLine.textContent = "⏱ Round ends in " + m + ":" + brPad(s);
  }, 1000);

  function exitBr() {
    maybeAbandon();
    brStopTimers();
    el.brCard.hidden = true;
    startUnit(dailyDate, "daily");
  }

  // ---------- Rummage mode (sealed unit → pull finds one by one) ----------
  var rummagePrefix = "pgg_rummage_";
  var rg = null; // {day,seed,unit,clues,rng,bid,idx,recovered,pulls,offered,phase,counted,bonus,pendingOffer}
  var rgBusy = false;
  var RG_CLUES = {
    Electronics: ["A nest of black cables by the roller door.", "A faded big-box store bag on the floor."],
    Collectibles: ["Cardboard boxes marked COLLECT in Sharpie.", "A cracked display case in the back corner."],
    Tools: ["The unit smells like motor oil.", "A pegboard, half the hooks empty."],
    Home: ["A stack of kitchen boxes, tape yellowed.", "Something heavy under a moving blanket."],
    Outdoors: ["A tent bag leaking poles.", "Muddy boots by the threshold."],
    Music: ["A gig bag leaning on the wall.", "Foam padding — something fragile."],
    Toys: ["A bin of mixed plastic, sun-faded.", "Torn Christmas wrap from years ago."],
    Fashion: ["A garment bag still zipped.", "Dusty shoe boxes, one lid off."],
    Misc: ["Unlabeled totes stacked three high.", "A tarp covering the left wall."]
  };

  function rummageClues(unit, rng) {
    var clues = [];
    var seen = {};
    var i, cat, pool, total = 0;
    for (i = 0; i < unit.length; i++) {
      total += unit[i].p;
      cat = unit[i].c;
      if (seen[cat]) continue;
      seen[cat] = true;
      pool = RG_CLUES[cat] || RG_CLUES.Misc;
      clues.push(pool[Math.floor(rng() * pool.length)]);
    }
    if (total > 2500) clues.unshift("Packed to the ceiling. The padlock was still warm.");
    else if (total > 900) clues.unshift("A 10×10, stacked halfway, dust in the air.");
    else clues.unshift("A 10×5 from the hallway. Looks half empty.");
    return clues.slice(0, 3);
  }

  function rummageOfferAmt(it, rng) {
    var band = rng();
    var mult = band < 0.28 ? (0.42 + rng() * 0.38)
      : band < 0.72 ? (0.88 + rng() * 0.28)
      : (1.35 + rng() * 1.85);
    return Math.max(8, Math.round(it.p * mult / 5) * 5);
  }

  function rummageWantOffer(it, idx, rng, offered) {
    if (offered >= 2) return false;
    if (idx === ITEMS_PER_UNIT - 1 && offered === 0) return true;
    if (it.p >= 350) return rng() < 0.7;
    return rng() < 0.32;
  }

  function rgReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function persistRg() {
    if (!rg || rg.bonus || rg.bid == null) return;
    try {
      localStorage.setItem(rummagePrefix + rg.day, JSON.stringify({
        bid: rg.bid, pulls: rg.pulls, counted: rg.counted
      }));
    } catch (e) {}
  }

  function rgTrueTotal() {
    var t = 0, i;
    for (i = 0; i < rg.unit.length; i++) t += rg.unit[i].p;
    return t;
  }

  function rgRenderPnl() {
    if (!rg || rg.bid == null) return;
    el.rgPaid.textContent = fmtMoney(rg.bid);
    el.rgRec.textContent = fmtMoney(rg.recovered);
    var pnl = rg.recovered - rg.bid;
    if (pnl > 0) { el.rgPnlVal.textContent = "P&L +" + fmtMoney(pnl); el.rgPnlVal.className = "rg-pnl-num t-green"; }
    else if (pnl < 0) { el.rgPnlVal.textContent = "P&L −" + fmtMoney(-pnl); el.rgPnlVal.className = "rg-pnl-num t-red"; }
    else { el.rgPnlVal.textContent = "P&L even"; el.rgPnlVal.className = "rg-pnl-num"; }
  }

  function rgRenderStats() {
    var s = statsLoad();
    var r = s.rummage;
    el.rgStatsLine.textContent = r && r.played
      ? "🔥 Streak " + (r.streak || 0) + " · " + (r.wins || 0) + "/" + r.played + " in the black" +
        (r.best != null ? " · Best haul " + (r.best >= 0 ? "+" : "−") + fmtMoney(Math.abs(r.best)) : "")
      : "";
  }

  function startRummage(bonus) {
    maybeAbandon();
    brStopTimers();
    el.itemCard.hidden = true; el.revealCard.hidden = true; el.resultsCard.hidden = true;
    el.countdown.hidden = true; el.closerCard.hidden = true; el.brCard.hidden = true;
    el.rummageCard.hidden = false;
    el.progress.hidden = true;
    rgBusy = false;

    var d = dailyDate || new Date();
    var day = dateKey(d);
    var seed = bonus ? ("rummage-bonus-" + Date.now() + "-" + Math.floor(Math.random() * 1e9))
      : ("rummage-" + day);
    var rng = mulberry32(hashStr(seed + "-clues"));
    rg = {
      day: day, seed: seed, unit: buildUnit(seed), rng: mulberry32(hashStr(seed + "-offers")),
      bid: null, idx: 0, recovered: 0, pulls: [], offered: 0,
      phase: "bid", counted: false, bonus: !!bonus, pendingOffer: 0
    };
    rg.clues = rummageClues(rg.unit, rng);

    if (!bonus) {
      try {
        var saved = JSON.parse(localStorage.getItem(rummagePrefix + day));
        if (saved && typeof saved.bid === "number") {
          rg.bid = saved.bid;
          rg.pulls = Array.isArray(saved.pulls) ? saved.pulls : [];
          rg.counted = !!saved.counted;
          rg.idx = rg.pulls.length;
          rg.recovered = 0;
          for (var i = 0; i < rg.pulls.length; i++) rg.recovered += rg.pulls[i].amount;
        }
      } catch (e) {}
    }

    el.rgShareHint.textContent = "";
    el.rgHint.textContent = "";
    el.unitTitle.textContent = bonus ? "Bonus Rummage ♻️" : "Rummage — Sealed Unit";
    el.unitDate.textContent = fmtDate(d);
    rgRenderStats();

    if (rg.idx >= ITEMS_PER_UNIT && rg.bid != null) {
      rgShowResult();
      return;
    }
    if (rg.bid != null) {
      rgStartDig(true);
      return;
    }
    rgShowBid();
    track("game_start", "rummage", bonus ? "bonus" : day);
  }

  function rgShowBid() {
    rg.phase = "bid";
    el.rgBidPhase.hidden = false;
    el.rgDigPhase.hidden = true;
    el.rgResult.hidden = true;
    el.rgUnitName.textContent = rg.bonus ? "Sealed Bonus Unit" : "Today's Sealed Unit";
    el.rgClues.innerHTML = "";
    for (var i = 0; i < rg.clues.length; i++) {
      var li = document.createElement("li");
      li.textContent = rg.clues[i];
      el.rgClues.appendChild(li);
    }
    el.rgInput.value = "";
    setTimeout(function () { el.rgInput.focus(); }, 60);
  }

  function rgLockBid() {
    if (!rg || rg.phase !== "bid") return;
    var raw = el.rgInput.value.trim();
    if (!/^\d{1,7}$/.test(raw)) {
      el.rgHint.textContent = "Enter a whole dollar amount, e.g. 800.";
      el.rgInput.focus();
      return;
    }
    rg.bid = parseInt(raw, 10);
    persistRg();
    rgStartDig(false);
  }

  function rgStartDig(resuming) {
    rg.phase = "dig";
    el.rgBidPhase.hidden = true;
    el.rgResult.hidden = true;
    el.rgDigPhase.hidden = false;
    el.rgFind.hidden = true;
    el.rgOffer.hidden = true;
    el.rgPullBtn.hidden = false;
    el.rgPullBtn.disabled = false;
    el.rgPullBtn.textContent = rg.idx === 0 ? "Crack it open — first find →" : "Pull next find →";
    el.rgRemain.textContent = (ITEMS_PER_UNIT - rg.idx) + " left in the unit";
    rgRenderPnl();
    if (resuming && rg.pulls.length) {
      var last = rg.unit[rg.idx - 1];
      if (last) {
        el.rgFind.hidden = false;
        el.rgFindEmoji.textContent = last.e;
        el.rgFindName.textContent = last.n;
        el.rgFindDesc.textContent = last.d + " (" + last.c + ")";
        el.rgFindPrice.textContent = fmtMoney(last.p);
        el.rgFindNote.textContent = "Last find — keep digging.";
      }
    }
  }

  function rgPull() {
    if (!rg || rgBusy || rg.phase !== "dig") return;
    if (rg.idx >= ITEMS_PER_UNIT) { rgShowResult(); return; }
    rgBusy = true;
    el.rgPullBtn.disabled = true;
    el.rgOffer.hidden = true;
    el.rgFind.hidden = true;
    el.rgFindNote.textContent = "";
    el.rgFindPrice.textContent = "";
    el.rgCrateDig.classList.remove("rg-shake");
    void el.rgCrateDig.offsetWidth;
    el.rgCrateDig.classList.add("rg-shake");
    var delay = rgReducedMotion() ? 0 : 420;
    var token = rg;
    setTimeout(function () {
      if (rg !== token || rg.phase !== "dig") { rgBusy = false; return; }
      rgRevealFind();
    }, delay);
  }

  function rgRevealFind() {
    if (!rg || rg.phase !== "dig") { rgBusy = false; return; }
    var it = rg.unit[rg.idx];
    el.rgFind.hidden = false;
    el.rgFind.classList.remove("rg-find-pop");
    void el.rgFind.offsetWidth;
    el.rgFind.classList.add("rg-find-pop");
    el.rgFindEmoji.textContent = it.e;
    el.rgFindName.textContent = it.n;
    el.rgFindDesc.textContent = it.d + " (" + it.c + ")";
    el.rgFindPrice.textContent = "";
    el.rgFindNote.textContent = "What's it worth?";
    el.rgRemain.textContent = (ITEMS_PER_UNIT - rg.idx) + " still in the unit";
    var offer = rummageWantOffer(it, rg.idx, rg.rng, rg.offered) ? rummageOfferAmt(it, rg.rng) : 0;
    rg.pendingOffer = offer;
    if (offer) {
      rg.offered++;
      rg.phase = "offer";
      el.rgOffer.hidden = false;
      el.rgOfferText.textContent = "A picker walks over. “I’ll take it off your hands for " +
        fmtMoney(offer) + ". Right now.” Market hasn’t been called.";
      el.rgPullBtn.hidden = true;
      rgBusy = false;
    } else {
      var pause = rgReducedMotion() ? 0 : 280;
      var token = rg;
      setTimeout(function () {
        if (rg !== token) { rgBusy = false; return; }
        rgCommitFind(false, it.p);
      }, pause);
    }
  }

  function rgSell() {
    if (!rg || rg.phase !== "offer") return;
    rgCommitFind(true, rg.pendingOffer);
  }

  function rgKeep() {
    if (!rg || rg.phase !== "offer") return;
    rgCommitFind(false, rg.unit[rg.idx].p);
  }

  function rgCommitFind(sold, amount) {
    if (!rg || (rg.phase !== "dig" && rg.phase !== "offer")) return;
    var it = rg.unit[rg.idx];
    rg.pulls.push({ sold: sold, amount: amount, market: it.p });
    rg.recovered += amount;
    el.rgFindPrice.textContent = fmtMoney(it.p);
    var delta = amount - it.p;
    if (sold) {
      el.rgFindNote.textContent = delta >= 0
        ? "Sold for " + fmtMoney(amount) + " · market " + fmtMoney(it.p) + " · beat the lot by " + fmtMoney(delta)
        : "Sold for " + fmtMoney(amount) + " · market " + fmtMoney(it.p) + " · left " + fmtMoney(-delta) + " on the table";
    } else {
      el.rgFindNote.textContent = "Market " + fmtMoney(it.p) + " — added to the haul.";
    }
    rg.idx++;
    persistRg();
    rgRenderPnl();
    rg.phase = "dig";
    rgBusy = false;
    el.rgOffer.hidden = true;
    if (rg.idx >= ITEMS_PER_UNIT) {
      el.rgPullBtn.hidden = true;
      el.rgRemain.textContent = "Unit's empty.";
      setTimeout(rgShowResult, rgReducedMotion() ? 0 : 700);
    } else {
      el.rgPullBtn.hidden = false;
      el.rgPullBtn.disabled = false;
      el.rgPullBtn.textContent = "Pull next find →";
      el.rgRemain.textContent = (ITEMS_PER_UNIT - rg.idx) + " left in the unit";
    }
  }

  function rgShowResult() {
    if (!rg) return;
    rg.phase = "done";
    el.rgBidPhase.hidden = true;
    el.rgDigPhase.hidden = true;
    el.rgResult.hidden = false;
    var pnl = rg.recovered - rg.bid;
    var trueTotal = rgTrueTotal();
    var closeness = scoreItem(rg.bid, trueTotal);
    if (pnl > 0) {
      el.rgResultTier.textContent = "💰 In the black";
      el.rgResultTier.className = "reveal-tier t-green";
    } else if (pnl < 0) {
      el.rgResultTier.textContent = "💸 Rough unit";
      el.rgResultTier.className = "reveal-tier t-red";
    } else {
      el.rgResultTier.textContent = "Even money";
      el.rgResultTier.className = "reveal-tier t-yellow";
    }
    el.rgResultScore.textContent = (pnl >= 0 ? "+" : "−") + fmtMoney(Math.abs(pnl));
    el.rgResultLine.textContent = "Paid " + fmtMoney(rg.bid) + " · hauled " + fmtMoney(rg.recovered) +
      " · true market " + fmtMoney(trueTotal) + " · bid was " +
      (closeness.diffPct < 0.5 ? "<1%" : Math.round(closeness.diffPct) + "%") + " off";
    el.rgResultList.innerHTML = "";
    for (var j = 0; j < rg.unit.length; j++) {
      var pull = rg.pulls[j];
      var li = document.createElement("li");
      var mark = pull && pull.sold ? (pull.amount >= pull.market ? "💰" : "😬") : "📦";
      li.innerHTML = '<span class="rl-emoji"></span><span class="rl-name"></span><span class="rl-pts"></span>';
      li.querySelector(".rl-emoji").textContent = mark;
      li.querySelector(".rl-name").textContent = rg.unit[j].n;
      li.querySelector(".rl-pts").textContent = pull
        ? (pull.sold ? "sold " + fmtMoney(pull.amount) : fmtMoney(rg.unit[j].p))
        : fmtMoney(rg.unit[j].p);
      el.rgResultList.appendChild(li);
    }
    if (!rg.counted && !rg.bonus) {
      rg.counted = true;
      persistRg();
      updateRummageStats(pnl);
      track("game_complete", "rummage", String(pnl));
    } else if (rg.bonus && !rg.counted) {
      rg.counted = true;
      track("game_complete", "rummage", "bonus:" + pnl);
    }
    rgRenderStats();
  }

  function updateRummageStats(pnl) {
    var s = statsLoad();
    var r = s.rummage = s.rummage || { played: 0, wins: 0, streak: 0, maxStreak: 0, best: null };
    r.played++;
    if (pnl > 0) {
      r.wins++;
      var y = new Date(); y.setDate(y.getDate() - 1);
      r.streak = (s.lastRummage === dateKey(y)) ? (r.streak || 0) + 1 : 1;
      if ((r.streak || 0) > (r.maxStreak || 0)) r.maxStreak = r.streak;
    } else {
      r.streak = 0;
    }
    if (r.best == null || pnl > r.best) r.best = pnl;
    s.lastRummage = rg.day;
    statsSave(s);
  }

  function rgShare() {
    if (!rg) return;
    var pnl = rg.recovered - rg.bid;
    var rows = "";
    for (var i = 0; i < rg.pulls.length; i++) {
      var p = rg.pulls[i];
      rows += p.sold ? (p.amount >= p.market ? "💰" : "😬") : "📦";
    }
    var head = "🏷️ Price Guessing Game — Rummage #" + Math.max(1, puzzleNum(dailyDate || new Date()));
    var txt = head + "\n" + rows + "\nPaid " + fmtMoney(rg.bid) + " · hauled " + fmtMoney(rg.recovered) +
      " · P&L " + (pnl >= 0 ? "+" : "−") + fmtMoney(Math.abs(pnl)) +
      "\nCrack a sealed unit:\nhttps://priceguessinggame.com";
    copyText(txt, el.rgShareHint);
    track("share", "rummage", "clipboard");
  }

  function exitRummage() {
    maybeAbandon();
    el.rummageCard.hidden = true;
    el.progress.hidden = false;
    startUnit(dailyDate, "daily");
  }

  // ---------- State ----------
  var mode = "daily";           // "daily" | "bonus"
  var date = null;              // puzzle date
  var unit = [];                // current items
  var idx = 0;                  // current item index
  var guesses = [];             // numbers
  var results = [];             // scoreItem results
  var finished = false;

  function statsLoad() {
    try { return JSON.parse(localStorage.getItem(STORAGE_STATS)) || {}; }
    catch (e) { return {}; }
  }
  function statsSave(s) { localStorage.setItem(STORAGE_STATS, JSON.stringify(s)); }

  // ---------- DOM refs ----------
  var el = {
    unitTitle: $("unit-title"), unitDate: $("unit-date"), progress: $("progress"),
    itemCard: $("item-card"), itemEmoji: $("item-emoji"), itemName: $("item-name"), itemDesc: $("item-desc"),
    bidInput: $("bid-input"), bidBtn: $("bid-btn"), bidHint: $("bid-hint"),
    revealCard: $("reveal-card"), revealTier: $("reveal-tier"), revealPrice: $("reveal-price"),
    revealGuess: $("reveal-guess"), revealDiff: $("reveal-diff"), revealLabel: $("reveal-label"),
    revealScore: $("reveal-score"), nextBtn: $("next-btn"),
    resultsCard: $("results-card"), resultsTitle: $("results-title"), resultsScore: $("results-score"),
    resultsList: $("results-list"), shareBtn: $("share-btn"), shareHint: $("share-hint"),
    bonusBtn: $("bonus-btn"), countdown: $("countdown"), countdownTime: $("countdown-time"),
    statsBar: $("stats"), statStreak: $("stat-streak"), statPlayed: $("stat-played"), statBest: $("stat-best"),
    rankLine: $("rank-line"), nameChip: $("name-chip"),
    lbWrap: $("lb-wrap"), lbStats: $("lb-stats"), lbToday: $("lb-today"), lbAlltime: $("lb-alltime"),
    closerModeBtn: $("closer-mode-btn"),
    closerCard: $("closer-card"), closerEmoji: $("closer-emoji"), closerName: $("closer-name"),
    closerDesc: $("closer-desc"), closerInputRow: $("closer-input-row"), closerInput: $("closer-input"),
    closerGuessBtn: $("closer-guess-btn"), closerHint: $("closer-hint"), closerHistory: $("closer-history"),
    closerResult: $("closer-result"), closerResultTier: $("closer-result-tier"), closerReal: $("closer-real"),
    closerResultLine: $("closer-result-line"), closerShareBtn: $("closer-share-btn"),
    closerShareHint: $("closer-share-hint"), closerStatsLine: $("closer-stats-line"), closerBackBtn: $("closer-back-btn"),
    closerDist: $("closer-dist"), brModeBtn: $("br-mode-btn"),
    brCard: $("br-card"), brRoundLine: $("br-round-line"), brEmoji: $("br-emoji"), brName: $("br-name"),
    brDesc: $("br-desc"), brInputRow: $("br-input-row"), brProg: $("br-prog"), brInput: $("br-input"),
    brGuessBtn: $("br-guess-btn"), brHint: $("br-hint"), brResult: $("br-result"),
    brResultTier: $("br-result-tier"), brResultLine: $("br-result-line"),
    brShareBtn: $("br-share-btn"), brShareHint: $("br-share-hint"), brChallenge: $("br-challenge"),
    brBoard: $("br-board"), brBackBtn: $("br-back-btn"),
    rummageModeBtn: $("rummage-mode-btn"), rummageCard: $("rummage-card"),
    rgBidPhase: $("rg-bid-phase"), rgCrate: $("rg-crate"), rgUnitName: $("rg-unit-name"),
    rgClues: $("rg-clues"), rgInput: $("rg-input"), rgBidBtn: $("rg-bid-btn"), rgHint: $("rg-hint"),
    rgDigPhase: $("rg-dig-phase"), rgPaid: $("rg-paid"), rgRec: $("rg-rec"), rgPnlVal: $("rg-pnl-val"),
    rgCrateDig: $("rg-crate-dig"), rgRemain: $("rg-remain"),
    rgFind: $("rg-find"), rgFindEmoji: $("rg-find-emoji"), rgFindName: $("rg-find-name"),
    rgFindDesc: $("rg-find-desc"), rgFindPrice: $("rg-find-price"), rgFindNote: $("rg-find-note"),
    rgOffer: $("rg-offer"), rgOfferText: $("rg-offer-text"), rgSellBtn: $("rg-sell-btn"),
    rgKeepBtn: $("rg-keep-btn"), rgPullBtn: $("rg-pull-btn"),
    rgResult: $("rg-result"), rgResultTier: $("rg-result-tier"), rgResultScore: $("rg-result-score"),
    rgResultLine: $("rg-result-line"), rgResultList: $("rg-result-list"),
    rgShareBtn: $("rg-share-btn"), rgShareHint: $("rg-share-hint"), rgAgainBtn: $("rg-again-btn"),
    rgStatsLine: $("rg-stats-line"), rgBackBtn: $("rg-back-btn")
  };

  // Current visible mode for abandon/share (daily/bonus live in `mode`; closer/br are overlays).
  function playMode() {
    if (el.rummageCard && !el.rummageCard.hidden && rg) return "rummage";
    if (el.closerCard && !el.closerCard.hidden && closer) return "closer";
    if (el.brCard && !el.brCard.hidden && br) return "br";
    return mode;
  }

  // Fire once per in-progress session: not finished, and at least one bid/guess made.
  function maybeAbandon() {
    try {
      var m = playMode();
      if (m === "rummage") {
        if (rg && rg.phase !== "done" && rg.bid != null && rg.idx < ITEMS_PER_UNIT) {
          track("round_abandon", "rummage", String(rg.idx));
          rg.phase = "done";
        }
        return;
      }
      if (m === "closer") {
        if (closer && !closer.done && closer.guesses && closer.guesses.length) {
          track("round_abandon", "closer", String(closer.guesses.length));
          closer.done = true;
        }
        return;
      }
      if (m === "br") {
        if (br && br.idx > 0 && br.idx < 5 && !br.done) {
          track("round_abandon", "br", String(br.idx));
          br.done = true;
        }
        return;
      }
      if (!finished && guesses && guesses.length) {
        track("round_abandon", mode, String(results.length || guesses.length));
        guesses = [];
        results = [];
      }
    } catch (e) { /* analytics must never break the game */ }
  }

  // ---------- Progress dots ----------
  function renderProgress() {
    el.progress.innerHTML = "";
    for (var i = 0; i < ITEMS_PER_UNIT; i++) {
      var dot = document.createElement("span");
      dot.className = "dot" + (i < results.length ? " dot-" + results[i].tier.cls : "") + (i === idx && !finished ? " dot-current" : "");
      el.progress.appendChild(dot);
    }
  }

  // ---------- Item rendering ----------
  function showItem() {
    var it = unit[idx];
    el.itemCard.hidden = false;
    el.revealCard.hidden = true;
    el.resultsCard.hidden = true;
    el.itemEmoji.textContent = it.e;
    el.itemName.textContent = it.n;
    el.itemDesc.textContent = it.d + " (" + it.c + ")";
    el.bidInput.value = "";
    el.bidHint.textContent = "";
    renderProgress();
    setTimeout(function () { el.bidInput.focus(); }, 60);
  }

  function submitBid() {
    var raw = el.bidInput.value.trim();
    if (!/^\d{1,7}$/.test(raw)) {
      el.bidHint.textContent = "Enter a whole dollar amount, e.g. 250.";
      el.bidInput.focus();
      return;
    }
    var guess = parseInt(raw, 10);
    var it = unit[idx];
    var r = scoreItem(guess, it.p);
    guesses.push(guess);
    results.push(r);

    el.itemCard.hidden = true;
    el.revealCard.hidden = false;
    el.revealTier.textContent = r.tier.emoji + " " + r.tier.label;
    el.revealTier.className = "reveal-tier " + r.tier.cls;
    el.revealPrice.textContent = fmtMoney(it.p);
    el.revealGuess.textContent = fmtMoney(guess);
    el.revealDiff.textContent = r.diffPct < 0.5 ? "<1%" : Math.round(r.diffPct) + "%";
    el.revealScore.textContent = "+" + r.score + " pts";
    el.nextBtn.textContent = idx === ITEMS_PER_UNIT - 1 ? "See Results →" : "Next Item →";
    renderProgress();
  }

  function nextStep() {
    idx++;
    if (idx < ITEMS_PER_UNIT) { showItem(); }
    else { finishUnit(); }
  }

  // ---------- Results / share ----------
  function finishUnit(opts) {
    finished = true;
    var total = 0, greens = 0;
    for (var i = 0; i < results.length; i++) { total += results[i].score; if (results[i].diffPct <= 10) greens++; }

    el.itemCard.hidden = true;
    el.revealCard.hidden = true;
    el.resultsCard.hidden = false;
    el.resultsTitle.textContent = total >= 450 ? "Auction Master! 🏆" :
      total >= 350 ? "Sharp Eye! 🎯" :
      total >= 250 ? "Not Bad! 👍" : "Rough Unit! 😅";
    el.resultsScore.textContent = total + " / 500";
    el.rankLine.hidden = true;

    el.resultsList.innerHTML = "";
    for (var j = 0; j < unit.length; j++) {
      var li = document.createElement("li");
      li.innerHTML = '<span class="rl-emoji">' + results[j].tier.emoji + '</span>' +
        '<span class="rl-name"></span>' +
        '<span class="rl-pts">' + results[j].score + '</span>';
      li.querySelector(".rl-name").textContent = unit[j].n + " — " + fmtMoney(unit[j].p);
      el.resultsList.appendChild(li);
    }

    if (mode === "daily") {
      saveDailyResult(total);
      updateStats(total);
      startCountdown();
      submitScore();
    } else {
      el.countdown.hidden = true;
      el.rankLine.hidden = true;
    }
    renderStats();
    if (!opts || !opts.restored) track("game_complete", mode, String(total));
  }

  function shareText() {
    var total = 0, rows = "";
    for (var i = 0; i < results.length; i++) { total += results[i].score; rows += results[i].tier.emoji; }
    var head = mode === "daily"
      ? "🏷️ Price Guessing Game #" + puzzleNum(date)
      : "🏷️ Price Guessing Game (Bonus Unit)";
    return head + "\n" + rows + "  " + total + "/500\nCan you guess the price?\nhttps://priceguessinggame.com";
  }

  function share() {
    copyText(shareText(), el.shareHint);
    track("share", mode, "clipboard");
  }

  function copyText(txt, hintEl) {
    function done() { hintEl.textContent = "Copied! Paste it anywhere — no spoilers included."; }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); }
      catch (e) { hintEl.textContent = "Copy failed — select the text below:\n" + txt; }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, fallback);
    } else { fallback(); }
  }

  // ---------- Daily persistence & streak ----------
  function dailyKey() { return dailyPrefix + dateKey(date); }

  function saveDailyResult(total) {
    localStorage.setItem(dailyKey(), JSON.stringify({ guesses: guesses, results: results.map(function (r) { return r.score; }), total: total }));
  }

  function updateStats(total) {
    var s = statsLoad();
    var today = dateKey(date);
    if (s.lastPuzzle === today) { return; } // already counted (replay guard)
    s.played = (s.played || 0) + 1;
    // streak: yesterday → +1; today skip handled above; anything else → reset to 1
    var y = new Date(date.getTime()); y.setDate(y.getDate() - 1);
    s.streak = (s.lastPuzzle === dateKey(y)) ? (s.streak || 0) + 1 : 1;
    if (!s.best || total > s.best) { s.best = total; }
    s.lastPuzzle = today;
    statsSave(s);
  }

  function renderStats() {
    var s = statsLoad();
    if (s.played) {
      el.statsBar.hidden = false;
      el.statStreak.textContent = s.streak || 0;
      el.statPlayed.textContent = s.played;
      el.statBest.textContent = s.best || 0;
    }
  }

  // ---------- Countdown to next local midnight ----------
  var countdownTimer = null;
  function startCountdown() {
    el.countdown.hidden = false;
    if (countdownTimer) { clearInterval(countdownTimer); }
    function tick() {
      var now = new Date();
      var mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
      var ms = mid - now;
      if (ms <= 0) { el.countdownTime.textContent = "00:00:00"; clearInterval(countdownTimer); return; }
      var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
      el.countdownTime.textContent = pad2(h) + ":" + pad2(m) + ":" + pad2(sec);
    }
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  // ---------- Unit start / restore ----------
  function startUnit(d, m) {
    maybeAbandon();
    mode = m; date = d; idx = 0; guesses = []; results = []; finished = false;
    unit = buildUnit(m === "daily" ? "daily-" + dateKey(d) : "bonus-" + d.getTime() + "-" + Math.floor(Math.random() * 1e9));

    var num = puzzleNum(d);
    el.unitTitle.textContent = m === "daily"
      ? (num >= 1 ? "Storage Unit #" + num : "Storage Unit (Preview)")
      : "Bonus Unit ♻️";
    el.unitDate.textContent = fmtDate(d) + (m === "daily" && num >= 1 ? "" : " — unlimited practice");
    el.bonusBtn.hidden = (m === "bonus");
    el.closerModeBtn.hidden = (m === "bonus");
    el.brModeBtn.hidden = (m === "bonus");
    if (el.rummageModeBtn) el.rummageModeBtn.hidden = (m === "bonus");
    el.closerCard.hidden = true;
    if (el.rummageCard) el.rummageCard.hidden = true;
    if (el.progress) el.progress.hidden = false;
    if (typeof brStopTimers === "function") brStopTimers();
    el.brCard.hidden = true;
    el.shareHint.textContent = "";
    el.rankLine.hidden = true;

    // restore finished daily (replay of today's completed puzzle shows results)
    var saved = null;
    if (m === "daily") {
      try { saved = JSON.parse(localStorage.getItem(dailyKey())); } catch (e) { saved = null; }
    }
    if (saved && saved.guesses && saved.guesses.length === ITEMS_PER_UNIT) {
      guesses = saved.guesses;
      results = [];
      for (var i = 0; i < ITEMS_PER_UNIT; i++) { results.push(scoreItem(guesses[i], unit[i].p)); }
      idx = ITEMS_PER_UNIT;
      finishUnit({ restored: true });
      // mark as replay: don't re-run updateStats (guard handles it), show share again
      return;
    }
    track("game_start", m, dateKey(d));
    showItem();
  }

  // ---------- Init ----------
  function init() {
    renderStats();

    // ?d=YYYY-MM-DD archive play
    var m = /(?:\?|&)d=(\d{4})-(\d{2})-(\d{2})/.exec(location.search);
    var d = new Date();
    if (m) {
      var arch = new Date(+m[1], +m[2] - 1, +m[3]);
      if (!isNaN(arch.getTime()) && arch < new Date(d.getFullYear(), d.getMonth(), d.getDate())) {
        d = arch;
      }
    }
    dailyDate = d;

    el.bidBtn.addEventListener("click", submitBid);
    el.bidInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submitBid(); }
    });
    el.nextBtn.addEventListener("click", nextStep);
    el.shareBtn.addEventListener("click", share);
    el.bonusBtn.addEventListener("click", function () {
      startUnit(new Date(), "bonus");
    });

    // Rummage mode
    el.rummageModeBtn.addEventListener("click", function () { startRummage(false); });
    el.rgBidBtn.addEventListener("click", rgLockBid);
    el.rgInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); rgLockBid(); }
    });
    el.rgPullBtn.addEventListener("click", rgPull);
    el.rgSellBtn.addEventListener("click", rgSell);
    el.rgKeepBtn.addEventListener("click", rgKeep);
    el.rgShareBtn.addEventListener("click", rgShare);
    el.rgAgainBtn.addEventListener("click", function () { startRummage(true); });
    el.rgBackBtn.addEventListener("click", exitRummage);

    // Close Call mode
    el.closerModeBtn.addEventListener("click", startCloser);
    el.closerGuessBtn.addEventListener("click", closerGuess);
    el.closerInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); closerGuess(); }
    });
    el.closerBackBtn.addEventListener("click", exitCloser);
    el.closerShareBtn.addEventListener("click", closerShare);

    // Battle Royale mode
    el.brModeBtn.addEventListener("click", startBr);
    el.brGuessBtn.addEventListener("click", brGuess);
    el.brInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); brGuess(); }
    });
    el.brBackBtn.addEventListener("click", exitBr);
    el.brShareBtn.addEventListener("click", brShare);

    function refreshNameChip() {
      if (auth.user && auth.user.name) {
        el.nameChip.textContent = "Playing as " + auth.user.name + " ✅";
        el.nameChip.title = "Signed in with Google — sign out from the header";
      } else {
        el.nameChip.textContent = "Playing as " + nameGet() + " ✏️";
        el.nameChip.title = "Change your bidder name";
      }
    }
    el.nameChip.addEventListener("click", function () {
      if (auth.user) return; // Google-signed-in name comes from the Google profile
      var n = prompt("Your bidder name (max 24 characters):", nameGet());
      if (n !== null) { nameSet(n); refreshNameChip(); }
    });
    var logoutBtn = $("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", signOut);
    refreshNameChip();
    loadLeaderboard();
    initAuth();

    startUnit(d, "daily");

    window.addEventListener("pagehide", maybeAbandon);

    // ?battle=N invite link → drop straight into Battle Royale with the friend's score
    var bm = /(?:\?|&)battle=(\d{1,3})/.exec(location.search);
    if (bm) {
      brChallenge = Math.min(500, parseInt(bm[1], 10) || 0);
      startBr();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
