"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createWorkflow } = require("./workflow-helpers");

function loadAdapters(work) {
  for (const name of ["generic", "netflix", "prime-video", "hotstar", "youtube", "index"]) {
    work.load(`src/content/site-adapters/${name}.js`);
  }
  return work.context.SceneMarks.Adapters;
}

test("generic identity preserves content queries, routes, path case, and opening URL", () => {
  const work = createWorkflow();
  const { GenericAdapter: generic } = loadAdapters(work);
  const key = (url) => generic.getVideoKey(new URL(url));
  const a = "https://example.com/watch?id=A&lang=en#/episode/One";
  const b = "https://example.com/watch?id=B&lang=en#/episode/One";
  assert.notEqual(key(a), key(b));
  assert.notEqual(key(a), key(a.replace("/One", "/Two")));
  assert.notEqual(key(a), key(a.replace("/watch", "/Watch")));
  const noisy = "https://example.com/watch?utm_source=mail&lang=en&id=A&fbclid=123#/episode/One";
  assert.equal(key(a), key(noisy));
  const canonical = generic.getCanonicalUrl(new URL(noisy));
  assert.equal(new URL(canonical).searchParams.get("id"), "A");
  assert.equal(new URL(canonical).hash, "#/episode/One");
  assert.equal(key(canonical), key(a));
  assert.notEqual(key("https://example.com/watch?ref=A"), key("https://example.com/watch?ref=B"));
});

test("manifest and fallback injection lists match and every page favicon exists", () => {
  const root = path.join(__dirname, "../..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const worker = fs.readFileSync(path.join(root, "src/background/service-worker.js"), "utf8");
  const files = [...worker.match(/const CONTENT_SCRIPT_FILES = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(files, manifest.content_scripts[0].js);
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
  for (const page of ["popup", "options", "library"]) {
    const directory = path.join(root, `src/${page}`);
    const html = fs.readFileSync(path.join(directory, `${page}.html`), "utf8");
    const icons = [...html.matchAll(/rel="icon"[^>]+href="([^"]+)"/g)];
    assert.equal(icons.length, 2);
    for (const icon of icons) assert.equal(fs.existsSync(path.resolve(directory, icon[1])), true, icon[1]);
  }
  const options = fs.readFileSync(path.join(root, "src/options/options.html"), "utf8");
  assert.doesNotMatch(options, /does not request all-site|after popup activation/);
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
});

module.exports = { loadAdapters };

test("long generic identities remain distinct and unopenable oversized URLs are refused", async () => {
  const work = createWorkflow();
  const adapters = loadAdapters(work);
  const identity = (id) => adapters.getVideoIdentity({ title: "Long URL" }, { href: `https://example.com/watch?padding=${"x".repeat(600)}&id=${id}` });
  const a = identity("A");
  const b = identity("B");
  assert.equal((await work.context.SceneMarks.Storage.saveScene(a, { startSeconds: 1 })).ok, true);
  assert.equal((await work.context.SceneMarks.Storage.saveScene(b, { startSeconds: 1 })).ok, true);
  assert.equal(Object.keys((await work.context.SceneMarks.Storage.getState()).videos).length, 2);
  const huge = adapters.getVideoIdentity({ title: "Too long" }, { href: `https://example.com/watch?id=${"x".repeat(2500)}` });
  assert.equal((await work.context.SceneMarks.Storage.saveScene(huge, { startSeconds: 1 })).ok, false);
});
