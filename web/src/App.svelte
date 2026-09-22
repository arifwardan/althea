<script>
  let meta = $state(null);
  let snap = $state(null);
  let report = $state("");
  let metrics = $state(null);
  let brain = $state(null);
  let brainModel = $state("");
  let brainEffort = $state("");
  let brainMsg = $state("");
  let cpuHist = $state([]);
  let projects = $state([]);
  let newProjName = $state("");
  let newRepoUrl = $state("");
  let uploadName = $state("");
  let uploadFile = $state(null);
  let projErr = $state("");
  let taskProject = $state("");
  let authed = $state(null); // null=memuat, true, false
  let pw = $state("");
  let loginErr = $state("");
  let title = $state("");
  let prompt = $state("");
  let sleepMin = $state(60);
  let now = $state(Date.now());
  let busy = $state("");
  const VIEWS = [
    { id: "home", label: "Home", icon: "⌂" },
    { id: "tasks", label: "Tasks", icon: "☰" },
    { id: "projects", label: "Projects", icon: "▤" },
    { id: "system", label: "System", icon: "◉" },
  ];
  function initialView() {
    if (typeof localStorage === "undefined") return "home";
    let v = localStorage.getItem("althea_view") || localStorage.getItem("althea_tab") || "home";
    if (v === "cmd" || v === "detail") v = "home"; // migrasi nama lama
    return VIEWS.some((t) => t.id === v) ? v : "home";
  }
  let view = $state(initialView());
  let palOpen = $state(false);
  let palQ = $state("");
  let palIdx = $state(0);
  let logId = $state(null);
  let logLines = $state([]);
  let logDone = $state(false);
  let revProj = $state(null);
  let revDiff = $state(null);
  let revFiles = $state([]);
  let revFilePath = $state("");
  let revContent = $state("");
  let revErr = $state("");
  let termTab = $state("term");
  let homeDiff = $state(null);
  let es = null;

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...opts,
    });
    if (r.status === 401) { authed = false; throw new Error("butuh login"); }
    return r;
  }

  async function load() {
    try {
      const [s, rep, projs, met] = await Promise.all([
        (await api("/api/state")).json(),
        (await api("/api/report")).text(),
        (await api("/api/projects")).json(),
        (await api("/api/metrics")).json(),
      ]);
      snap = s;
      report = rep;
      projects = projs;
      metrics = met;
      cpuHist = [...cpuHist.slice(-29), met.cpuPercent];
      authed = true;
    } catch {
      /* authed=false ditangani api() */
    }
  }

  async function loadBrain() {
    try {
      brain = await (await api("/api/brain")).json();
      brainModel = brain.model || "";
      brainEffort = brain.effort || "";
    } catch {
      /* authed=false ditangani api() */
    }
  }

  async function saveBrain() {
    brainMsg = "";
    busy = "brain";
    try {
      const r = await api("/api/brain", {
        method: "PUT",
        body: JSON.stringify({ model: brainModel, effort: brainEffort }),
      });
      const j = await r.json();
      if (!r.ok) {
        brainMsg = "✕ " + (j.error || "gagal menyimpan");
        return;
      }
      brain = j.brain;
      brainModel = brain.model || "";
      brainEffort = brain.effort || "";
      brainMsg = "✓ tersimpan — berlaku untuk spawn berikutnya";
    } catch {
      brainMsg = "✕ gagal menyimpan";
    } finally {
      busy = "";
    }
  }

  async function login() {
    loginErr = "";
    busy = "login";
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        loginErr = j.error || "gagal masuk";
        return;
      }
      pw = "";
      await load();
      await loadBrain();
    } finally {
      busy = "";
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
    authed = false;
    snap = null;
  }

  async function act(path, body) {
    busy = path;
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await load();
    } finally {
      busy = "";
    }
  }

  const approve = (id, ok) => act("/api/approve", { id, ok });
  const addTask = async () => {
    if (!prompt.trim()) return;
    await act("/api/tasks", {
      title: title.trim() || "tugas console",
      prompt: prompt.trim(),
      ...(taskProject ? { project: taskProject } : {}),
    });
    title = "";
    prompt = "";
  };

  async function addRepo() {
    projErr = "";
    if (!newProjName.trim() || !newRepoUrl.trim()) return;
    busy = "repo";
    try {
      const r = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: newProjName.trim(), repoUrl: newRepoUrl.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        projErr = j.error || "gagal clone";
        return;
      }
      newProjName = "";
      newRepoUrl = "";
      await load();
    } finally {
      busy = "";
    }
  }

  async function uploadZip() {
    projErr = "";
    if (!uploadName.trim() || !uploadFile) return;
    busy = "upload";
    try {
      const fd = new FormData();
      fd.append("name", uploadName.trim());
      fd.append("file", uploadFile, uploadFile.name);
      const r = await fetch("/api/projects/upload", { method: "POST", credentials: "include", body: fd });
      if (r.status === 401) { authed = false; return; }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        projErr = j.error || "gagal upload";
        return;
      }
      uploadName = "";
      uploadFile = null;
      await load();
    } finally {
      busy = "";
    }
  }

  async function cancel(id) {
    if (!confirm(`Hentikan tugas ${id}? Proses muse dimatikan.`)) return;
    await act(`/api/tasks/${encodeURIComponent(id)}/cancel`, {});
  }

  function openLog(id) {
    closeLog();
    logId = id;
    logLines = [];
    logDone = false;
    es = new EventSource(`/api/tasks/${encodeURIComponent(id)}/log`);
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.lines?.length) logLines = [...logLines, ...d.lines].slice(-300);
        if (d.done) { logDone = true; es.close(); }
      } catch { /* abaikan frame rusak */ }
    };
  }
  function closeLog() {
    if (es) { try { es.close(); } catch { /* abaikan */ } es = null; }
    logId = null;
  }

  async function openReview(name) {
    revProj = name;
    revDiff = null;
    revFiles = [];
    revFilePath = "";
    revContent = "";
    revErr = "";
    try {
      const [d, f] = await Promise.all([
        (await api(`/api/projects/${encodeURIComponent(name)}/diff`)).json(),
        (await api(`/api/projects/${encodeURIComponent(name)}/files`)).json(),
      ]);
      revDiff = d;
      revFiles = Array.isArray(f) ? f : [];
    } catch {
      revErr = "gagal memuat review";
    }
  }
  function closeReview() {
    revProj = null;
  }
  function goReview(name) {
    view = "projects";
    openReview(name);
  }
  async function openFile(path) {
    revFilePath = path;
    revContent = "memuat…";
    try {
      const r = await api(`/api/projects/${encodeURIComponent(revProj)}/file?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      revContent = r.ok ? j.content : `✕ ${j.error || "gagal"}`;
    } catch {
      revContent = "✕ gagal memuat";
    }
  }

  async function delProject(name) {
    if (!confirm(`Hapus project "${name}" dari workspace?`)) return;
    busy = "del:" + name;
    try {
      await api("/api/projects/" + encodeURIComponent(name), { method: "DELETE" });
      if (taskProject === name) taskProject = "";
      await load();
    } finally {
      busy = "";
    }
  }

  function deadline(a) {
    if (!meta) return 0;
    if (a.stage === "web") return Date.parse(a.createdAt) + meta.approvalWebMinutes * 60000;
    return Date.parse(a.escalatedAt || a.createdAt) + meta.approvalTelegramMinutes * 60000;
  }
  function fmt(ms) {
    if (ms <= 0) return "0:00";
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function dur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + "j " : "") + (m ? m + "m " : "") + s + "d";
  }
  function gb(b) {
    return (b / 1073741824).toFixed(1) + " GB";
  }
  function barCls(pct) {
    return pct < 70 ? "v-ok" : pct < 90 ? "v-warn" : "v-err";
  }
  function fmtTok(n) {
    n = Math.round(n || 0);
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : "" + n;
  }
  function tokOf(t) {
    return (t.usage?.tokIn || 0) + (t.usage?.tokOut || 0);
  }
  function evCls(e) {
    if (/done|OK|setuju|resume|bangun/i.test(e)) return "v-ok";
    if (/fail|gagal|TOLAK|tolak|error|batal/i.test(e)) return "v-err";
    if (/limit|eskalasi|auto|izin|approval|cooldown|tidur/i.test(e)) return "v-warn";
    return "v-dim";
  }
  function ago(iso) {
    if (!iso) return "—";
    const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
    if (s < 60) return `${s} dtk lalu`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} mnt lalu`;
    return `${Math.floor(m / 60)} jam lalu`;
  }
  function tlKind(msg) {
    if (/percobaan/.test(msg)) return { label: "Coding", cls: "v-ok" };
    if (/^done /.test(msg)) return { label: "Completed", cls: "v-ok" };
    if (/failed|gagal|TOLAK|batal/.test(msg)) return { label: "Failed", cls: "v-err" };
    if (/auto-keputusan/.test(msg)) return { label: "Auto decision", cls: "v-warn" };
    if (/eskalasi/.test(msg)) return { label: "Escalated", cls: "v-warn" };
    if (/approval\?/.test(msg)) return { label: "Waiting approval", cls: "v-warn" };
    if (/approval OK|setuju/.test(msg)) return { label: "Approved", cls: "v-ok" };
    if (/limit/.test(msg)) return { label: "Token limit", cls: "v-warn" };
    if (/cooldown/.test(msg)) return { label: "Waiting", cls: "v-warn" };
    if (/reset/.test(msg)) return { label: "Token reset", cls: "v-warn" };
    if (/resume|bangun/.test(msg)) return { label: "Resuming", cls: "v-ok" };
    if (/^push /.test(msg)) return { label: "Queued", cls: "v-dim" };
    if (/project \+/.test(msg)) return { label: "Project added", cls: "v-ok" };
    if (/project -/.test(msg)) return { label: "Project removed", cls: "v-err" };
    if (/tidur/.test(msg)) return { label: "Sleeping", cls: "v-dim" };
    return { label: msg.slice(0, 42), cls: "v-dim" };
  }

  function openPal() {
    palQ = "";
    palIdx = 0;
    palOpen = true;
  }
  function closePal() {
    palOpen = false;
  }
  function palKey(e) {
    if (e.key === "ArrowDown") { palIdx = Math.min(palItems.length - 1, palIdx + 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { palIdx = Math.max(0, palIdx - 1); e.preventDefault(); }
    else if (e.key === "Enter") {
      const it = palItems[palIdx];
      if (it) { closePal(); it.run(); }
    } else if (e.key === "Escape") closePal();
  }

  $effect(() => {
    if (logLines.length) {
      const el = document.getElementById("logpre");
      if (el) el.scrollTop = el.scrollHeight;
    }
  });

  $effect(() => {
    try { localStorage.setItem("althea_view", view); } catch { /* abaikan */ }
  });

  $effect(() => {
    palQ;
    palIdx = 0;
  });

  $effect(() => {
    const p = view === "home" ? current?.project : null;
    if (!p) { homeDiff = null; return; }
    let dead = false;
    (async () => {
      try {
        const d = await (await api(`/api/projects/${encodeURIComponent(p)}/diff`)).json();
        if (!dead) homeDiff = d;
      } catch { if (!dead) homeDiff = null; }
    })();
    return () => { dead = true; };
  });

  $effect(() => {
    const keys = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        if (authed) { palOpen ? closePal() : openPal(); e.preventDefault(); }
        return;
      }
      if (palOpen && e.key === "Escape") { closePal(); return; }
      if (e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
        view = VIEWS[Number(e.key) - 1].id;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  });

  $effect(() => {
    fetch("/api/meta", { credentials: "include" })
      .then((r) => r.json())
      .then((m) => { meta = m; })
      .catch(() => {});
    load();
    loadBrain();
    const t1 = setInterval(load, 5000);
    const t2 = setInterval(() => { now = Date.now(); }, 1000);
    return () => { clearInterval(t1); clearInterval(t2); };
  });

  let tasks = $derived((snap?.stack || []).filter((t) => ["queued", "running", "waiting_approval"].includes(t.status)).reverse());
  let doneCount = $derived((snap?.stack || []).filter((t) => t.status === "done").length);
  let failCount = $derived((snap?.stack || []).filter((t) => t.status === "failed").length);
  let sleeping = $derived(!!snap?.sleepUntil && Date.parse(snap.sleepUntil) > now);
  let cooling = $derived(!!snap?.limitCooldownUntil && Date.parse(snap.limitCooldownUntil) > now);
  let current = $derived(
    (snap?.stack || []).find((t) => t.status === "running") ||
    (snap?.stack || []).find((t) => t.status === "waiting_approval") ||
    [...(snap?.stack || [])].reverse().find((t) => t.status === "queued") ||
    null
  );
  let aiState = $derived(
    (snap?.approvals?.length || 0) > 0 ? { label: "MENUNGGU IZIN", cls: "v-warn" }
    : cooling ? { label: "COOLDOWN KUOTA", cls: "v-warn" }
    : sleeping ? { label: "TIDUR", cls: "v-dim" }
    : current?.status === "running" ? { label: "BEKERJA", cls: "v-ok" }
    : current ? { label: "SIAP", cls: "v-ok" }
    : { label: "IDLE", cls: "v-dim" }
  );
  let history = $derived((snap?.stack || []).filter((t) => t.status === "done" || t.status === "failed").slice(-5).reverse());
  let nextQueued = $derived([...(snap?.stack || [])].reverse().filter((t) => t.status === "queued").slice(0, 3));
  let recentEvents = $derived((snap?.events || []).slice(-4).reverse());
  let spark = $derived.by(() => {
    const h = cpuHist.length ? cpuHist : [0];
    return h.map((v, i) => `${(i * 260) / Math.max(1, h.length - 1)},${36 - (v / 100) * 32}`).join(" ");
  });
  let lastEventIso = $derived((snap?.events || []).length ? snap.events[snap.events.length - 1].slice(0, 24) : null);
  let projTok = $derived.by(() => {
    const p = current?.project;
    let ti = 0, to = 0;
    if (p) for (const t of snap?.stack || []) {
      if (t.project === p && t.usage) { ti += t.usage.tokIn || 0; to += t.usage.tokOut || 0; }
    }
    return { in: ti, out: to };
  });
  let roundPct = $derived(
    current?.graph?.iteration != null && meta?.graphMaxRounds
      ? Math.min(99, Math.round(((current.graph.iteration + 1) / meta.graphMaxRounds) * 100))
      : null
  );
  let timeline = $derived(
    (snap?.events || [])
      .filter((e) => !/graph →|lapor/.test(e.slice(25)))
      .filter((e) => /push |run |done |fail|gagal|TOLAK|tolak|batal|limit|cooldown|reset|resume|bangun|approval|auto-keputusan|setuju|project [+-]|tidur/.test(e.slice(25)))
      .slice(-10)
      .reverse()
      .map((e) => ({ t: e.slice(11, 19), ...tlKind(e.slice(25)) }))
  );
  let homeFiles = $derived.by(() => {
    if (!homeDiff?.repo || !homeDiff.stat) return null;
    return homeDiff.stat.split("\n").filter(Boolean).slice(0, 6).map((l) =>
      l.startsWith("baru:") ? { mark: "+", cls: "v-ok", path: l.slice(5).trim() } : { mark: "~", cls: "v-warn", path: l.split("|")[0].trim() }
    );
  });
  let palItems = $derived.by(() => {
    const q = palQ.trim().toLowerCase();
    const items = [
      ...VIEWS.map((v) => ({ label: `buka ${v.label}`, hint: "view", run: () => { view = v.id; } })),
      ...projects.map((p) => ({ label: `review ${p.name}`, hint: "project", run: () => goReview(p.name) })),
      { label: "bangunkan runtime", hint: "aksi", run: () => act("/api/wake", {}) },
      { label: "tidurkan 60 menit", hint: "aksi", run: () => act("/api/sleep", { minutes: 60 }) },
      { label: "keluar (logout)", hint: "aksi", run: () => logout() },
    ];
    return items.filter((i) => i.label.toLowerCase().includes(q)).slice(0, 9);
  });
</script>

{#if authed === true && snap}
<header class="hd">
  <img src="/favicon.svg" alt="" width="26" height="26" />
  <span class="brand">ALTHEA</span>
  <span class="tagline">Keep AI coding.</span>
  <span class="hd-right">
    <span class="pill {aiState.cls}"><span class="pdot"></span>{aiState.label}</span>
    {#if brain}
      <button class="ghost brain-badge" onclick={() => { view = "system"; }} title="otak aktif — klik untuk ubah di System">
        {brain.bin} · {brain.model || "default"} · {brain.effort || "default"}
      </button>
    {/if}
    <span class="clock">{new Date(now).toLocaleString("id-ID")}</span>
    <button class="ghost" onclick={openPal} title="command palette (Ctrl+K)">⌘K</button>
    <button class="ghost" onclick={logout}>keluar</button>
  </span>
</header>
<div class="app">
  <aside class="side">
    <nav class="sidenav">
      {#each VIEWS as v, i}
        <button class="navbtn {view === v.id ? 'on' : ''}" onclick={() => { view = v.id; }} title="Alt+{i + 1}">
          <span class="ico">{v.icon}</span>{v.label}
          {#if v.id === "tasks" && (tasks.length + snap.approvals.length)}
            <span class="badge">{tasks.length + snap.approvals.length}</span>
          {/if}
        </button>
      {/each}
    </nav>
    <div class="side-sec">projects · {projects.length}<button class="ghost plusbtn" onclick={() => { view = "projects"; }} title="tambah project">+</button></div>
    <div class="side-projs">
      {#if !projects.length}<span class="v-dim" style="font-size:12px">— kosong —</span>{/if}
      {#each projects as p (p.name)}
        <button class="side-proj" onclick={() => goReview(p.name)} title="buka review {p.name}">
          <span class="v-ok">◆</span> {p.name} <span class="v-dim">[{p.stack}]</span>
        </button>
      {/each}
    </div>
    <div class="side-foot">
      <button class="ghost palbtn" onclick={openPal}>⌘K palette</button>
      <span class="v-dim" style="font-size:11px">v0.1.0</span>
    </div>
  </aside>

  <div class="main">
    {#key view}
    <div class="view">
    {#if view === "home"}
    <div class="panel projhead">
      <div class="ph-main">
        <span class="ph-icon">▤</span>
        <div>
          <div class="ph-name">{current?.project || "—"}</div>
          <div class="v-dim">{current?.title || "tidak ada tugas aktif"}</div>
        </div>
      </div>
      <div class="ph-meta">
        <div><span class="k">Agent</span><span>Muse Code</span></div>
        <div><span class="k">Session</span><span>{current ? current.id.slice(-6) : "—"}</span></div>
      </div>
      <span class="pill {aiState.cls}"><span class="pdot"></span>{aiState.label}</span>
    </div>

    {#if snap.approvals.length}
      {#each snap.approvals as a (a.id)}
        <div class="hero-alert" style="margin-top:12px">
          <span class="v-warn">◆ IZIN [{a.stage}]</span>
          <strong>{a.title}</strong>
          <span class="v-dim">{a.question}</span>
          <span class="countdown">{fmt(deadline(a) - now)}</span>
          <span class="hero-alert-btns">
            <button onclick={() => approve(a.id, true)} disabled={!!busy}>[setuju]</button>
            <button class="danger" onclick={() => approve(a.id, false)} disabled={!!busy}>[tolak]</button>
          </span>
        </div>
      {/each}
    {/if}

    <div class="hrow hrow-3">
      <div class="panel">
        <h2>status</h2>
        <div class="statline"><span class="pulse"></span><span class="statbig {aiState.cls}">{aiState.label}</span></div>
        <div class="hint">
          {aiState.label === "BEKERJA" ? "Muse Code sedang bekerja" : aiState.label === "MENUNGGU IZIN" ? "butuh keputusanmu" : aiState.label === "COOLDOWN KUOTA" ? "menunggu reset kuota" : aiState.label === "TIDUR" ? "hening namun siaga" : "menunggu tugas"}
        </div>
        <svg class="spark" viewBox="0 0 260 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={spark} /></svg>
        <div class="row"><span class="k">tugas</span><span>{current?.title || "—"}</span></div>
        <div class="ministats">
          <div><span class="v-dim">runtime</span><b>{metrics ? dur(metrics.procUptimeSec) : "…"}</b></div>
          <div><span class="v-dim">aktivitas</span><b>{ago(lastEventIso)}</b></div>
          <div><span class="v-dim">token ±</span><b>~{fmtTok((snap.usage?.tokIn || 0) + (snap.usage?.tokOut || 0))}</b></div>
        </div>
      </div>
      <div class="panel">
        <h2>token_usage</h2>
        <div class="toklabel">Project ({current?.project || "—"})</div>
        <div class="toknum">~{fmtTok(projTok.in + projTok.out)}</div>
        <div class="splitbar">
          <div class="spin" style="width:{((projTok.in / ((projTok.in + projTok.out) || 1)) * 100).toFixed(1)}%"></div>
          <div class="spout" style="width:{((projTok.out / ((projTok.in + projTok.out) || 1)) * 100).toFixed(1)}%"></div>
        </div>
        <div class="hint">{fmtTok(projTok.in)} in · {fmtTok(projTok.out)} out</div>
        <div class="toklabel" style="margin-top:12px">Total</div>
        <div class="toknum">~{fmtTok((snap.usage?.tokIn || 0) + (snap.usage?.tokOut || 0))}</div>
        <div class="splitbar">
          <div class="spin" style="width:{(((snap.usage?.tokIn || 0) / (((snap.usage?.tokIn || 0) + (snap.usage?.tokOut || 0)) || 1)) * 100).toFixed(1)}%"></div>
          <div class="spout" style="width:{(((snap.usage?.tokOut || 0) / (((snap.usage?.tokIn || 0) + (snap.usage?.tokOut || 0)) || 1)) * 100).toFixed(1)}%"></div>
        </div>
        <div class="hint">{snap.usage?.runs || 0} run · estimasi ±3,5 char/token</div>
      </div>
      <div class="panel">
        <h2>otonomi</h2>
        <div class="row"><span class="k">eskalasi</span><span>web {meta?.approvalWebMinutes ?? 3} → tg {meta?.approvalTelegramMinutes ?? 3} → {meta?.approvalAutodecide === false ? "tunggu" : "auto"}</span></div>
        <div class="row"><span class="k">graph</span>{#if meta?.graphEnabled === false}<span class="v-dim">single-shot</span>{:else}<span class="v-ok">plan→review · {meta?.graphMaxRounds ?? 3} ronde</span>{/if}</div>
        <div class="row"><span class="k">mode</span>{#if meta?.dryRun}<span class="v-warn">DRY-RUN</span>{:else}<span class="v-ok">live</span>{/if}</div>
        <div class="row"><span class="k">izin pending</span><span class={snap.approvals.length ? "v-warn" : "v-ok"}>{snap.approvals.length}</span></div>
        <div class="btnrow">
          {#if current?.status === "running"}
            <button class="danger" onclick={() => cancel(current.id)} disabled={!!busy}>[hentikan]</button>
          {/if}
          <button class="ghost" onclick={() => act("/api/wake", {})} disabled={!!busy}>bangun</button>
          <button class="ghost" onclick={() => act("/api/sleep", { minutes: Number(sleepMin) || 60 })} disabled={!!busy}>tidur</button>
          <input type="number" bind:value={sleepMin} min="1" max="1440" style="width:64px" aria-label="menit tidur" />
        </div>
      </div>
    </div>

    <div class="hrow hrow-3">
      <div class="panel">
        <h2>tugas_berjalan</h2>
        <div class="ic-title">{current?.title || "—"}{current?.project ? ` @${current.project}` : ""}</div>
        {#if roundPct != null}
          <div class="prog"><div class="progfill" style="width:{roundPct}%"></div></div>
          <div class="hint">ronde {(current.graph.iteration ?? 0) + 1}/{meta.graphMaxRounds}</div>
        {:else}
          <div class="hint">{current ? current.status : "tidak ada tugas"}</div>
        {/if}
        <div class="toklabel" style="margin-top:10px">operasi_terakhir</div>
        <div class="hint">{current && (snap.logs[current.id] || []).length ? (snap.logs[current.id] || []).slice(-1)[0].slice(0, 120) : "—"}</div>
        <div class="toklabel" style="margin-top:10px">files</div>
        {#if !current?.project}
          <span class="v-dim">—</span>
        {:else if !homeDiff}
          <span class="v-dim">memuat…</span>
        {:else if !homeDiff.repo}
          <span class="v-dim">bukan repo git.</span>
        {:else if !homeFiles?.length}
          <span class="v-dim">bersih — tanpa perubahan.</span>
        {:else}
          {#each homeFiles as f}
            <div class="row"><span class={f.cls}>{f.mark}</span><span>{f.path}</span></div>
          {/each}
        {/if}
      </div>
      <div class="panel">
        <h2>activity_stream</h2>
        <div class="events timeline">
          {#each (snap.events || []).slice(-9).reverse() as e}
            <div><span class="tdot {evCls(e)}"></span><span class="ttime">{e.slice(11, 19)}</span><span>{e.slice(20, 90)}</span></div>
          {/each}
        </div>
        <div class="btnrow"><button class="ghost" onclick={() => { view = "tasks"; }}>buka tasks →</button></div>
      </div>
      <div class="panel">
        <h2>runtime_timeline</h2>
        <div class="events timeline tlrail">
          {#if !timeline.length}<span class="v-dim">belum ada milestone.</span>{/if}
          {#each timeline as tl}
            <div><span class="tdot {tl.cls}"></span><span>{tl.label}</span><span class="ttime" style="margin-left:auto">{tl.t}</span></div>
          {/each}
        </div>
      </div>
    </div>

    <div class="hrow hrow-term">
      <div class="panel">
        <h2>terminal</h2>
        <div class="termtabs">
          <button class={termTab === "term" ? "on" : ""} onclick={() => termTab = "term"}>terminal</button>
          <button class={termTab === "logs" ? "on" : ""} onclick={() => termTab = "logs"}>logs</button>
          <button class={termTab === "out" ? "on" : ""} onclick={() => termTab = "out"}>output</button>
        </div>
        {#if termTab === "term"}
          <pre class="dump termview">{current && (snap.logs[current.id] || []).length ? (snap.logs[current.id] || []).slice(-30).join("\n") : "menunggu output…"}</pre>
        {:else if termTab === "logs"}
          <pre class="dump termview">{report}</pre>
        {:else}
          <pre class="dump termview">{history[0]?.note || "—"}</pre>
        {/if}
      </div>
      <div class="hside">
        <div class="panel">
          <h2>project</h2>
          <div class="minititle">▤ {current?.project || "—"}</div>
          <div class="row"><span class="k">runtime</span><span>Muse Code</span></div>
          <div class="row"><span class="k">sesi</span><span>{current ? current.id.slice(-6) : "—"}</span></div>
          <div class="row"><span class="k">aktivitas</span><span>{ago(lastEventIso)}</span></div>
        </div>
        <div class="panel">
          <h2>agent</h2>
          <div class="minititle">✦ MUSE CODE <span class={meta?.brain?.ok ? "v-ok" : "v-err"}>● {meta?.brain?.ok ? "Connected" : "Offline"}</span></div>
          <div class="row"><span class="k">runtime</span><span>{aiState.label}</span></div>
          <div class="row"><span class="k">bisa</span><span class="v-dim">coding · graph · resume · estimasi</span></div>
        </div>
      </div>
    </div>

    {:else if view === "tasks"}
    <div class="grid" style="margin-top:0">
      <div class="panel {snap.approvals.length ? 'alert' : ''}">
        <h2>izin_pending</h2>
        {#if !snap.approvals.length}
          <span class="v-dim">kosong — web {meta?.approvalWebMinutes ?? 3} mnt → telegram {meta?.approvalTelegramMinutes ?? 3} mnt → auto.</span>
        {:else}
          {#each snap.approvals as a (a.id)}
            <div class="approval">
              <div class="meta">[{a.stage}] {a.id}</div>
              <div><strong>{a.title}</strong></div>
              <div class="q">{a.question}</div>
              <div class="meta">
                {#if a.stage === "web"}
                  eskalasi ke telegram dalam <span class="countdown">{fmt(deadline(a) - now)}</span>
                {:else}
                  keputusan otomatis dalam <span class="countdown">{fmt(deadline(a) - now)}</span>
                {/if}
              </div>
              <div class="btnrow">
                <button onclick={() => approve(a.id, true)} disabled={!!busy}>[setuju]</button>
                <button class="danger" onclick={() => approve(a.id, false)} disabled={!!busy}>[tolak]</button>
              </div>
            </div>
          {/each}
        {/if}
      </div>
      <div class="panel">
        <h2>tambah_tugas</h2>
        <div class="task-add">
          <label for="judul">judul</label>
          <input id="judul" type="text" bind:value={title} placeholder="mis. perbaiki login" />
          <label for="pr">prompt lengkap (disimpan → auto-lanjut)</label>
          <input id="pr" type="text" bind:value={prompt} placeholder="kerjakan X di repo Y…" />
          <label for="pj">project (opsional — muse kerja di folder itu)</label>
          <select id="pj" bind:value={taskProject}>
            <option value="">— tanpa project (root Althea) —</option>
            {#each projects as p (p.name)}
              <option value={p.name}>{p.name} [{p.stack}]</option>
            {/each}
          </select>
        </div>
        <div class="btnrow"><button onclick={addTask} disabled={!!busy || !prompt.trim()}>[push ke stack]</button></div>
      </div>
    </div>
    <div class="grid" style="margin-top:12px">
      <div class="panel">
        <h2>stack_aktif</h2>
        {#if !tasks.length}<span class="v-dim">kosong.</span>{/if}
        {#each tasks as t (t.id)}
          <div class="row">
            <span class={t.status === "waiting_approval" ? "v-warn" : t.status === "running" ? "v-ok" : "v-dim"}>
              {t.status === "running" ? "▶" : t.status === "waiting_approval" ? "◆" : "·"}
              {t.status}
            </span>
            <span>{t.title}{t.project ? ` @${t.project}` : ""}</span>
            <span class="v-dim" style="font-size:12px">~{fmtTok(tokOf(t))}</span>
            <span style="margin-left:auto; display:flex; gap:6px">
              <button class="ghost" onclick={() => openLog(t.id)}>[log]</button>
              <button class="ghost danger" onclick={() => cancel(t.id)} disabled={!!busy}>[hentikan]</button>
            </span>
          </div>
        {/each}
        <h2 style="margin-top:14px">riwayat</h2>
        {#if !history.length}<span class="v-dim">belum ada.</span>{/if}
        {#each history as t (t.id)}
          <div class="row">
            <span class={t.status === "done" ? "v-ok" : "v-err"}>{t.status === "done" ? "✓" : "✕"} {t.status}</span>
            <span>{t.title}{t.project ? ` @${t.project}` : ""}</span>
            <span class="v-dim" style="font-size:12px">~{fmtTok(tokOf(t))}</span>
            <button class="ghost" style="margin-left:auto" onclick={() => openLog(t.id)}>[log]</button>
          </div>
        {/each}
      </div>
      <div class="panel">
        <h2>live_log</h2>
        {#if logId}
          <div class="hint" style="margin-bottom:8px">{logId} {logDone ? "[selesai]" : "[mengalir…]"}</div>
          <pre class="dump logview" id="logpre">{logLines.length ? logLines.join("\n") : "menunggu output…"}</pre>
          <div class="btnrow"><button class="ghost" onclick={closeLog}>[tutup]</button></div>
        {:else}
          <span class="v-dim">Pilih [log] pada tugas untuk mengalirkan output muse di sini.</span>
        {/if}
      </div>
    </div>

    {:else if view === "projects"}
    <div class="panel">
      <h2>workspace_projects</h2>
      {#if !projects.length}
        <span class="v-dim">belum ada project — clone dari URL atau upload zip.</span>
      {:else}
        {#each projects as p (p.name)}
          <div class="row">
            <span class="v-ok">◆ {p.name}</span>
            <span class="v-dim">[{p.stack}] {p.source}</span>
            <span style="margin-left:auto; display:flex; gap:6px">
              <button class="ghost" onclick={() => openReview(p.name)}>[review]</button>
              <button class="ghost danger" onclick={() => delProject(p.name)} disabled={!!busy}>[hapus]</button>
            </span>
          </div>
        {/each}
      {/if}
      <div class="grid" style="margin-top:10px">
        <div>
          <label for="rn">nama project baru</label>
          <input id="rn" type="text" bind:value={newProjName} placeholder="mis. toko-online" />
          <label for="ru">link repo (https://… / git@…)</label>
          <input id="ru" type="text" bind:value={newRepoUrl} placeholder="https://github.com/aku/repo.git" />
          <div class="btnrow"><button onclick={addRepo} disabled={busy === "repo" || !newProjName.trim() || !newRepoUrl.trim()}>[clone repo]</button></div>
        </div>
        <div>
          <label for="un">nama project baru</label>
          <input id="un" type="text" bind:value={uploadName} placeholder="mis. arsip-lama" />
          <label for="uf">file zip (maks {meta?.projectMaxMb ?? 50} MB)</label>
          <input id="uf" type="file" accept=".zip" onchange={(e) => { uploadFile = e.target.files?.[0] || null; }} />
          <div class="btnrow"><button onclick={uploadZip} disabled={busy === "upload" || !uploadName.trim() || !uploadFile}>[upload zip]</button></div>
        </div>
      </div>
      {#if projErr}<div class="err">✕ {projErr}</div>{/if}
    </div>

    {#if revProj}
      <div class="panel" style="margin-top:12px">
        <h2>review {revProj}</h2>
        {#if revErr}<div class="err">✕ {revErr}</div>{/if}
        {#if revDiff}
          {#if !revDiff.repo}
            <div class="hint">Bukan repo git — diff tak tersedia. Jelajahi file di bawah.</div>
          {:else}
            <pre class="dump" style="max-height:120px">{revDiff.stat}</pre>
            {#if revDiff.diff}
              <pre class="dump diffview">{#each revDiff.diff.split("\n").slice(0, 400) as ln}<span class={ln.startsWith("+") && !ln.startsWith("+++") ? "d-add" : ln.startsWith("-") && !ln.startsWith("---") ? "d-del" : ln.startsWith("@@") ? "d-hunk" : ""}>{ln}
</span>{/each}</pre>
            {/if}
          {/if}
        {:else}
          <span class="v-dim">memuat diff…</span>
        {/if}
        <h2 style="margin-top:12px">files ({revFiles.length})</h2>
        <div class="tree">
          {#each revFiles as f (f.path)}
            <div class="treerow {revFilePath === f.path ? 'sel' : ''}" onclick={() => openFile(f.path)} onkeydown={(e) => e.key === "Enter" && openFile(f.path)} role="button" tabindex="0">{f.path} <span class="v-dim">· {(f.size / 1024).toFixed(1)} KB</span></div>
          {/each}
        </div>
        {#if revFilePath}
          <h2 style="margin-top:12px">{revFilePath}</h2>
          <pre class="dump codeview">{revContent}</pre>
        {/if}
        <div class="btnrow"><button class="ghost" onclick={closeReview}>[tutup]</button></div>
      </div>
    {/if}

    {:else}
    <div class="grid" style="margin-top:0">
      <div class="panel">
        <h2>otak_ai</h2>
        <div class="row"><span class="k">mesin</span><span>muse-cli <span class="v-dim">({meta?.brain?.bin || "muse"})</span></span></div>
        <div class="row"><span class="k">kesehatan</span>
          {#if meta?.brain?.ok}<span class="v-ok">● terhubung{meta.brain.version ? ` — ${meta.brain.version}` : ""}</span>
          {:else}<span class="v-err">● CLI tidak ditemukan</span>{/if}
        </div>
        <div class="row"><span class="k">mode</span>{#if meta?.dryRun}<span class="v-warn">DRY-RUN (simulasi, tanpa kuota)</span>{:else}<span class="v-ok">live</span>{/if}</div>
        <div class="row"><span class="k">kuota</span>
          {#if cooling}<span class="v-warn">● cooldown s/d {snap.limitCooldownUntil}</span>
          {:else}<span class="v-ok">● normal</span>{/if}
        </div>
        <div class="row"><span class="k">reset terakhir</span><span class="v-dim">{snap.lastReset || "—"}</span></div>
        <div class="row"><span class="k">detak loop</span><span>{meta?.loopSeconds ?? 15} dtk</span></div>
        <div class="row"><span class="k">tugas</span><span>{tasks.length} aktif · {doneCount} selesai · {failCount} gagal</span></div>
        <div class="cardiv"></div>
        <div class="minititle">kontrol_model</div>
        <div class="row"><span class="k">perintah</span><span class="v-dim">{brain ? `${brain.bin}${brain.subcommand ? " " + brain.subcommand : " -p"}` : "…"}</span></div>
        <div class="row"><span class="k">model aktif</span><span>{brain?.model || "default CLI"} <span class="v-dim">({brain?.modelSource || "…"})</span></span></div>
        <div class="row"><span class="k">effort aktif</span><span>{brain?.effort || "default CLI"} <span class="v-dim">({brain?.effortSource || "…"})</span></span></div>
        <label for="bmodel">model (kosong = default CLI)</label>
        <input id="bmodel" type="text" bind:value={brainModel} placeholder="mis. id-model-provider…" autocomplete="off" />
        <label for="beff">reasoning effort</label>
        <select id="beff" bind:value={brainEffort}>
          <option value="">— default CLI —</option>
          {#each (brain?.efforts || []) as e}
            <option value={e}>{e}</option>
          {/each}
        </select>
        {#if current?.status === "running"}
          <div class="hint" style="margin-top:8px">otak sedang bekerja — setting dipakai run berikutnya.</div>
        {/if}
        <div class="btnrow"><button onclick={saveBrain} disabled={busy === "brain"}>[simpan otak]</button></div>
        {#if brainMsg}<div class="hint" style="margin-top:6px">{brainMsg}</div>{/if}
      </div>

      <div class="panel">
        <h2>laptop</h2>
        {#if metrics}
          <div class="row"><span class="k">cpu {metrics.cpuPercent}%</span>
            <div class="bar"><div class="fill {barCls(metrics.cpuPercent)}" style="width:{metrics.cpuPercent}%"></div></div>
          </div>
          <svg class="spark" viewBox="0 0 260 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={spark} /></svg>
          <div class="row"><span class="k">mem {metrics.memUsedPercent}%</span>
            <div class="bar"><div class="fill {barCls(metrics.memUsedPercent)}" style="width:{metrics.memUsedPercent}%"></div></div>
          </div>
          <div class="row"><span class="k">memori</span><span>{gb(metrics.memTotal - metrics.memFree)} / {gb(metrics.memTotal)} · althea {metrics.procMemMb} MB</span></div>
          <div class="row"><span class="k">uptime</span><span>laptop {dur(metrics.uptimeSec)} · althea {dur(metrics.procUptimeSec)}</span></div>
          <div class="row"><span class="k">network</span><span class="v-dim">{metrics.net.length ? metrics.net.map((n) => `${n.name}:${n.address}`).join("  ") : "—"}</span></div>
          <div class="row"><span class="k">runtime</span><span class="v-dim">{metrics.platform} · {metrics.node}</span></div>
        {:else}
          <span class="v-dim">memuat metrik…</span>
        {/if}
      </div>
    </div>

    <div class="grid" style="margin-top:12px">
      <div class="panel">
        <h2>laporan</h2>
        <pre class="dump">{report}</pre>
      </div>
      <div class="panel">
        <h2>timeline</h2>
        <div class="events timeline">
          {#each (snap.events || []).slice(-12).reverse() as e}
            <div><span class="tdot {evCls(e)}"></span><span class="ttime">{e.slice(11, 19)}</span><span>{e.slice(20)}</span></div>
          {/each}
        </div>
      </div>
    </div>
    {/if}
    </div>
    {/key}
  </div>
</div>

{:else}
<div class="wrap">
  <div class="screen">
  <div class="topbar">
    <span class="brand">ALTHEA</span>
    <span class="tagline">Keep AI coding.</span>
    <span class="clock">{new Date(now).toLocaleString("id-ID")}</span>
  </div>
  {#if authed === null}
    <div class="panel"><span class="v-dim">menghubungkan ke runtime…</span></div>
  {:else}
    <div class="panel login-box">
      <h2>login_required</h2>
      <p class="hint">Masukkan password admin (ADMIN_PASSWORD). Sesi berupa cookie HttpOnly.</p>
      <label for="pw">password</label>
      <input id="pw" type="password" bind:value={pw} onkeydown={(e) => e.key === "Enter" && login()} autocomplete="current-password" />
      {#if loginErr}<div class="err">✕ {loginErr}</div>{/if}
      <div class="btnrow"><button onclick={login} disabled={busy === "login" || !pw}>masuk</button></div>
    </div>
  {/if}
  </div>
</div>
{/if}

{#if palOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: backdrop mouse-only; keyboard pakai Esc global -->
  <div class="paloverlay" onclick={(e) => { if (e.target === e.currentTarget) closePal(); }}>
    <div class="palbox" role="dialog" aria-label="command palette">
      <!-- svelte-ignore a11y_autofocus: palette butuh fokus langsung -->
      <input
        type="text"
        placeholder="ketik perintah… (↑↓ + enter)"
        bind:value={palQ}
        onkeydown={palKey}
        autofocus
      />
      <div class="palitems">
        {#if !palItems.length}<div class="palempty v-dim">tidak cocok.</div>{/if}
        {#each palItems as it, i}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: pintasan mouse; keyboard pakai ↑↓+enter -->
          <div class="palitem {i === palIdx ? 'sel' : ''}" onclick={() => { closePal(); it.run(); }}>
            <span>{it.label}</span><span class="v-dim">{it.hint}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
