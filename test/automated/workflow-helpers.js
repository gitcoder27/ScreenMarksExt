"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createStorageArea } = require("./helpers");
const ROOT = path.join(__dirname, "../..");

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.className = "";
    this.attributes = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((item) => item !== fn); }
  async emit(name, event = {}) {
    const payload = { target: this, preventDefault() {}, stopImmediatePropagation() {}, ...event };
    for (const listener of this.listeners[name] || []) await listener(payload);
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  closest(selector) { return selector.split(",").some((part) => part.trim().toUpperCase() === this.tagName) ? this : null; }
  focus() {}
  blur() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  showPopover() {}
  hidePopover() {}
  setPointerCapture() {}
}

function createDom() {
  const elements = new Map();
  const document = new FakeElement("document");
  document.body = new FakeElement("body");
  document.documentElement = new FakeElement("html");
  document.createElement = (tag) => new FakeElement(tag);
  document.getElementById = (id) => {
    if (!elements.has(id)) {
      const element = new FakeElement(/Input$|Hotkey$/.test(id) ? "input" : "div");
      elements.set(id, element);
    }
    return elements.get(id);
  };
  document.querySelectorAll = () => [];
  return { document, elements, get: document.getElementById };
}

function load(context, file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
}

async function flush() { for (let n = 0; n < 30; n += 1) await Promise.resolve(); }

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createWorkflow(seed = {}, options = {}) {
  const dom = createDom();
  const store = options.store || createStorageArea(seed);
  const events = new FakeElement("window");
  const changed = options.changed || [];
  const messages = [];
  const timers = new Map();
  let now = 0;
  let timerId = 0;
  const context = vm.createContext({
    console, URL, crypto, Element: FakeElement, HTMLButtonElement: FakeElement,
    document: dom.document, location: { href: "https://example.com/watch?id=A", hostname: "example.com" },
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    confirm: () => true,
    innerWidth: 1200, innerHeight: 800
  });
  const messageListeners = [];
  const realSet = store.local.set;
  if (options.manageChanges !== false) store.local.set = (values, callback) => {
    const changes = {};
    for (const [key, value] of Object.entries(values)) changes[key] = { oldValue: store.raw(key), newValue: value };
    realSet(values, callback);
    for (const listener of changed) listener(changes, "local");
  };
  store.local.getBytesInUse = async () => 0;
  context.chrome = {
    runtime: {
      id: "scenemarks", lastError: null,
      getManifest: () => ({ permissions: ["unlimitedStorage"] }),
      getURL: (relative) => `chrome-extension://scenemarks/${relative}`,
      onMessage: { addListener(fn) { messageListeners.push(fn); } },
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "SCENEMARKS_STORAGE_RPC") {
          const { method, args } = message.payload;
          const callArgs = method === "consumePendingJump" ? [args[0], args[1], 1] : args;
          const promise = context.SceneMarks.Storage[method](...callArgs).then((result) => ({ ok: true, result }));
          if (callback) { promise.then(callback); return; }
          return promise;
        }
        const result = message.type === "SCENEMARKS_GET_TAB_ID" ? { ok: true, tabId: 1 } : { ok: true };
        if (callback) callback(result);
        return Promise.resolve(result);
      }
    },
    storage: { local: store.local, onChanged: { addListener(fn) { changed.push(fn); } } },
    tabs: { query: async () => [{ id: 1, url: context.location.href }], create: async () => {} }
  };
  for (const file of ["constants", "time", "ids", "schema", "storage"]) load(context, `src/shared/${file}.js`);
  return {
    ...dom, store, events, changed, messages, timers, context,
    load: (file) => load(context, file),
    async advance(ms) {
      now += ms;
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of due) { if (timers.delete(id)) timer.fn(); }
      await flush();
    },
    async send(message, sender = {}) {
      return new Promise((resolve) => messageListeners[0](message, sender, resolve));
    }
  };
}

function keyboard(code = "KeyS", extra = {}) {
  return { code, key: code.startsWith("Key") ? code.slice(3) : code, isTrusted: true,
    ctrlKey: false, metaKey: false, altKey: true, shiftKey: true, repeat: false, ...extra };
}

module.exports = { createWorkflow, deferred, FakeElement, flush, keyboard };
