// Pewarna sintaks panel review: deteksi bahasa, warna token, aman dari HTML.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escHtml, langOf, highlightCode } from "../web/src/highlight.js";

describe("langOf", () => {
  it("memetakan ekstensi umum", () => {
    assert.equal(langOf("src/index.ts"), "ts");
    assert.equal(langOf("web/src/App.svelte"), "svelte");
    assert.equal(langOf("web/src/app.css"), "css");
    assert.equal(langOf("bot.py"), "py");
    assert.equal(langOf("deploy.sh"), "sh");
    assert.equal(langOf("query.sql"), "sql");
    assert.equal(langOf("data.yml"), "hash");
    assert.equal(langOf("README.md"), "prose");
    assert.equal(langOf("Dockerfile"), "hash");
  });
  it("fallback ke c untuk ekstensi tak dikenal", () => {
    assert.equal(langOf("main.go"), "c");
    assert.equal(langOf("berkas.tanpaextensi/main"), "c");
  });
});

describe("highlightCode", () => {
  it("mewarnai keyword, string, angka, komentar, dan fungsi", () => {
    const html = highlightCode("import x from \"y\";\n// halo\nconst n = 42;\nfoo(1);", "a.ts");
    assert.match(html, /<span class="tok-kw">import<\/span>/);
    assert.match(html, /<span class="tok-str">/);
    assert.match(html, /<span class="tok-com">\/\/ halo<\/span>/);
    assert.match(html, /<span class="tok-num">42<\/span>/);
    assert.match(html, /<span class="tok-fn">foo<\/span>/);
  });
  it("membungkus tiap baris dalam .cline bernomor via CSS", () => {
    const html = highlightCode("a\nb\nc", "a.ts");
    assert.equal(html.split("\n").length, 3);
    for (const line of html.split("\n")) assert.match(line, /^<span class="cline">.*<\/span>$/);
  });
  it("span seimbang walau komentar multi-baris", () => {
    const html = highlightCode("/* satu\ndua */\nconst x = 1;", "a.js");
    const open = (html.match(/<span /g) || []).length;
    const close = (html.match(/<\/span>/g) || []).length;
    assert.equal(open, close);
    assert.match(html, /tok-com/);
  });
  it("meng-escape HTML mentah (anti-XSS via {@html})", () => {
    const html = highlightCode("<script>alert(1)</script>", "a.html");
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;/);
    assert.match(html, /<span class="tok-tag">script<\/span>/);
  });
  it("mewarnai komentar # untuk python/shell", () => {
    assert.match(highlightCode("# komen\ndef f():\n    pass", "a.py"), /<span class="tok-com"># komen<\/span>/);
    assert.match(highlightCode("def f():\n    pass", "a.py"), /<span class="tok-kw">def<\/span>/);
  });
});
