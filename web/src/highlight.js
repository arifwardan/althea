// Pewarna sintaks ringan tanpa dependensi untuk panel review.
// Dipakai web (App.svelte) dan bisa diuji langsung via node:test.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

const GENERIC_KW = [
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "default", "break", "continue", "new", "delete", "typeof",
  "instanceof", "in", "of", "try", "catch", "finally", "throw", "async", "await",
  "class", "extends", "super", "this", "static", "get", "set", "import", "export",
  "from", "default", "yield", "void", "debugger", "enum", "interface", "type",
  "implements", "public", "private", "protected", "readonly", "abstract", "as",
  "satisfies", "declare", "namespace", "package", "struct", "impl", "fn", "pub",
  "mod", "crate", "use", "mut", "ref", "self", "nil", "func", "true", "false",
  "null", "undefined", "None", "True", "False",
];

const EXTRA_KW = {
  py: ["def", "elif", "lambda", "with", "pass", "raise", "except", "global", "nonlocal", "assert", "del"],
  sh: ["then", "elif", "fi", "do", "done", "case", "esac", "function", "exit", "local", "export", "echo", "then"],
  sql: ["select", "from", "where", "join", "left", "right", "inner", "outer", "on", "group", "by", "order",
    "having", "limit", "offset", "insert", "into", "values", "update", "set", "delete", "create", "table",
    "alter", "drop", "and", "or", "not", "primary", "key", "distinct", "as", "like", "between", "exists"],
};

const EXT_LANG = {
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  svelte: "svelte", vue: "svelte", html: "svelte", htm: "svelte", xml: "svelte",
  css: "css", scss: "css", less: "css",
  json: "js", jsonc: "js",
  md: "prose", mdx: "prose", txt: "prose",
  py: "py", pyw: "py",
  sh: "sh", bash: "sh", zsh: "sh",
  yml: "hash", yaml: "hash", toml: "hash", ini: "hash", cfg: "hash", env: "hash",
  sql: "sql",
  go: "c", rs: "c", java: "c", kt: "c", php: "c", rb: "c", swift: "c",
  c: "c", h: "c", cpp: "c", hpp: "c", cs: "c",
};

const BASE_FILES = { dockerfile: "hash", makefile: "sh", justfile: "sh" };

export function langOf(path) {
  const base = String(path || "").split("/").pop().toLowerCase();
  if (BASE_FILES[base]) return BASE_FILES[base];
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";
  return EXT_LANG[ext] || "c";
}

function keywordsFor(lang) {
  const set = new Set(GENERIC_KW);
  for (const w of EXTRA_KW[lang] || []) set.add(w);
  return set;
}

const STR_DQ = '"(?:\\\\.|[^"\\\\\\n])*"';
const STR_SQ = "'(?:\\\\.|[^'\\\\\\n])*'";
const STR_TICK = "`(?:\\\\.|[^`\\\\])*`";
const STR_TRIPLE = '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'';
const NUM = "\\b\\d[\\w.]*\\b";

function patternFor(lang) {
  if (lang === "prose") return new RegExp(`(${STR_TICK}|${NUM}|[A-Za-z_$][\\w$]*)`, "g");
  if (lang === "svelte") {
    return new RegExp(
      `(<!--[\\s\\S]*?-->|${STR_DQ}|${STR_SQ}|${NUM}|[A-Za-z_][\\w:.-]*|<\\/?|\\/?>|=)`,
      "g",
    );
  }
  if (lang === "css") {
    return new RegExp(`(/\\*[\\s\\S]*?\\*/|${STR_DQ}|${STR_SQ}|@[A-Za-z-]+|${NUM}|-?[A-Za-z_][\\w-]*)`, "g");
  }
  const comment = lang === "hash" || lang === "py" || lang === "sh" || lang === "sql"
    ? (lang === "sql" ? "--[^\\n]*" : "#[^\\n]*")
    : "/\\*[\\s\\S]*?\\*/|//[^\\n]*";
  const str = lang === "py" ? `${STR_TRIPLE}|${STR_DQ}|${STR_SQ}` : `${STR_DQ}|${STR_SQ}|${STR_TICK}`;
  const ident = "[A-Za-z_$][\\w$]*";
  return new RegExp(`(${comment}|${str}|${NUM}|${ident})`, "g");
}

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

// Bungkus token yang mengandung \n agar tiap baris punya span seimbang.
function span(cls, text) {
  return `<span class="${cls}">` + escHtml(text).replace(/\n/g, `</span>\n<span class="${cls}">`) + "</span>";
}

export function highlightCode(src, path) {
  const text = String(src == null ? "" : src);
  // Berkas raksasa: tetap aman tapi tanpa pewarnaan token.
  if (text.length > 200_000) {
    return escHtml(text).split("\n").map((l) => `<span class="cline">${l || ""}</span>`).join("\n");
  }
  const lang = langOf(path);
  const kw = keywordsFor(lang);
  const re = patternFor(lang);
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    const idx = m.index;
    if (idx > last) out += escHtml(text.slice(last, idx));
    const first = tok[0];
    const second = tok.slice(0, 2);
    if (
      second === "//" || second === "/*" || first === "#" ||
      (second === "--" && lang === "sql") || tok.startsWith("<!--")
    ) {
      out += span("tok-com", tok);
    } else if (first === '"' || first === "'" || first === "`") {
      out += span("tok-str", tok);
    } else if (first === "@") {
      out += span("tok-kw", tok);
    } else if (/[0-9]/.test(first)) {
      out += span("tok-num", tok);
    } else if (tok === "<" || tok === "</" || tok === ">" || tok === "/>" || tok === "=") {
      out += escHtml(tok);
    } else if (lang === "svelte") {
      // Nama tag: didahului "<" / "</"; nama atribut: diikuti "=".
      let p = idx - 1;
      while (p >= 0 && isSpace(text[p])) p--;
      let pp = p;
      if (text[pp] === "/" ) { pp--; while (pp >= 0 && isSpace(text[pp])) pp--; }
      const isTag = text[pp] === "<";
      let n = idx + tok.length;
      while (n < text.length && isSpace(text[n])) n++;
      const followsEq = text[n] === "=";
      if (isTag) out += span("tok-tag", tok);
      else if (followsEq) out += span("tok-attr", tok);
      else out += escHtml(tok);
    } else if (lang === "css") {
      let n = idx + tok.length;
      while (n < text.length && isSpace(text[n])) n++;
      if (text[n] === ":") out += span("tok-attr", tok);
      else out += escHtml(tok);
    } else if (lang === "prose") {
      out += escHtml(tok);
    } else if (kw.has(tok)) {
      out += span("tok-kw", tok);
    } else if (/^[A-Z]/.test(tok)) {
      out += span("tok-type", tok);
    } else {
      let n = idx + tok.length;
      while (n < text.length && isSpace(text[n])) n++;
      out += text[n] === "(" ? span("tok-fn", tok) : escHtml(tok);
    }
    last = idx + tok.length;
    if (re.lastIndex === last && m[0] === "") re.lastIndex++;
  }
  if (last < text.length) out += escHtml(text.slice(last));
  return out.split("\n").map((l) => `<span class="cline">${l || ""}</span>`).join("\n");
}
