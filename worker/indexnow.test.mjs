import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "./worker.js";

const INDEXNOW_KEY = "418ec399e2124793900f12e9833f600b";
const INDEXNOW_PATH = "/" + INDEXNOW_KEY + ".txt";

function spaHtml() {
  return new Response("<!DOCTYPE html><html><title>Price Guessing Game</title></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("IndexNow key is text/plain and never the Pages SPA HTML", async () => {
  const original = globalThis.fetch;
  let proxied = null;
  globalThis.fetch = async input => {
    proxied = String(input instanceof Request ? input.url : input);
    return spaHtml();
  };
  try {
    const res = await worker.fetch(
      new Request("https://priceguessinggame.com" + INDEXNOW_PATH),
      {},
      { waitUntil() {} },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/plain\b/);
    const body = await res.text();
    assert.equal(body, INDEXNOW_KEY + "\n");
    assert.equal(body.includes("<"), false);
    assert.equal(proxied, null);

    const file = await readFile(new URL("../" + INDEXNOW_KEY + ".txt", import.meta.url), "utf8");
    assert.equal(file, INDEXNOW_KEY + "\n");
  } finally {
    globalThis.fetch = original;
  }
});

test("other missing .txt paths still proxy to Pages", async () => {
  const original = globalThis.fetch;
  let proxied = null;
  globalThis.fetch = async input => {
    proxied = String(input instanceof Request ? input.url : input);
    return spaHtml();
  };
  try {
    const res = await worker.fetch(
      new Request("https://priceguessinggame.com/not-the-indexnow-key.txt"),
      {},
      { waitUntil() {} },
    );
    assert.equal(proxied, "https://priceguessinggame.pages.dev/not-the-indexnow-key.txt");
    assert.match(res.headers.get("content-type") || "", /^text\/html\b/);
    assert.match(await res.text(), /<!DOCTYPE html>/);
  } finally {
    globalThis.fetch = original;
  }
});
