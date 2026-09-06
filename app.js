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
    el.closerEmoji.textContent = closer.item.e;
    el.closerName.textContent = closer.item.n;
    el.closerDesc.textContent = closer.item.d + " (" + closer.item.c + ")";
    el.closerInput.value = "";
    el.closerHint.textContent = "";
    el.closerShareHint.textContent = "";
    el.closerResult.hidden = true;
    el.closerCard.hidden = false;
    renderCloser();
    if (!closer.done) setTimeout(function () { el.closerInput.focus(); }, 60);
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
    }
    renderCloser();
  }

  function updateCloserStats() {
    var s = statsLoad();
    var c = s.closer = s.closer || { played: 0, wins: 0, streak: 0, maxStreak: 0, best: null };
    c.played++;
    if (closer.won) {
      c.wins++;
      var used = closer.guesses.length;
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
  }

  function exitCloser() {
    el.closerCard.hidden = true;
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
    closerShareHint: $("closer-share-hint"), closerStatsLine: $("closer-stats-line"), closerBackBtn: $("closer-back-btn")
  };

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
  function finishUnit() {
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
    mode = m; date = d; idx = 0; guesses = []; results = []; finished = false;
    unit = buildUnit(m === "daily" ? "daily-" + dateKey(d) : "bonus-" + d.getTime() + "-" + Math.floor(Math.random() * 1e9));

    var num = puzzleNum(d);
    el.unitTitle.textContent = m === "daily"
      ? (num >= 1 ? "Storage Unit #" + num : "Storage Unit (Preview)")
      : "Bonus Unit ♻️";
    el.unitDate.textContent = fmtDate(d) + (m === "daily" && num >= 1 ? "" : " — unlimited practice");
    el.bonusBtn.hidden = (m === "bonus");
    el.closerModeBtn.hidden = (m === "bonus");
    el.closerCard.hidden = true;
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
      finishUnit();
      // mark as replay: don't re-run updateStats (guard handles it), show share again
      return;
    }
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

    // Close Call mode
    el.closerModeBtn.addEventListener("click", startCloser);
    el.closerGuessBtn.addEventListener("click", closerGuess);
    el.closerInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); closerGuess(); }
    });
    el.closerBackBtn.addEventListener("click", exitCloser);
    el.closerShareBtn.addEventListener("click", closerShare);

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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
