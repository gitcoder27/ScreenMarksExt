(function attachIds(root) {
  const SceneMarks = root.SceneMarks || {};

  function createId(prefix) {
    const cleanPrefix = String(prefix || "id").replace(/[^a-z0-9_-]/gi, "");

    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return `${cleanPrefix}_${root.crypto.randomUUID()}`;
    }

    const bytes = new Uint8Array(16);
    if (root.crypto && typeof root.crypto.getRandomValues === "function") {
      root.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }

    const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${cleanPrefix}_${Date.now().toString(36)}_${random}`;
  }

  SceneMarks.Ids = { createId };
  root.SceneMarks = SceneMarks;
})(globalThis);
