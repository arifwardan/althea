// Auth: password, sesi, rate-limit login.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createStore, createSession, validateSession, destroySession,
  verifyPassword, loginAllowed, recordLogin, isLoopback,
} from "../src/auth.js";

describe("verifyPassword", () => {
  it("benar/salah + tolak saat expected kosong", () => {
    assert.equal(verifyPassword("rahasia", "rahasia"), true);
    assert.equal(verifyPassword("salah", "rahasia"), false);
    assert.equal(verifyPassword("x", ""), false);
  });
});

describe("sesi", () => {
  it("buat → valid → hancur; kedaluwarsa ditolak", () => {
    const store = createStore();
    const t0 = Date.now();
    const tok = createSession(store, t0, 1000);
    assert.equal(validateSession(store, tok, t0 + 500), true);
    assert.equal(validateSession(store, tok, t0 + 2000), false);
    const tok2 = createSession(store, t0, 1000);
    destroySession(store, tok2);
    assert.equal(validateSession(store, tok2, t0 + 100), false);
    assert.equal(validateSession(store, "asal", t0), false);
  });
});

describe("rate-limit login", () => {
  it("5 gagal → kunci 60 dtk; sukses me-reset", () => {
    const store = createStore();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      assert.equal(loginAllowed(store, "1.2.3.4", t0), true);
      recordLogin(store, "1.2.3.4", false, t0);
    }
    assert.equal(loginAllowed(store, "1.2.3.4", t0 + 1000), false);
    assert.equal(loginAllowed(store, "1.2.3.4", t0 + 61_000), true);
    recordLogin(store, "1.2.3.4", false, t0 + 61_000);
    recordLogin(store, "1.2.3.4", true, t0 + 61_000);
    assert.equal(loginAllowed(store, "1.2.3.4", t0 + 62_000), true);
  });
});

describe("isLoopback", () => {
  it("hanya loopback", () => {
    assert.equal(isLoopback("127.0.0.1"), true);
    assert.equal(isLoopback("::1"), true);
    assert.equal(isLoopback("192.168.1.5"), false);
  });
});
