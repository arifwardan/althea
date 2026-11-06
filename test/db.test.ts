// DB bersama: kredensial untuk app buatan + pembuatan role di pgsql lokal.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { dbInstructions, dbPassword, DEFAULT_DB_PASSWORD, roleSql, ensureDbRole } from "../src/db.js";
import { config } from "../src/config.js";

describe("dbInstructions (prompt fase pipeline)", () => {
  it("postgresql → larang install + kredensial bersama + CREATE DATABASE saja", () => {
    const s = dbInstructions("postgresql");
    assert.match(s, /NEVER install, download, or start PostgreSQL/);
    assert.match(s, new RegExp(`DB_HOST=${config.dbHost}`));
    assert.ok(s.includes(`DB_PORT=${config.dbPort}`));
    assert.ok(s.includes(`DB_USER=${config.dbUser}`));
    assert.ok(s.includes(`DB_PASSWORD=${dbPassword()}`));
    assert.match(s, /CREATEDB/);
    assert.match(s, /do NOT create roles/);
    assert.match(s, /do NOT change this password/);
  });

  it("bukan postgresql → tanpa instruksi server", () => {
    for (const db of ["sqlite", "mysql", "none", "", "  ", undefined as unknown as string]) {
      assert.equal(dbInstructions(db), "", `db=${String(db)}`);
    }
  });

  it("password stabil dalam satu proses (prompt tak berubah antar fase)", () => {
    assert.equal(dbPassword(), dbPassword());
    assert.equal(dbInstructions("postgresql"), dbInstructions("postgresql"));
  });
});

describe("roleSql", () => {
  it("idempotent: CREATE bila belum ada, ALTER + CREATEDB bila sudah", () => {
    const sql = roleSql("althea", "secret123");
    assert.match(sql, /IF NOT EXISTS/);
    assert.match(sql, /CREATE ROLE althea LOGIN PASSWORD 'secret123' CREATEDB/);
    assert.match(sql, /ALTER ROLE althea WITH LOGIN PASSWORD 'secret123' CREATEDB/);
  });

  it("kutip SQL di-escape (quote ganda)", () => {
    const sql = roleSql("althea", "p'q");
    assert.match(sql, /'p''q'/);
  });

  it("user tak valid (identifier berbahaya) → throw, tanpa SQL", () => {
    for (const bad of ["bad user", "1abc", "a;b", "x' OR '1'='1", ""]) {
      assert.throws(() => roleSql(bad, "pw"), RangeError, `user=${bad}`);
    }
  });
});

describe("dbPassword (default tetap, override lewat .env)", () => {
  let prev = "";
  beforeEach(() => { prev = config.dbPassword; });
  afterEach(() => { config.dbPassword = prev; });

  it("DB_PASSWORD kosong → default \"password\"", () => {
    config.dbPassword = "";
    assert.equal(dbPassword(), "password");
    assert.equal(dbPassword(), DEFAULT_DB_PASSWORD);
  });

  it("DB_PASSWORD terisi (env/.env) → dipakai apa adanya", () => {
    config.dbPassword = "rahasia123";
    assert.equal(dbPassword(), "rahasia123");
  });

  it("prompt pipeline memakai password default bila .env kosong", () => {
    config.dbPassword = "";
    assert.match(dbInstructions("postgresql"), /DB_PASSWORD=password\b/);
  });
});

describe("ensureDbRole (best-effort, tanpa server pun tak meledak)", () => {
  it("user tak valid → ok:false + pesan, tanpa spawn psql", async () => {
    const prev = config.dbUser;
    config.dbUser = "bad user;";
    try {
      const r = await ensureDbRole();
      assert.equal(r.ok, false);
      assert.match(r.error || "", /invalid DB_USER/);
    } finally {
      config.dbUser = prev;
    }
  });

  it("koneksi gagal → ok:false + manual TANPA password + error diredaksi", async (t) => {
    const prevPort = config.dbPort;
    const prevPw = config.dbPassword;
    config.dbPort = 1; // tak ada yang mendengarkan → semua metode gagal cepat
    config.dbPassword = "rahasiakhusus99"; // custom → wajib diredaksi di log
    try {
      const r = await ensureDbRole();
      if (r.ok) {
        t.skip("mesin ini bisa membuat role otomatis");
        return;
      }
      assert.ok(r.manual, "harus menyertakan perintah manual");
      assert.match(r.manual as string, /CREATE ROLE althea LOGIN PASSWORD '\$PW'/);
      assert.match(r.manual as string, /ALTER ROLE althea/);
      assert.match(r.manual as string, /PW=\$\{PW:-password\}/, "fallback ke default bila .env kosong");
      assert.ok(!(r.manual as string).includes("rahasiakhusus99"), "manual tak memuat password");
      assert.ok(!(r.error || "").includes("rahasiakhusus99"), "error diredaksi");
    } finally {
      config.dbPort = prevPort;
      config.dbPassword = prevPw;
    }
  });
});
