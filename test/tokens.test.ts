// Estimasi token: karakter pasti + ≈3,5 char/token.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, addRun, emptyUsage, totalTok, fmtTok } from "../src/tokens.js";

describe("tokens", () => {
  it("estimateTokens: kosong 0, 35 char → 10", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("x".repeat(35)), 10);
    assert.equal(estimateTokens("xy"), 1);
  });
  it("addRun akumulasi runs + in/out", () => {
    const u = emptyUsage();
    addRun(u, 35, 70);
    addRun(u, 0, 7);
    assert.equal(u.runs, 2);
    assert.equal(u.charsIn, 35);
    assert.equal(u.tokIn, 10);
    assert.equal(u.tokOut, 22);
    assert.equal(totalTok(u), 32);
  });
  it("fmtTok: 950 / 1.5k", () => {
    assert.equal(fmtTok(950), "950");
    assert.equal(fmtTok(1500), "1.5k");
  });
});
