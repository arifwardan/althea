// Users: verifyAccessToken (regresi: import verifyToken yang hilang merusak kompilasi).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessToken } from "../src/users.js";

describe("verifyAccessToken", () => {
  it("menolak token sampah", () => {
    assert.equal(verifyAccessToken("bukan-token"), null);
  });
});
