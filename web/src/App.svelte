<script lang="ts">
  import { highlightCode, langOf } from "./highlight.ts";
  import { summarizeToolCalls } from "./audit.ts";
  import { buildFileTree, sortedNames } from "./tree.ts";
  import { Select, Progress } from "bits-ui";
  import * as Tabs from "./lib/components/tabs/index.ts";
  import * as Card from "./lib/components/card/index.ts";
  import Button from "./lib/components/button.svelte";
  import type {
    AltheaState,
    Approval,
    BrainInfo,
    LimitsInfo,
    McpInfo,
    MetaInfo,
    Metrics,
    PreviewInfo,
    Project,
    ProjectDiff,
    SelectOption,
    StackTask,
    TaskActivity,
  } from "./lib/types";
  import type { TreeFile, TreeNode } from "./tree.ts";

  // Kelas bits-ui langsung — menggantikan lapisan wrapper shadcn-svelte.
  // Untuk mengubah tampilan, edit konstanta di sini (atau token warna di tailwind.css).
  // Tabs = component lokal (lib/components/tabs): susunan vertikal —
  // tombol di atas, konten di bawah. Styling-nya ada di file component tersebut.
  // Button = component lokal (lib/components/button.svelte) — pakai
  // <Button variant="ghost|danger|cta|pick|…">.
  const cInput = "flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";
  const cBadgeBase = "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors";
  const cBadgeSuccess = `${cBadgeBase} border-success bg-success/25 text-success-foreground`;
  const cBadgeDestructive = `${cBadgeBase} border-transparent bg-destructive text-destructive-foreground`;
  const cBadgeWarning = `${cBadgeBase} border-warning bg-warning/25 text-warning-foreground`;
  const cSelectTrigger = "flex h-8 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";
  const cSelectContent = "z-50 flex max-h-72 min-w-36 flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground";
  const cSelectItem = "relative flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:font-medium";
  const cSelectEmpty = "px-2 py-1.5 text-sm text-muted-foreground";
  const cProgress = "relative h-1.5 w-full overflow-hidden rounded-full bg-secondary";
  const cProgressFill = "h-full flex-1 rounded-full bg-primary transition-transform";

  let meta = $state<MetaInfo | null>(null);
  let snap = $state<AltheaState | null>(null);
  let report = $state("");
  let metrics = $state<Metrics | null>(null);
  let brain = $state<BrainInfo | null>(null);
  let brainModel = $state("");
  let brainEffort = $state("");
  let brainProvider = $state("");
  let brainAgent = $state("");
  let brainBin = $state("");
  const agentOptions: SelectOption[] = [
    { value: "", label: "— env default —" },
    { value: "muse", label: "muse (Muse Code)" },
    { value: "opencode", label: "opencode" },
  ];

  // Opsi select model: dari katalog backend per agen (opencode = provider/model
  // terautentikasi, muse = daftar terkurasi). Nilai tersimpan yang tak ada di
  // katalog tetap dipertahankan sebagai opsi agar tak hilang.
  let providerOptions = $derived<SelectOption[]>([
    { value: "", label: "all providers" },
    ...((brain?.catalog?.providers || []).map((p) => ({ value: p.id, label: p.name }))),
  ]);
  let filteredModels = $derived(
    (brain?.catalog?.models || []).filter((m) => !brainProvider || m.provider === brainProvider),
  );
  let modelOptions = $derived<SelectOption[]>([
    { value: "", label: "— CLI default —" },
    ...filteredModels.map((m) => ({
      value: m.value,
      label: brain?.agent === "opencode" && !brainProvider ? `${m.label} · ${m.provider}` : m.label,
    })),
    ...(!brainModel || filteredModels.some((m) => m.value === brainModel)
      ? []
      : [{ value: brainModel, label: `${brainModel} (saved)` }]),
  ]);

  // Select model (searchable): kotak pencarian + reset query tiap dibuka.
  let modelSelOpen = $state(false);
  let modelQuery = $state("");
  let modelSearchEl = $state<HTMLInputElement | null>(null);
  let modelSelItems = $derived(
    !modelQuery.trim()
      ? modelOptions
      : modelOptions.filter((o) =>
          `${o.label ?? ""} ${o.value ?? ""}`.toLowerCase().includes(modelQuery.trim().toLowerCase()),
        ),
  );
  $effect(() => {
    if (modelSelOpen) {
      modelQuery = "";
      requestAnimationFrame(() => modelSearchEl?.focus({ preventScroll: true }));
    }
  });

  // Ganti provider → model yang bukan miliknya ikut tereset.
  $effect(() => {
    const p = brainProvider;
    if (p && brainModel && !brainModel.startsWith(p + "/")) brainModel = "";
  });
  // Ganti agen → isi biner bawaannya bila kolom biner masih kosong.
  $effect(() => {
    const a = brainAgent;
    if ((a === "muse" || a === "opencode") && !brainBin.trim()) {
      brainBin = a === "opencode" ? "opencode" : "muse";
    }
  });
  // Kotak koreksi basi (tugas selesai/berganti) → tutup sendiri.
  $effect(() => {
    if (cTarget && (!current || current.id !== cTarget)) {
      cTarget = null;
      cText = "";
      cErr = "";
    }
  });
  let brainMsg = $state("");
  let limits = $state<LimitsInfo | null>(null);
  let timeoutInput = $state("");
  let limitsMsg = $state("");
  let cpuHist = $state<number[]>([]);
  let projects = $state<Project[]>([]);
  let projName = $state("");
  let projMode = $state("prompt"); // prompt|repo|zip|prd
  let projPrompt = $state("");
  let projRepo = $state("");
  let projFile = $state<File | null>(null);
  let projStack = $state<Record<string, string>>({ fe: "svelte", be: "laravel", db: "postgresql", css: "tailwind" });
  let projCats = $state<Record<string, string[]>>({ fungsi: [], bisnis: [], arsitektur: [], target: [], interaksi: [] });
  let projErr = $state("");
  let projMsg = $state("");
  let taskProject = $state("");
  let authed = $state<boolean | null>(null); // null=memuat, true, false
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
  const MODES = [
    { id: "prompt", label: "from prompt" },
    { id: "repo", label: "repo link" },
    { id: "zip", label: "zip file" },
    { id: "prd", label: "upload PRD" },
  ];
  const STACK_DIMS = [
    { id: "be", label: "backend" },
    { id: "fe", label: "frontend" },
    { id: "db", label: "database" },
    { id: "css", label: "framework css" },
  ];
  const CAT_DIMS = ["fungsi", "bisnis", "arsitektur", "target", "interaksi"];
  function toggleCat(dim: string, id: string) {
    const arr = projCats[dim] || [];
    projCats[dim] = arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
  }
  function stackOptLabel(dim: string, id: string, fb: string) {
    return meta?.stackOptions?.[dim]?.find((o) => o.id === id)?.label?.split(" (")[0] || fb;
  }
  function stackText(p: Project) {
    const s = p.stackSpec || { fe: "", be: "", db: "", css: "" };
    return `${stackOptLabel("be", s.be, "Laravel")} + ${stackOptLabel("fe", s.fe, "Svelte")} + ${stackOptLabel("db", s.db, "PostgreSQL")} + ${stackOptLabel("css", s.css, "Tailwind")}`;
  }
  function catLabel(dim: string, id: string) {
    return meta?.categoryTaxonomy?.[dim]?.find((o) => o.id === id)?.label || id;
  }
  function setStack(dim: string, id: string) {
    projStack[dim] = id;
  }
  function shortOpt(o: { label: string }) {
    return o.label.split(" (")[0];
  }
  function pipeBadge(p: Project) {
    if (!p.pipeline) return { cls: "v-dim", text: "no pipeline", title: "no pipeline yet" };
    const done = p.pipeline.phases.filter((x) => x.done).length;
    const total = p.pipeline.phases.length || "…";
    return { cls: pipeCls(p.pipeline.status), text: `${p.pipeline.status} · ${done}/${total}`, title: (p.pipeline.note || p.pipeline.goal || "") + ` (${p.pipeline.status})` };
  }
  function catBadges(p: Project) {
    const all: string[] = [];
    const cats = p.categories as Record<string, string[]> | undefined;
    for (const d of CAT_DIMS) {
      for (const id of (cats?.[d] || [])) all.push(catLabel(d, id));
    }
    return { shown: all.slice(0, 4), extra: Math.max(0, all.length - 4) };
  }
  const REVTABS = [
    { id: "tugas", label: "Tasks" },
    { id: "diff", label: "Diff" },
    { id: "files", label: "Files" },
    { id: "preview", label: "Preview" },
    { id: "mcp", label: "MCP" },
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
  let logId = $state<string | null>(null);
  let logLines = $state<string[]>([]);
  let logDone = $state(false);
  let detailId = $state<string | null>(null);
  let revProj = $state<string | null>(null);
  let revActId = $state<string | null>(null); // tugas yang feed tool-nya dibuka di panel review
  let revDiff = $state<ProjectDiff | null>(null);
  let revFiles = $state<TreeFile[]>([]);
  let revFilePath = $state("");
  let revContent = $state("");
  let revErr = $state("");
  let mcpInfo = $state<McpInfo | null>(null);
  let mcpBusy = $state(false);
  let pvInfo = $state<PreviewInfo | null>(null);
  let pvCmd = $state("");
  let pvBusy = $state(false);
  let pvFrameKey = $state(0);
  let showPvLog = $state(false);
  let fTarget = $state<string | null>(null); // id tugas untuk tindak lanjut
  let cTarget = $state<string | null>(null); // id tugas yang dikoreksi mid-run
  let cText = $state("");
  let cErr = $state("");
  let fText = $state("");
  let instructText = $state("");
  let showNote = $state<string | null>(null); // id tugas yang hasilnya dibuka
  let revTab = $state("tugas"); // tab aktif panel review
  let expandedDirs = $state<Record<string, boolean>>({}); // path folder → true/false (tab Files)
  let fileTree = $derived(buildFileTree(revFiles));
  function dirOpen(path: string, depth: number) {
    if (path in expandedDirs) return expandedDirs[path];
    return depth <= 1; // level atas terbuka default, dalam tertutup
  }
  function toggleDir(path: string, depth: number) {
    expandedDirs[path] = !dirOpen(path, depth);
  }
  let projTab = $state("list"); // tab halaman projects: list | baru
  let termTab = $state("term");
  let homeDiff = $state<ProjectDiff | null>(null);
  let es: EventSource | null = null;

  async function api(path: string, opts: RequestInit = {}) {
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

  function syncProviderFromModel() {
    brainProvider =
      brain?.agent === "opencode" && brainModel.includes("/") ? brainModel.split("/")[0] : "";
  }

  function syncBrainFields() {
    if (!brain) return;
    brainModel = brain.model || "";
    brainEffort = brain.effort || "";
    brainAgent = brain.agentSource === "dashboard" ? brain.agent : "";
    brainBin = brain.binSource === "dashboard" ? brain.bin : "";
    syncProviderFromModel();
  }

  async function loadBrain() {
    try {
      brain = await (await api("/api/brain")).json();
      syncBrainFields();
    } catch {
      /* authed=false ditangani api() */
    }
  }

  async function loadLimits() {
    try {
      const j = await (await api("/api/limits")).json();
      limits = j;
      timeoutInput = j.timeoutOverride ? String(j.timeoutOverride) : "";
    } catch {
      /* authed=false ditangani api() */
    }
  }

  async function saveLimits() {
    limitsMsg = "";
    busy = "limits";
    try {
      const raw = timeoutInput.trim();
      const r = await api("/api/limits", {
        method: "PUT",
        body: JSON.stringify({ timeoutSeconds: raw === "" ? 0 : Number(raw) }),
      });
      const j = await r.json();
      if (!r.ok) {
        limitsMsg = "✕ " + (j.error || "save failed");
        return;
      }
      await loadLimits();
      limitsMsg = `✓ saved — effective ${j.timeoutSeconds}s (${j.timeoutSource}), applies to next spawn`;
    } catch {
      limitsMsg = "✕ save failed";
    } finally {
      busy = "";
    }
  }

  async function saveBrain() {
    brainMsg = "";
    busy = "brain";
    try {
      const r = await api("/api/brain", {
        method: "PUT",
        body: JSON.stringify({ model: brainModel, effort: brainEffort, agent: brainAgent, bin: brainBin }),
      });
      const j = await r.json();
      if (!r.ok) {
        brainMsg = "✕ " + (j.error || "save failed");
        return;
      }
      // PUT tak mengembalikan katalog → muat ulang agar daftar provider/model
      // langsung mengikuti agen yang baru dipilih (muse = model terkurasi +
      // effort; opencode = provider + model terautentikasi; provider disembunyikan
      // bila katalog tak punya provider).
      await loadBrain();
      brainMsg = "✓ saved — applies to next spawn";
    } catch {
      brainMsg = "✕ save failed";
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
        loginErr = j.error || "login failed";
        return;
      }
      pw = "";
      await load();
      await loadBrain();
      await loadLimits();
    } finally {
      busy = "";
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
    authed = false;
    snap = null;
  }

  async function act(path: string, body?: unknown) {
    busy = path;
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await load();
    } finally {
      busy = "";
    }
  }

  const approve = (id: string, ok: boolean) => act("/api/approve", { id, ok });
  const addTask = async () => {
    if (!prompt.trim()) return;
    await act("/api/tasks", {
      title: title.trim() || "console task",
      prompt: prompt.trim(),
      ...(taskProject ? { project: taskProject } : {}),
    });
    title = "";
    prompt = "";
  };

  async function addProject() {
    projErr = "";
    projMsg = "";
    const name = projName.trim();
    if (!name) return;
    busy = "proj";
    try {
      let r;
      // Stack + kategori hanya diisi untuk prompt & upload PRD;
      // repo/zip mengikuti kode yang diunggah (stack terdeteksi, kategori ditebak).
      const withStack = projMode === "prompt" || projMode === "prd";
      if (projMode === "prompt" || projMode === "repo") {
        if (projMode === "prompt" && !projPrompt.trim()) return;
        if (projMode === "repo" && !projRepo.trim()) return;
        r = await api("/api/projects", {
          method: "POST",
          body: JSON.stringify({
            name,
            ...(withStack ? { stack: projStack, categories: projCats } : {}),
            ...(projMode === "repo" ? { repoUrl: projRepo.trim() } : {}),
            ...(projPrompt.trim() ? { prompt: projPrompt.trim() } : {}),
          }),
        });
      } else {
        if (!projFile) return;
        const fd = new FormData();
        fd.append("name", name);
        if (withStack) {
          fd.append("stack", JSON.stringify(projStack));
          fd.append("categories", JSON.stringify(projCats));
        }
        if (projPrompt.trim()) fd.append("prompt", projPrompt.trim());
        fd.append("file", projFile, projFile.name);
        r = await fetch(projMode === "zip" ? "/api/projects/upload" : "/api/projects/prd", {
          method: "POST", credentials: "include", body: fd,
        });
        if (r.status === 401) { authed = false; return; }
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        projErr = j.error || "failed to create project";
        return;
      }
      const auto = projMode === "prompt" || projMode === "prd" || !!projPrompt.trim();
      projMsg = auto ? `✓ "${name}" created — pipeline running, watch it in review.` : `✓ "${name}" created.`;
      projName = "";
      projPrompt = "";
      projRepo = "";
      projFile = null;
      projStack = { fe: "svelte", be: "laravel", db: "postgresql", css: "tailwind" };
      projCats = { fungsi: [], bisnis: [], arsitektur: [], target: [], interaksi: [] };
      const fi = document.getElementById("pfile") as HTMLInputElement | null;
      if (fi) fi.value = "";
      await load();
      projTab = "list";
      goReview(name);
    } finally {
      busy = "";
    }
  }

  async function pipeAct(name: string, action: string) {
    projErr = "";
    revErr = "";
    busy = "pipe";
    try {
      const r = await api(`/api/projects/${encodeURIComponent(name)}/pipeline`, {
        method: "POST", body: JSON.stringify({ action }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        revErr = j.error || "failed";
        return;
      }
      await load();
    } finally {
      busy = "";
    }
  }

  async function sendFollowup() {
    if (!fTarget || !fText.trim()) return;
    revErr = "";
    busy = "fup";
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(fTarget)}/followup`, {
        method: "POST", body: JSON.stringify({ prompt: fText.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        revErr = "✕ " + (j.error || "failed to send");
        return;
      }
      fTarget = null;
      fText = "";
      await load();
    } catch (e) {
      revErr = "✕ " + (e instanceof Error ? e.message : "send failed");
    } finally {
      busy = "";
    }
  }

  async function instruct() {
    if (!revProj || !instructText.trim()) return;
    revErr = "";
    busy = "ins";
    try {
      const p = instructText.trim();
      const r = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ title: `instructions @${revProj}: ${p.slice(0, 60)}`, prompt: p, project: revProj }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        revErr = j.error || "failed to send";
        return;
      }
      instructText = "";
      await load();
    } finally {
      busy = "";
    }
  }

  async function cancel(id: string) {
    if (!confirm(`Stop task ${id}? The muse process will be killed.`)) return;
    await act(`/api/tasks/${encodeURIComponent(id)}/cancel`, {});
  }

  async function reviewTask(id: string) {
    busy = "rev";
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(id)}/reviewed`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || "review failed");
        return;
      }
      await load();
    } finally {
      busy = "";
    }
  }

  async function runTask(id: string) {
    busy = "run";
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(id)}/rerun`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || "run failed");
        return;
      }
      await load();
    } finally {
      busy = "";
    }
  }

  async function delTask(id: string, title: string) {
    if (!confirm(`Delete task ${id} (${title})? It will be removed from the stack entirely (no history).`)) return;
    busy = "del";
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || "delete failed");
        return;
      }
      if (detailId === id) detailId = null;
      if (logId === id) closeLog();
      await load();
    } finally {
      busy = "";
    }
  }

  async function sendCorrect() {
    if (!cTarget || !cText.trim()) return;
    if (!confirm(`Correct task ${cTarget}? The running process will be stopped, your note appended to its prompt, and the task requeued.`)) return;
    cErr = "";
    busy = "correct";
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(cTarget)}/correct`, {
        method: "POST", body: JSON.stringify({ correction: cText.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        cErr = "✕ " + (j.error || "correction rejected (task already finished?)");
        return;
      }
      cTarget = null;
      cText = "";
      await load();
    } finally {
      busy = "";
    }
  }

  function openLog(id: string) {
    closeLog();
    logId = id;
    logLines = [];
    logDone = false;
    es = new EventSource(`/api/tasks/${encodeURIComponent(id)}/log`);
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.lines?.length) logLines = [...logLines, ...d.lines].slice(-300);
        if (d.done) { logDone = true; es?.close(); }
      } catch { /* abaikan frame rusak */ }
    };
  }
  function closeLog() {
    if (es) { try { es.close(); } catch { /* abaikan */ } es = null; }
    logId = null;
  }

  async function openReview(name: string) {
    revProj = name;
    revTab = "tugas";
    expandedDirs = {};
    revDiff = null;
    revFiles = [];
    revFilePath = "";
    revContent = "";
    revErr = "";
    mcpInfo = null;
    fTarget = null;
    fText = "";
    instructText = "";
    showNote = null;
    try {
      const [d, f, m, pv] = await Promise.all([
        (await api(`/api/projects/${encodeURIComponent(name)}/diff`)).json(),
        (await api(`/api/projects/${encodeURIComponent(name)}/files`)).json(),
        (await api(`/api/projects/${encodeURIComponent(name)}/mcps`)).json(),
        (await api(`/api/projects/${encodeURIComponent(name)}/preview`)).json(),
      ]);
      revDiff = d;
      revFiles = Array.isArray(f) ? f : [];
      mcpInfo = m?.servers ? m : { servers: [], enabled: [], failed: true };
      pvInfo = pv?.state ? pv : null;
      pvCmd = pv?.savedCmd || pv?.cmd || "";
      showPvLog = false;
    } catch {
      revErr = "failed to load review";
    }
  }

  async function pvRefresh() {
    if (!revProj || pvBusy) return;
    try {
      const r = await api(`/api/projects/${encodeURIComponent(revProj)}/preview`);
      const j = await r.json();
      if (r.ok && j?.state) {
        pvInfo = j;
        if (j.savedCmd && !pvCmd) pvCmd = j.savedCmd;
        else if (j.cmd && !pvCmd) pvCmd = j.cmd;
      }
    } catch { /* abaikan: tombol segarkan tersedia */ }
  }

  async function pvStart() {
    if (!revProj || pvBusy || !pvCmd.trim()) return;
    pvBusy = true;
    try {
      const r = await api(`/api/projects/${encodeURIComponent(revProj)}/preview`, {
        method: "POST", body: JSON.stringify({ action: "start", cmd: pvCmd.trim() }),
      });
      const j = await r.json();
      if (!r.ok && !j?.state) {
        revErr = j.error || "failed to start preview";
        return;
      }
      revErr = "";
      pvFrameKey++;
      await pvRefreshBusy();
    } catch {
      revErr = "failed to start preview";
    } finally {
      pvBusy = false;
    }
  }

  async function pvRefreshBusy() {
    // segarkan tanpa penjaga pvBusy (dipakai tepat setelah start/stop)
    if (!revProj) return;
    try {
      const r = await api(`/api/projects/${encodeURIComponent(revProj)}/preview`);
      const j = await r.json();
      if (r.ok && j?.state) pvInfo = j;
    } catch { /* abaikan */ }
  }

  async function pvLink() {
    if (!revProj || pvBusy) return;
    pvBusy = true;
    try {
      const r = await api(`/api/projects/${encodeURIComponent(revProj)}/preview`, {
        method: "POST", body: JSON.stringify({ action: "link" }),
      });
      const j = await r.json();
      if (!r.ok) {
        revErr = j.error || "failed to link to lerd";
        return;
      }
      revErr = "";
      await pvRefresh();
    } catch {
      revErr = "failed to link to lerd";
    } finally {
      pvBusy = false;
    }
  }

  async function pvStop() {
    if (!revProj || pvBusy) return;
    pvBusy = true;
    try {
      await api(`/api/projects/${encodeURIComponent(revProj)}/preview`, {
        method: "POST", body: JSON.stringify({ action: "stop" }),
      });
      await pvRefreshBusy();
    } catch {
      revErr = "failed to stop preview";
    } finally {
      pvBusy = false;
    }
  }

  async function toggleMcp(id: string) {
    if (!revProj || !mcpInfo?.servers || mcpBusy) return;
    mcpBusy = true;
    try {
      const cur = new Set(mcpInfo.enabled || []);
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      const r = await api(`/api/projects/${encodeURIComponent(revProj)}/mcps`, {
        method: "PUT", body: JSON.stringify({ mcps: [...cur] }),
      });
      const j = await r.json();
      if (!r.ok) {
        revErr = j.error || "failed to update MCP";
        return;
      }
      mcpInfo = j;
      revErr = "";
    } catch {
      revErr = "failed to update MCP";
    } finally {
      mcpBusy = false;
    }
  }
  function closeReview() {
    revProj = null;
  }
  function goReview(name: string) {
    view = "projects";
    openReview(name);
  }
  function goLog(id: string) {
    view = "tasks";
    openLog(id);
  }
  function pipeCls(st: string) {
    return st === "running" ? "v-ok" : st === "paused" ? "v-warn" : st === "done" ? "v-ok" : "v-err";
  }
  async function openFile(path: string) {
    if (!revProj) return;
    revFilePath = path;
    revContent = "loading…";
    try {
      const r = await api(`/api/projects/${encodeURIComponent(revProj)}/file?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      revContent = r.ok ? j.content : `✕ ${j.error || "failed"}`;
    } catch {
      revContent = "✕ failed to load";
    }
  }

  async function delProject(name: string) {
    if (!confirm(`Delete project "${name}" from the workspace?`)) return;
    busy = "del:" + name;
    try {
      await api("/api/projects/" + encodeURIComponent(name), { method: "DELETE" });
      if (taskProject === name) taskProject = "";
      await load();
    } finally {
      busy = "";
    }
  }

  function deadline(a: Approval) {
    if (!meta) return 0;
    if (a.stage === "web") return Date.parse(a.createdAt) + meta.approvalWebMinutes * 60000;
    return Date.parse(a.escalatedAt || a.createdAt) + meta.approvalTelegramMinutes * 60000;
  }
  function fmt(ms: number) {
    if (ms <= 0) return "0:00";
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function dur(sec: number) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + "h " : "") + (m ? m + "m " : "") + s + "s";
  }
  function gb(b: number) {
    return (b / 1073741824).toFixed(1) + " GB";
  }
  function fmtTok(n: number) {
    n = Math.round(n || 0);
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : "" + n;
  }
  function tokOf(t: StackTask) {
    return (t.usage?.tokIn || 0) + (t.usage?.tokOut || 0);
  }
  function actsOf(id: string) {
    return (snap?.activity?.[id] || []).slice(-40);
  }
  function lastAct(id: string) {
    const arr = snap?.activity?.[id] || [];
    return arr.length ? arr[arr.length - 1].text : "";
  }
  function actCls(a: TaskActivity) {
    if (a.kind === "file") return "v-ok";
    if (a.kind === "note" || a.text.includes("✕")) return "v-err";
    return "v-dim";
  }
  function filesTouched(id: string) {
    const out: string[] = [];
    for (const a of snap?.activity?.[id] || []) {
      if (a.kind !== "file") continue;
      const p = a.text.replace(/^(new|modified): /, "");
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }
  function evCls(e: string) {
    if (/done|\bOK\b|resum|wake/i.test(e)) return "v-ok";
    if (/fail|reject|error|cancel/i.test(e)) return "v-err";
    if (/limit|escalat|auto|approval|sleep/i.test(e)) return "v-warn";
    return "v-dim";
  }
  function ago(iso: string) {
    if (!iso) return "—";
    const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.floor(m / 60)}h ago`;
  }
  function tlKind(msg: string) {
    if (/attempt/.test(msg)) return { label: "Coding", cls: "v-ok" };
    if (/^done /.test(msg)) return { label: "Completed", cls: "v-ok" };
    if (/failed|REJECT|cancel/.test(msg)) return { label: "Failed", cls: "v-err" };
    if (/auto-decision/.test(msg)) return { label: "Auto decision", cls: "v-warn" };
    if (/escalat/.test(msg)) return { label: "Escalated", cls: "v-warn" };
    if (/approval\?/.test(msg)) return { label: "Waiting approval", cls: "v-warn" };
    if (/approval OK|approved/.test(msg)) return { label: "Approved", cls: "v-ok" };
    if (/limit/.test(msg)) return { label: "Token limit", cls: "v-warn" };
    if (/resume|wake/.test(msg)) return { label: "Resuming", cls: "v-ok" };
    if (/^push /.test(msg)) return { label: "Queued", cls: "v-dim" };
    if (/pipeline .* DONE/.test(msg)) return { label: "Pipeline done", cls: "v-ok" };
    if (/pipeline .* FAILED|pipeline .* stopped/.test(msg)) return { label: "Pipeline failed", cls: "v-err" };
    if (/pipeline .* →/.test(msg)) return { label: "Next phase", cls: "v-ok" };
    if (/^pipeline /.test(msg)) return { label: "Pipeline", cls: "v-dim" };
    if (/project \+/.test(msg)) return { label: "Project added", cls: "v-ok" };
    if (/project -/.test(msg)) return { label: "Project removed", cls: "v-err" };
    if (/sleep/.test(msg)) return { label: "Sleeping", cls: "v-dim" };
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
  function palKey(e: KeyboardEvent) {
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
    if (!revProj) return;
    const t = setInterval(pvRefresh, 5000);
    return () => clearInterval(t);
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
    const keys = (e: KeyboardEvent) => {
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
    loadLimits();
    const t1 = setInterval(load, 5000);
    const t2 = setInterval(() => { now = Date.now(); }, 1000);
    return () => { clearInterval(t1); clearInterval(t2); };
  });

  let tasks = $derived((snap?.stack || []).filter((t) => ["queued", "running", "waiting_approval"].includes(t.status)).reverse());
  let doneCount = $derived((snap?.stack || []).filter((t) => t.status === "done").length);
  let failCount = $derived((snap?.stack || []).filter((t) => t.status === "failed").length);
  let sleeping = $derived(!!snap?.sleepUntil && Date.parse(snap.sleepUntil) > now);
  let current = $derived(
    (snap?.stack || []).find((t) => t.status === "running") ||
    (snap?.stack || []).find((t) => t.status === "waiting_approval") ||
    [...(snap?.stack || [])].reverse().find((t) => t.status === "queued") ||
    null
  );
  let aiState = $derived(
    (snap?.approvals?.length || 0) > 0 ? { label: "WAITING APPROVAL", cls: "v-warn" }
    : sleeping ? { label: "SLEEPING", cls: "v-dim" }
    : current?.status === "running" ? { label: "WORKING", cls: "v-ok" }
    : current ? { label: "READY", cls: "v-ok" }
    : { label: "IDLE", cls: "v-dim" }
  );
  let agentLabel = $derived(brain?.agent === "opencode" ? "OpenCode" : "Muse Code");
  let history = $derived((snap?.stack || []).filter((t) => t.status === "done" || t.status === "failed").slice(-5).reverse());
  let nextQueued = $derived([...(snap?.stack || [])].reverse().filter((t) => t.status === "queued").slice(0, 3));
  let recentEvents = $derived((snap?.events || []).slice(-4).reverse());
  let spark = $derived.by(() => {
    const h = cpuHist.length ? cpuHist : [0];
    return h.map((v, i) => `${(i * 260) / Math.max(1, h.length - 1)},${36 - (v / 100) * 32}`).join(" ");
  });
  let lastEventIso = $derived.by(() => {
    const evs = snap?.events || [];
    return evs.length ? evs[evs.length - 1].slice(0, 24) : "";
  });
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
      .filter((e) => !/graph →/.test(e.slice(25)))
      .filter((e) => /push |run |done |fail|reject|cancel|limit|resum|wake|approval|auto-decision|escalat|sleep|project [+-]|pipeline/.test(e.slice(25)))
      .slice(-10)
      .reverse()
      .map((e) => ({ t: e.slice(11, 19), ...tlKind(e.slice(25)) }))
  );
  let homeFiles = $derived.by(() => {
    if (!homeDiff?.repo || !homeDiff.stat) return null;
    return homeDiff.stat.split("\n").filter(Boolean).slice(0, 6).map((l) =>
      l.startsWith("new:") ? { mark: "+", cls: "v-ok", path: l.slice(4).trim() } : { mark: "~", cls: "v-warn", path: l.split("|")[0].trim() }
    );
  });
  let revPipe = $derived(projects.find((p) => p.name === revProj)?.pipeline || null);
  let revLang = $derived(revFilePath ? langOf(revFilePath) : "");
  let revHtml = $derived.by(() => {
    if (!revFilePath || !revContent || revContent === "memuat…" || revContent.startsWith("✕")) return null;
    return highlightCode(revContent, revFilePath);
  });
  let revTasks = $derived((snap?.stack || []).filter((t) => t.project === revProj).slice(-8).reverse());
  let palItems = $derived.by(() => {
    const q = palQ.trim().toLowerCase();
    const items = [
      ...VIEWS.map((v) => ({ label: `open ${v.label}`, hint: "view", run: () => { view = v.id; } })),
      ...projects.map((p) => ({ label: `review ${p.name}`, hint: "project", run: () => goReview(p.name) })),
      { label: "wake runtime", hint: "action", run: () => act("/api/wake", {}) },
      { label: "sleep 60 minutes", hint: "action", run: () => act("/api/sleep", { minutes: 60 }) },
      { label: "log out", hint: "action", run: () => logout() },
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
      <button class="ghost brain-badge" onclick={() => { view = "system"; }} title="active brain — click to change in System">
        {brain.agent} · {brain.bin} · {brain.model || "default"} · {brain.effort || "default"}
      </button>
    {/if}
    <span class="clock">{new Date(now).toLocaleString("en-US")}</span>
    <Button variant="ghost" onclick={openPal} title="command palette (Ctrl+K)">⌘K</Button>
    <Button variant="ghost" onclick={logout}>log out</Button>
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
    <div class="side-sec">projects · {projects.length}<button class="ghost plusbtn" onclick={() => { view = "projects"; }} title="add project">+</button></div>
    <div class="side-projs">
      {#if !projects.length}<span class="v-dim" style="font-size:12px">— empty —</span>{/if}
      {#each projects as p (p.name)}
        <button class="side-proj" onclick={() => goReview(p.name)} title="open review {p.name}">
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
          <div class="v-dim">{current?.title || "no active task"}</div>
        </div>
      </div>
      <div class="ph-meta">
        <div><span class="k">Agent</span><span>{agentLabel}</span></div>
        <div><span class="k">Session</span><span>{current ? current.id.slice(-6) : "—"}</span></div>
      </div>
      <span class="pill {aiState.cls}"><span class="pdot"></span>{aiState.label}</span>
    </div>

    {#if snap.approvals.length}
      {#each snap.approvals as a (a.id)}
        <div class="hero-alert" style="margin-top:12px">
          <span class="v-warn">◆ APPROVAL [{a.stage}]</span>
          <strong>{a.title}</strong>
          <span class="v-dim">{a.question}</span>
          <span class="countdown">{fmt(deadline(a) - now)}</span>
          <span class="hero-alert-btns">
            <button onclick={() => approve(a.id, true)} disabled={!!busy}>[approve]</button>
            <Button variant="danger" onclick={() => approve(a.id, false)} disabled={!!busy}>[reject]</Button>
          </span>
        </div>
      {/each}
    {/if}

    <div class="hrow hrow-3">
      <div class="panel">
        <h2>status</h2>
        <div class="statline"><span class="pulse"></span><span class="statbig {aiState.cls}">{aiState.label}</span></div>
        <div class="hint">
          {aiState.label === "WORKING" ? `${agentLabel} is working` : aiState.label === "WAITING APPROVAL" ? "needs your decision" : aiState.label === "SLEEPING" ? "quiet but alert" : "waiting for tasks"}
        </div>
        <svg class="spark" viewBox="0 0 260 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={spark} /></svg>
        <div class="row"><span class="k">task</span><span>{current?.title || "—"}</span></div>
        <div class="ministats">
          <div><span class="v-dim">runtime</span><b>{metrics ? dur(metrics.procUptimeSec) : "…"}</b></div>
          <div><span class="v-dim">activity</span><b>{ago(lastEventIso)}</b></div>
          <div><span class="v-dim">token ±</span><b>~{fmtTok((snap?.usage?.tokIn || 0) + (snap?.usage?.tokOut || 0))}</b></div>
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
        <div class="toknum">~{fmtTok((snap?.usage?.tokIn || 0) + (snap?.usage?.tokOut || 0))}</div>
        <div class="splitbar">
          <div class="spin" style="width:{(((snap.usage?.tokIn || 0) / (((snap?.usage?.tokIn || 0) + (snap?.usage?.tokOut || 0)) || 1)) * 100).toFixed(1)}%"></div>
          <div class="spout" style="width:{(((snap.usage?.tokOut || 0) / (((snap?.usage?.tokIn || 0) + (snap?.usage?.tokOut || 0)) || 1)) * 100).toFixed(1)}%"></div>
        </div>
        <div class="hint">{snap.usage?.runs || 0} runs · estimated ±3.5 chars/token</div>
      </div>
      <div class="panel">
        <h2>otonomi</h2>
        <div class="row"><span class="k">escalation</span><span>web {meta?.approvalWebMinutes ?? 3} → tg {meta?.approvalTelegramMinutes ?? 3} → {meta?.approvalAutodecide === false ? "wait" : "auto"}</span></div>
        <div class="row"><span class="k">graph</span>{#if meta?.graphEnabled === false}<span class="v-dim">single-shot</span>{:else}<span class="v-ok">plan→review · {meta?.graphMaxRounds ?? 3} rounds</span>{/if}</div>
        <div class="row"><span class="k">mode</span>{#if meta?.dryRun}<span class="v-warn">DRY-RUN</span>{:else}<span class="v-ok">live</span>{/if}</div>
        <div class="row"><span class="k">pending approvals</span><span class={snap.approvals.length ? "v-warn" : "v-ok"}>{snap.approvals.length}</span></div>
        <div class="btnrow">
          {#if current?.status === "running"}
            <Button variant="danger" onclick={() => cancel(current.id)} disabled={!!busy}>[stop]</Button>
          {/if}
          <Button variant="ghost" onclick={() => act("/api/wake", {})} disabled={!!busy}>wake</Button>
          <Button variant="ghost" onclick={() => act("/api/sleep", { minutes: Number(sleepMin) || 60 })} disabled={!!busy}>sleep</Button>
          <input type="number" bind:value={sleepMin} min="1" max="1440" style="width:64px" aria-label="sleep minutes" />
        </div>
      </div>
    </div>

    <div class="hrow hrow-3">
      <div class="panel">
        <h2>running_task</h2>
        <div class="ic-title">{current?.title || "—"}{current?.project ? ` @${current.project}` : ""}</div>
        {#if roundPct != null}
          <div class="prog"><div class="progfill" style="width:{roundPct}%"></div></div>
          <div class="hint">round {(current?.graph?.iteration ?? 0) + 1}/{meta?.graphMaxRounds}</div>
        {:else}
          <div class="hint">{current ? current.status : "no tasks"}</div>
        {/if}
        <div class="toklabel" style="margin-top:10px">last_output</div>
        <div class="hint">{current && (snap.logs[current.id] || []).length ? (snap.logs[current.id] || []).slice(-1)[0].slice(0, 120) : "—"}</div>
        <div class="toklabel" style="margin-top:10px">files</div>
        {#if !current?.project}
          <span class="v-dim">—</span>
        {:else if !homeDiff}
          <span class="v-dim">loading…</span>
        {:else if !homeDiff.repo}
          <span class="v-dim">not a git repo.</span>
        {:else if !homeFiles?.length}
          <span class="v-dim">clean — no changes.</span>
        {:else}
          {#each homeFiles as f}
            <div class="row"><span class={f.cls}>{f.mark}</span><span>{f.path}</span></div>
          {/each}
        {/if}
        {#if current && (current.status === "running" || current.status === "queued")}
          {#if cTarget === current.id}
            <label for="cor">correct {current.id} — stops the run, amends the prompt, requeues</label>
            <div style="display:flex; gap:8px">
              <input id="cor" type="text" bind:value={cText} placeholder="e.g. pakai Elysia, bukan Express" />
              <button onclick={sendCorrect} disabled={busy === "correct" || !cText.trim()} style="white-space:nowrap">[send]</button>
              <Button variant="ghost" onclick={() => { cTarget = null; cText = ""; cErr = ""; }}>[cancel]</Button>
            </div>
            {#if cErr}<div class="hint" style="color:var(--err, #f66)">{cErr}</div>{/if}
          {:else}
            <div class="btnrow"><Button variant="ghost" onclick={() => { cTarget = current.id; cText = ""; cErr = ""; }} disabled={!!busy}>[correct]</Button></div>
          {/if}
        {/if}
      </div>
      <div class="panel">
        <h2>activity_stream</h2>
        <div class="events timeline">
          {#each (snap.events || []).slice(-9).reverse() as e}
            <div><span class="tdot {evCls(e)}"></span><span class="ttime">{e.slice(11, 19)}</span><span>{e.slice(20, 90)}</span></div>
          {/each}
        </div>
        <div class="btnrow"><Button variant="ghost" onclick={() => { view = "tasks"; }}>open tasks →</Button></div>
      </div>
      <div class="panel">
        <h2>runtime_timeline</h2>
        <div class="events timeline tlrail">
          {#if !timeline.length}<span class="v-dim">no milestones yet.</span>{/if}
          {#each timeline as tl}
            <div><span class="tdot {tl.cls}"></span><span>{tl.label}</span><span class="ttime" style="margin-left:auto">{tl.t}</span></div>
          {/each}
        </div>
      </div>
    </div>

    <div class="hrow hrow-term">
      <div class="panel">
        <h2>terminal</h2>
        <Tabs.Root bind:value={termTab} aria-label="terminal views">
          <Tabs.List>
            <Tabs.Trigger value="term">terminal</Tabs.Trigger>
            <Tabs.Trigger value="logs">logs</Tabs.Trigger>
            <Tabs.Trigger value="out">output</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="term" tabindex={0}>
            <pre class="dump termview">{current && (snap.logs[current.id] || []).length ? (snap.logs[current.id] || []).slice(-30).join("\n") : "waiting for output…"}</pre>
          </Tabs.Content>
          <Tabs.Content value="logs" tabindex={0}>
            <pre class="dump termview">{report}</pre>
          </Tabs.Content>
          <Tabs.Content value="out" tabindex={0}>
            <pre class="dump termview">{history[0]?.note || "—"}</pre>
          </Tabs.Content>
        </Tabs.Root>
      </div>
      <div class="hside">
        <div class="panel">
          <h2>project</h2>
          <div class="minititle">▤ {current?.project || "—"}</div>
          <div class="row"><span class="k">runtime</span><span>{agentLabel}</span></div>
          <div class="row"><span class="k">session</span><span>{current ? current.id.slice(-6) : "—"}</span></div>
          <div class="row"><span class="k">activity</span><span>{ago(lastEventIso)}</span></div>
        </div>
        <div class="panel">
          <h2>agent</h2>
          <div class="minititle">✦ {agentLabel.toUpperCase()} <span class={meta?.brain?.ok ? "v-ok" : "v-err"}>● {meta?.brain?.ok ? "Connected" : "Offline"}</span></div>
          <div class="row"><span class="k">runtime</span><span>{aiState.label}</span></div>
          <div class="row"><span class="k">can</span><span class="v-dim">coding · graph · resume · estimates</span></div>
        </div>
      </div>
    </div>

    {:else if view === "tasks"}
    <div class="grid" style="margin-top:0">
      <div class="panel {snap.approvals.length ? 'alert' : ''}">
        <h2>pending_approvals</h2>
        {#if !snap.approvals.length}
          <span class="v-dim">empty — web {meta?.approvalWebMinutes ?? 3} min → telegram {meta?.approvalTelegramMinutes ?? 3} min → auto.</span>
        {:else}
          {#each snap.approvals as a (a.id)}
            <div class="approval">
              <div class="meta">[{a.stage}] {a.id}</div>
              <div><strong>{a.title}</strong></div>
              <div class="q">{a.question}</div>
              <div class="meta">
                {#if a.stage === "web"}
                  escalating to telegram in <span class="countdown">{fmt(deadline(a) - now)}</span>
                {:else}
                  auto-decision in <span class="countdown">{fmt(deadline(a) - now)}</span>
                {/if}
              </div>
              <div class="btnrow">
                <button onclick={() => approve(a.id, true)} disabled={!!busy}>[approve]</button>
                <Button variant="danger" onclick={() => approve(a.id, false)} disabled={!!busy}>[reject]</Button>
              </div>
            </div>
          {/each}
        {/if}
      </div>
      <div class="panel">
        <h2>add_task</h2>
        <div class="task-add">
          <label for="judul">title</label>
          <input id="judul" type="text" bind:value={title} placeholder="e.g. fix login" />
          <label for="pr">full prompt (stored → auto-resumes; any language — translated to English)</label>
          <input id="pr" type="text" bind:value={prompt} placeholder="do X in repo Y…" />
          <label for="pj">project (optional — muse works inside that folder)</label>
          <select id="pj" bind:value={taskProject}>
            <option value="">— no project (Althea root) —</option>
            {#each projects as p (p.name)}
              <option value={p.name}>{p.name} [{p.stack}]</option>
            {/each}
          </select>
        </div>
        <div class="btnrow"><button onclick={addTask} disabled={!!busy || !prompt.trim()}>[push to stack]</button></div>
      </div>
    </div>
    <div class="grid" style="margin-top:12px">
      <div class="panel">
        {#snippet taskDetail(t: StackTask)}
          <div style="margin:2px 0 12px">
            <div class="hint">prompt</div>
            <pre class="dump" style="max-height:120px; margin:4px 0 10px">{t.prompt}</pre>
            {#if filesTouched(t.id).length}
              <div class="hint">touched files ({filesTouched(t.id).length})</div>
              <div class="hint" style="margin:2px 0 10px">
                {#each filesTouched(t.id).slice(0, 12) as f}<span class="v-ok">{f}</span>{"  "}{/each}
                {#if filesTouched(t.id).length > 12}<span class="v-dim">+{filesTouched(t.id).length - 12} more</span>{/if}
              </div>
            {/if}
            <div class="hint">activity ({(snap?.activity?.[t.id] || []).length})</div>
            {#if !actsOf(t.id).length}
              <div class="hint" style="margin:4px 0">nothing yet — appears when althea calls tools/touches files.</div>
            {:else}
              <div class="events" style="margin:4px 0">
                {#each actsOf(t.id) as a}
                  <div><span class="ttime">{a.t}</span><span class={actCls(a)}>{a.text}</span></div>
                {/each}
              </div>
            {/if}
            {#if t.note}
              <div class="hint">result</div>
              <pre class="dump" style="max-height:120px; margin:4px 0">{t.note}</pre>
            {/if}
          </div>
        {/snippet}
        <h2>active_stack</h2>
        {#if !tasks.length}<span class="v-dim">empty.</span>{/if}
        {#each tasks as t (t.id)}
          <div class="row">
            <span class={t.status === "waiting_approval" ? "v-warn" : t.status === "running" ? "v-ok" : "v-dim"}>
              {t.status === "running" ? "▶" : t.status === "waiting_approval" ? "◆" : "·"}
              {t.status}
            </span>
            <span>{t.title}{t.project ? ` @${t.project}` : ""}
              {#if lastAct(t.id)}<span class="v-dim" style="font-size:12px"> — {lastAct(t.id).slice(0, 60)}</span>{/if}
            </span>
            <span class="v-dim" style="font-size:12px">~{fmtTok(tokOf(t))}</span>
            <span style="margin-left:auto; display:flex; gap:6px">
              <Button variant="ghost" onclick={() => { detailId = detailId === t.id ? null : t.id; }}>[detail]</Button>
              <Button variant="ghost" onclick={() => openLog(t.id)}>[log]</Button>
              <Button variant="ghostDanger" onclick={() => cancel(t.id)} disabled={!!busy}>[stop]</Button>
              <Button variant="ghostDanger" onclick={() => delTask(t.id, t.title)} disabled={!!busy}>[delete]</Button>
            </span>
          </div>
          {#if detailId === t.id}{@render taskDetail(t)}{/if}
        {/each}
        <h2 style="margin-top:14px">riwayat</h2>
        {#if !history.length}<span class="v-dim">none yet.</span>{/if}
        {#each history as t (t.id)}
          <div class="row">
            <span class={t.status === "done" ? "v-ok" : "v-err"}>{t.status === "done" ? "✓" : "✕"} {t.status}</span>
            <span>{t.title}{t.project ? ` @${t.project}` : ""}</span>
            <span class="v-dim" style="font-size:12px">~{fmtTok(tokOf(t))}</span>
            <span style="margin-left:auto; display:flex; gap:6px">
              <Button variant="ghost" onclick={() => { detailId = detailId === t.id ? null : t.id; }}>[detail]</Button>
              <Button variant="ghost" onclick={() => openLog(t.id)}>[log]</Button>
              <Button variant="ghost" onclick={() => runTask(t.id)} disabled={!!busy} title="requeue without changing the prompt">[run]</Button>
              {#if !t.reviewedAt}
                <Button variant="ghost" onclick={() => reviewTask(t.id)} disabled={!!busy} title="mark this finished task as reviewed">[review]</Button>
              {:else}
                <span class="v-dim" title="reviewed">✓</span>
              {/if}
              <Button variant="ghostDanger" onclick={() => delTask(t.id, t.title)} disabled={!!busy}>[delete]</Button>
            </span>
          </div>
          {#if detailId === t.id}{@render taskDetail(t)}{/if}
        {/each}
      </div>
      <div class="panel">
        <h2>live_log</h2>
        {#if logId}
          <div class="hint" style="margin-bottom:8px">{logId} {logDone ? "[done]" : "[streaming…]"}</div>
          <pre class="dump logview" id="logpre">{logLines.length ? logLines.join("\n") : "waiting for output…"}</pre>
          <div class="btnrow"><Button variant="ghost" onclick={closeLog}>[close]</Button></div>
        {:else}
          <span class="v-dim">Pick [log] on a task to stream muse output here.</span>
        {/if}
      </div>
    </div>

    {:else if view === "projects"}
    <div class="panel projtop">
      <div class="revhead">
        <h2 style="margin:0">workspace_projects · {projects.length}</h2>
      </div>
      <Tabs.Root bind:value={projTab} aria-label="project pages">
        <Tabs.List>
          <Tabs.Trigger value="list">project list</Tabs.Trigger>
          <Tabs.Trigger value="baru" onclick={() => { projErr = ""; }}>+ new project</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="list">
        {#if !projects.length}
          <div class="pempty">no projects yet — switch to the <Button variant="ghost" onclick={() => { projTab = "baru"; }}>+ new project</Button> tab to create one from prompt, repo, zip, or PRD.</div>
        {:else}
          <div class="projgrid">
          {#each projects as p (p.name)}
            {@const badge = pipeBadge(p)}
            {@const cats = catBadges(p)}
            <Card.Root variant="nested" class="flex flex-col gap-2 min-w-0 px-3 py-2.5 transition-colors duration-150 hover:border-border">
              <div class="pcard-head">
                <span class="pgrow"><span class="pname">{p.name}</span></span>
                <span class="pill {badge.cls}" title={badge.title}><span class="pdot"></span>{badge.text}</span>
              </div>
              <div class="pstack">{stackText(p)}</div>
              {#if cats.shown.length}
                <div class="minibadges">
                  {#each cats.shown as c}<span class="minibadge">{c}</span>{/each}
                  {#if cats.extra}<span class="minibadge more">+{cats.extra} more</span>{/if}
                </div>
              {/if}
              <div class="psource">{p.source}</div>
              <div class="pcard-foot">
                <button onclick={() => openReview(p.name)}>[review]</button>
                <Button variant="danger" onclick={() => delProject(p.name)} disabled={!!busy}>[delete]</Button>
              </div>
            </Card.Root>
          {/each}
          </div>
        {/if}
        </Tabs.Content>
        <Tabs.Content value="baru">
      <Card.Root variant="nested" class="mt-3 px-4 py-3.5">
        <div class="fsect">1 · basics</div>
        <label for="pn">project name</label>
        <input id="pn" class="bigname" type="text" bind:value={projName} placeholder="e.g. pos-kasir — lowercase, no spaces" autocomplete="off" />
        <div class="fhelp">The name becomes the folder in workspace/{#if projMode === "prompt" || projMode === "prd"} — and the .test address (name.test) once its dev server runs on the preview port{/if}.</div>
      </Card.Root>
      <Card.Root variant="nested" class="mt-3 px-4 py-3.5">
        <div class="fsect">2 · source</div>
        <Tabs.Root bind:value={projMode} aria-label="project source">
          <Tabs.List>
            {#each MODES as m}
              <Tabs.Trigger value={m.id} onclick={() => { projErr = ""; }}>{m.label}</Tabs.Trigger>
            {/each}
          </Tabs.List>
          <Tabs.Content value="prompt">
          <label for="pp">idea / prompt — althea drafts PRD → MVP → features → release (any language — translated to English)</label>
          <textarea id="pp" bind:value={projPrompt} placeholder="build a POS app for a stall: cashier, stock, daily reports"></textarea>
          </Tabs.Content>
          <Tabs.Content value="repo">
          <label for="pru">link repo (https://… / git@…)</label>
          <input id="pru" type="text" bind:value={projRepo} placeholder="https://github.com/aku/repo.git" autocomplete="off" />
          <label for="prp">initial prompt (optional — empty = just clone)</label>
          <input id="prp" type="text" bind:value={projPrompt} placeholder="continue building feature X…" />
          <div class="fhelp">Stack follows the cloned code; categories are auto-detected when a PRD exists.</div>
          </Tabs.Content>
          <Tabs.Content value="zip">
          <label for="pfile">zip file (max {meta?.projectMaxMb ?? 50} MB)</label>
          <input id="pfile" type="file" accept=".zip" onchange={(e) => { projFile = e.currentTarget.files?.[0] || null; }} />
          <label for="pzp">initial prompt (optional — empty = just extract)</label>
          <input id="pzp" type="text" bind:value={projPrompt} placeholder="continue building…" />
          <div class="fhelp">Stack follows the uploaded code; categories are auto-detected when a PRD exists.</div>
          </Tabs.Content>
          <Tabs.Content value="prd">
          <label for="pfile">PRD file (.md / .txt, max 2 MB) — runs MVP straight away</label>
          <input id="pfile" type="file" accept=".md,.markdown,.txt" onchange={(e) => { projFile = e.currentTarget.files?.[0] || null; }} />
          <label for="ppp">goal (optional — default: implement this PRD)</label>
          <input id="ppp" type="text" bind:value={projPrompt} placeholder="focus on…" />
          </Tabs.Content>
        </Tabs.Root>
      </Card.Root>
      {#if projMode === "prompt" || projMode === "prd"}
      <Card.Root variant="nested" class="mt-3 px-4 py-3.5">
        <div class="fsect">3 · tech_stack</div>
        <div class="fhelp">Click to pick per layer. Laravel backend = preview via lerd (name.test); other backends preview via their own dev server.</div>
        {#if meta?.stackOptions}
          <div class="stackgrid2">
            {#each STACK_DIMS as d}
              <div class="stackcell">
                <div class="stackdim">{d.label}</div>
                <div class="optbadges">
                  {#each meta.stackOptions[d.id] as o}
                    <Button variant="pick" active={projStack[d.id] === o.id} title={o.label} aria-pressed={projStack[d.id] === o.id} onclick={() => setStack(d.id, o.id)}>{shortOpt(o)}</Button>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {:else if !meta}
          <div class="hint">loading stack options…</div>
        {:else}
          <div class="hint">backend is still the old version — restart the backend then reload this page.</div>
        {/if}
        {#if projStack.be !== "laravel"}
          <div class="hint" style="margin-top:8px">non-Laravel backend — preview runs the project's dev server (no lerd); name.test opens it when the dev server binds the preview port.</div>
        {/if}
      </Card.Root>
      <Card.Root variant="nested" class="mt-3 px-4 py-3.5">
        <div class="fsect">4 · app_categories</div>
        <div class="fhelp">Several allowed per dimension. Emptied dimensions are guessed by AI from the PRD.</div>
        {#if meta?.categoryTaxonomy}
          {#each CAT_DIMS as dim}
            <details class="catdim">
              <summary>{meta.categoryDimLabels?.[dim] || dim}{#if (projCats[dim] || []).length} · {(projCats[dim] || []).length} selected{/if}</summary>
              <div class="pickrow">
                {#each meta.categoryTaxonomy[dim] as o}
                  {@const sel = (projCats[dim] || []).includes(o.id)}
                  <Button variant="pick" active={sel} aria-pressed={sel} onclick={() => toggleCat(dim, o.id)}>{o.label}</Button>
                {/each}
              </div>
            </details>
          {/each}
        {:else if !meta}
          <div class="hint">loading category taxonomy…</div>
        {:else}
          <div class="hint">backend is still the old version — restart the backend then reload this page.</div>
        {/if}
      </Card.Root>
      {/if}
      <div class="btnrow">
        <Button variant="cta"
          onclick={addProject}
          disabled={busy === "proj" || !projName.trim() ||
            (projMode === "prompt" && !projPrompt.trim()) ||
            (projMode === "repo" && !projRepo.trim()) ||
            ((projMode === "zip" || projMode === "prd") && !projFile)}
        >[create project]</Button>
      </div>
      {#if projErr}<div class="err">✕ {projErr}</div>{/if}
      {#if projMsg}<div class="hint v-ok" style="margin-top:8px">{projMsg}</div>{/if}
        </Tabs.Content>
      </Tabs.Root>
    </div>

    {#if revProj}
      <div class="panel" style="margin-top:12px">
        <div class="revhead">
          <h2 style="margin:0">review {revProj}</h2>
          <span style="margin-left:auto"><Button variant="ghost" onclick={closeReview}>[close]</Button></span>
        </div>
        {#if revErr}<div class="err">✕ {revErr}</div>{/if}
        <Tabs.Root bind:value={revTab} aria-label="review sections">
          <Tabs.List>
            {#each REVTABS as t}
              <Tabs.Trigger value={t.id}>{t.label}{t.id === "tugas" && revTasks.length ? ` (${revTasks.length})` : ""}{t.id === "files" && revFiles.length ? ` (${revFiles.length})` : ""}</Tabs.Trigger>
            {/each}
          </Tabs.List>
          <Tabs.Content value="tugas">
        {#if revPipe}
          <div class="row">
            <span class="k">pipeline</span>
            <span class="pill {pipeCls(revPipe.status)}"><span class="pdot"></span>{revPipe.status}</span>
            <span class="v-dim">{revPipe.note || revPipe.goal}</span>
            <span style="margin-left:auto; display:flex; gap:6px">
              {#if revPipe.status === "running"}
                <button class="ghost warn" onclick={() => pipeAct(revProj!, "pause")} disabled={!!busy}>[pause]</button>
                <Button variant="ghostDanger" onclick={() => pipeAct(revProj!, "cancel")} disabled={!!busy}>[stop]</Button>
              {:else if revPipe.status === "paused"}
                <Button variant="ghost" onclick={() => pipeAct(revProj!, "resume")} disabled={!!busy}>[resume]</Button>
                <Button variant="ghostDanger" onclick={() => pipeAct(revProj!, "cancel")} disabled={!!busy}>[stop]</Button>
              {:else if revPipe.status === "failed"}
                <Button variant="ghost" onclick={() => pipeAct(revProj!, "resume")} disabled={!!busy}>[retry phase]</Button>
              {/if}
            </span>
          </div>
          {#each revPipe.phases as ph}
            <div class="row">
              <span class={ph.done ? "v-ok" : "v-dim"}>{ph.done ? "✓" : "○"}</span>
              <span>{ph.id}</span>
              <span class="v-dim">{ph.title}</span>
            </div>
          {/each}
          <div class="cardiv"></div>
        {/if}
        <h2>althea_activity</h2>
        {#if !revTasks.length}
          <span class="v-dim">no tasks for this project yet — send instructions below.</span>
        {:else}
          {#each revTasks as t (t.id)}
            <div class="row">
              <span class={t.status === "done" ? "v-ok" : t.status === "failed" ? "v-err" : t.status === "running" ? "v-ok" : "v-warn"}>
                {t.status === "done" ? "✓" : t.status === "failed" ? "✕" : t.status === "running" ? "▶" : "·"} {t.status}
              </span>
              <span>{t.title}</span>
              {#if t.phase}<span class="v-dim">[{t.phase}]</span>{/if}
              <span style="margin-left:auto; display:flex; gap:6px">
                {#if t.note}<Button variant="ghost" onclick={() => { showNote = showNote === t.id ? null : t.id; }}>[result]</Button>{/if}
                <Button variant="ghost" onclick={() => goLog(t.id)}>[log]</Button>
                <Button variant="ghost" onclick={() => { revActId = revActId === t.id ? null : t.id; }}>[tools]</Button>
                <Button variant="ghost" onclick={() => { fTarget = t.id; }}>[follow up]</Button>
                {#if t.status === "done" || t.status === "failed"}
                  <Button variant="ghost" onclick={() => runTask(t.id)} disabled={!!busy} title="requeue without changing the prompt">[run]</Button>
                {/if}
                {#if t.status === "done" && !t.reviewedAt}
                  <Button variant="ghost" onclick={() => reviewTask(t.id)} disabled={!!busy} title="mark this finished task as reviewed">[review]</Button>
                {:else if t.status === "done"}
                  <span class="v-dim" title="reviewed">✓</span>
                {/if}
                <Button variant="ghostDanger" onclick={() => delTask(t.id, t.title)} disabled={!!busy}>[delete]</Button>
              </span>
            </div>
            {#if showNote === t.id}
              <pre class="dump" style="max-height:160px; margin:6px 0">{t.note}</pre>
            {/if}
            {@const audit = summarizeToolCalls(snap?.activity?.[t.id] || [])}
            {#if audit.length}
              <div class="auditrow" title="this task's tool call summary — click [tools] for per-call details">
                <span class="v-dim">tool</span>
                {#each audit as au}
                  <span class="audititem" title={au.last || au.tool}>
                    {au.tool} ×{au.calls + au.pending}
                    {#if au.fail}<span class="v-err"> ✕{au.fail}</span>{/if}
                    {#if au.pending}<span class="v-warn"> …{au.pending}</span>{/if}
                    {#if !au.fail && !au.pending}<span class="v-ok"> ✓</span>{/if}
                  </span>
                {/each}
              </div>
            {/if}
            {#if revActId === t.id}
              <div class="hint" style="margin-top:6px">tool call details ({(snap.activity?.[t.id] || []).length}) — tool name + first result line (args are not exposed by the CLI)</div>
              {#if !actsOf(t.id).length}
                <div class="hint" style="margin:4px 0">nothing yet — appears when althea calls tools.</div>
              {:else}
                <div class="events" style="margin:4px 0">
                  {#each actsOf(t.id) as a}
                    <div><span class="ttime">{a.t}</span><span class={actCls(a)}>{a.kind === "tool" && a.tool ? `[${a.tool}] ` : ""}{a.text}</span></div>
                  {/each}
                </div>
              {/if}
            {/if}
          {/each}
        {/if}
        {#if fTarget}
          <label for="fup">follow up {fTarget} — althea runs it as a new task</label>
          <div style="display:flex; gap:8px">
            <input id="fup" type="text" bind:value={fText} placeholder="e.g. tidy the cashier view, add a print button" />
            <button onclick={sendFollowup} disabled={busy === "fup" || !fText.trim()} style="white-space:nowrap">[send]</button>
            <Button variant="ghost" onclick={() => { fTarget = null; fText = ""; }}>[cancel]</Button>
          </div>
        {/if}
        <label for="ins">ask althea — free-form instructions for this project</label>
        <div style="display:flex; gap:8px">
          <input id="ins" type="text" bind:value={instructText} placeholder="e.g. add a per-item discount feature" />
          <button onclick={instruct} disabled={busy === "ins" || !instructText.trim()} style="white-space:nowrap">[run]</button>
        </div>
          </Tabs.Content>
          <Tabs.Content value="mcp">
        <h2>mcp_server</h2>
        {#if !mcpInfo}
          <span class="v-dim">loading…</span>
        {:else if mcpInfo.failed}
          <span class="v-dim">failed to load the MCP list.</span>
        {:else if !mcpInfo.servers.length}
          <span class="v-dim">no MCPs registered.</span>
        {:else}
          {#each mcpInfo.servers as m (m.id)}
            <div class="row">
              <span class={m.enabled && m.runnable ? "v-ok" : m.enabled ? "v-warn" : "v-dim"}>
                {m.enabled ? (m.runnable ? "●" : "○") : "○"} {m.id}
              </span>
              <span class="v-dim">{m.desc}</span>
              {#if m.enabled && m.runnable === false}
                <span class="v-warn">not runnable</span>
              {/if}
              <span style="margin-left:auto">
                <Button variant="ghost" onclick={() => toggleMcp(m.id)} disabled={mcpBusy}>[{m.enabled ? "disable" : "enable"}]</Button>
              </span>
            </div>
            {#if m.enabled && m.runnable === false}
              <div class="hint">setup: {m.setupHint}</div>
            {/if}
          {/each}
          <div class="hint">Active MCPs are injected into the muse CLI settings.json while this project's tasks run.</div>
        {/if}
          </Tabs.Content>
          <Tabs.Content value="preview">
        <h2>preview_aplikasi</h2>
        {#if !pvInfo}
          <span class="v-dim">loading…</span>
        {:else if pvInfo.previewAvailable === false}
          <div class="hint">{pvInfo.cmdNote || "preview not available for this stack — add a «dev» script to package.json or enter a preview command."}</div>
        {:else if pvInfo.kind === "herd"}
          <div class="row">
            <span class="k">url</span>
            <span>{pvInfo.url}</span>
            {#if pvInfo.tabUrl || pvInfo.url}
              <a class="ghostlink" href={pvInfo.tabUrl || pvInfo.url || ""} target="_blank" rel="noreferrer">[open tab]</a>
            {/if}
            <span style="margin-left:auto; display:flex; gap:6px">
              <Button variant="ghost" onclick={pvLink} disabled={pvBusy}>[link to lerd]</Button>
            </span>
          </div>
          {#if pvInfo.lerdOk === false}
            <div class="hint">lerd not detected — make sure lerd is installed and `lerd start` is running so {pvInfo.url} can open.</div>
          {:else}
            <div class="hint">served by lerd ({pvInfo.url}) — needs `lerd start` + active .test DNS (`lerd dns:check`). Frontend assets must be built.</div>
          {/if}
        {:else}
          <div class="row">
            <span class="k">status</span>
            {#if pvInfo.state === "running"}
              <span class="pill v-ok"><span class="pdot"></span>running{pvInfo.mode === "static" ? " · static" : ` · :${pvInfo.port}`}</span>
            {:else if pvInfo.state === "starting"}
              <span class="pill v-warn"><span class="pdot"></span>starting…</span>
            {:else if pvInfo.state === "failed"}
              <span class="pill v-err"><span class="pdot"></span>failed</span>
            {:else}
              <span class="pill v-dim"><span class="pdot"></span>stopped</span>
            {/if}
            {#if (pvInfo.tabUrl || pvInfo.url) && pvInfo.state === "running"}
              <span class="v-ok" title="preview address — Caddy mem-proxy *.test ke port dev">{pvInfo.tabUrl || pvInfo.url}</span>
              <a class="ghostlink" href={pvInfo.tabUrl || pvInfo.url || ""} target="_blank" rel="noreferrer">[open tab]</a>
            {/if}
            <span style="margin-left:auto; display:flex; gap:6px">
              <Button variant="ghost" onclick={pvRefresh} disabled={pvBusy}>[refresh]</Button>
              {#if pvInfo.state === "running" && pvInfo.mode === "server"}
                <Button variant="ghost" onclick={() => { pvFrameKey++; }}>[reload]</Button>
              {/if}
              {#if (pvInfo.state === "running" || pvInfo.state === "starting") && pvInfo.mode !== "static"}
                <Button variant="ghostDanger" onclick={pvStop} disabled={pvBusy}>[stop]</Button>
              {/if}
            </span>
          </div>
          {#if pvInfo.error}<div class="err">✕ {pvInfo.error}</div>{/if}
          {#if pvInfo.state === "running" && pvInfo.reachable === false}
            <div class="hint">process is running but no preview port was detected — the app may bind a port outside its dev script. Check the log / adjust the command.</div>
          {:else if pvInfo.state === "running" && pvInfo.mode === "server"}
            <div class="hint">iframe opens 127.0.0.1:{pvInfo.port} directly (own origin — absolute paths keep working); [open tab] uses {pvInfo.tabUrl || pvInfo.url}.</div>
          {/if}
          {#if pvInfo.mode !== "static" || pvInfo.state !== "running"}
            <label for="pvcmd">preview command — runs in the project folder (write {"{port}"} if the app needs an explicit port)</label>
            <div style="display:flex; gap:8px">
              <input id="pvcmd" type="text" bind:value={pvCmd} placeholder="e.g. npm run dev" />
              <button onclick={pvStart} disabled={pvBusy || !pvCmd.trim()} style="white-space:nowrap">[start]</button>
            </div>
            {#if pvInfo.cmdNote}
              <div class="hint v-warn">{pvInfo.cmdNote}</div>
            {:else if !pvCmd.trim() && pvInfo.state === "stopped"}
              <div class="hint">this stack has no default command yet — enter one first, e.g. "go run ." or "npm run dev".</div>
            {/if}
          {:else}
            <div class="hint">static HTML project — served from port {pvInfo.port} (own origin).</div>
          {/if}
          {#if pvInfo.state === "running" && pvInfo.url}
            {#key pvFrameKey}
              <iframe class="pvframe" src={pvInfo.url} title="preview {revProj}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
            {/key}
          {/if}
          {#if pvInfo.logs?.length}
            <div class="btnrow" style="margin-top:8px">
              <Button variant="ghost" onclick={() => { showPvLog = !showPvLog; }}>[preview log ({pvInfo.logs.length})]</Button>
            </div>
            {#if showPvLog}
              <pre class="dump logview" style="margin-top:6px">{pvInfo.logs.slice(-100).join("\n")}</pre>
            {/if}
          {/if}
        {/if}
          </Tabs.Content>
          <Tabs.Content value="diff" tabindex={0}>
        {#if revDiff}
          {#if !revDiff.repo}
            <div class="hint">Not a git repo — no diff available. Browse the files below.</div>
          {:else}
            <pre class="dump" style="max-height:120px">{revDiff.stat}</pre>
            {#if revDiff.diff}
              <pre class="dump diffview">{#each revDiff.diff.split("\n").slice(0, 400) as ln}<span class={ln.startsWith("+") && !ln.startsWith("+++") ? "d-add" : ln.startsWith("-") && !ln.startsWith("---") ? "d-del" : ln.startsWith("@@") ? "d-hunk" : ""}>{ln}
</span>{/each}</pre>
            {/if}
          {/if}
        {:else}
          <span class="v-dim">loading diff…</span>
        {/if}
          </Tabs.Content>
          <Tabs.Content value="files">
        <h2>files ({revFiles.length})</h2>
        {#snippet treenode(node: TreeNode, depth: number)}
          {#each sortedNames(node.dirs) as d}
            {@const sub = node.dirs[d]}
            {@const open = dirOpen(sub.path, depth + 1)}
            <div class="treerow tdir" style="padding-left:{10 + depth * 14}px" onclick={() => toggleDir(sub.path, depth + 1)} onkeydown={(e) => e.key === "Enter" && toggleDir(sub.path, depth + 1)} role="button" tabindex="0" title={sub.path}>{open ? "▾" : "▸"} {d} <span class="v-dim">· {sub.count}</span></div>
            {#if open}{@render treenode(sub, depth + 1)}{/if}
          {/each}
          {#each [...node.files].sort((a, b) => (a.path < b.path ? -1 : 1)) as f (f.path)}
            <div class="treerow {revFilePath === f.path ? 'sel' : ''}" style="padding-left:{10 + depth * 14}px" onclick={() => openFile(f.path)} onkeydown={(e) => e.key === "Enter" && openFile(f.path)} role="button" tabindex="0" title={f.path}>{f.path.split("/").pop()} <span class="v-dim">· {(f.size / 1024).toFixed(1)} KB</span></div>
          {/each}
        {/snippet}
        <div class="grid grid-cols-12 gap-4" style="margin-top:0">
          <div class="col-span-12 md:col-span-4 overflow-y-auto h-[40vh] md:h-[80vh]">
            <div class="tree" style="max-height:none;height:100%">
              {#if !revFiles.length}
                <div class="treerow v-dim">— empty —</div>
              {:else}
                {@render treenode(fileTree, 0)}
              {/if}
            </div>
          </div>
          <div class="col-span-12 md:col-span-8 overflow-y-auto h-[40vh] md:h-[80vh]">
            {#if revFilePath}
              <h2 style="margin-top:0">{revFilePath}<span class="langbadge">{revLang}</span></h2>
              {#if revHtml}
                <pre class="dump codeview codehl" style="max-height:none">{@html revHtml}</pre>
              {:else}
                <pre class="dump codeview" style="max-height:none">{revContent}</pre>
              {/if}
            {:else}
              <span class="v-dim">← pick a file from the tree to preview.</span>
            {/if}
          </div>
        </div>
          </Tabs.Content>
        </Tabs.Root>
      </div>
    {/if}

    {:else}
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div class="flex min-w-0 flex-col gap-4">
        <Card.Root>
          <Card.Header>
            <Card.Title>system_status</Card.Title>
            <Card.Description>read-only runtime state</Card.Description>
          </Card.Header>
          <Card.Content>
            <dl class="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              <div class="flex items-center justify-between gap-3 border-b border-border py-1.5">
                <dt class="text-xs text-muted-foreground">engine</dt>
                <dd class="truncate text-sm">muse-cli <span class="text-muted-foreground">({meta?.brain?.bin || "muse"})</span></dd>
              </div>
              <div class="flex items-center justify-between gap-3 border-b border-border py-1.5">
                <dt class="text-xs text-muted-foreground">health</dt>
                <dd class="text-sm">
                  {#if meta?.brain?.ok}<span class={cBadgeSuccess}>connected</span>
                  {:else}<span class={cBadgeDestructive}>CLI not found</span>{/if}
                </dd>
              </div>
              <div class="flex items-center justify-between gap-3 border-b border-border py-1.5">
                <dt class="text-xs text-muted-foreground">mode</dt>
                <dd class="text-sm">{#if meta?.dryRun}<span class={cBadgeWarning} title="simulation">dry-run</span>{:else}<span class={cBadgeSuccess}>live</span>{/if}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 border-b border-border py-1.5">
                <dt class="text-xs text-muted-foreground">loop tick</dt>
                <dd class="text-sm">{meta?.loopSeconds ?? 15}s</dd>
              </div>
              <div class="flex items-center justify-between gap-3 border-b border-border py-1.5 sm:col-span-2">
                <dt class="text-xs text-muted-foreground">tasks</dt>
                <dd class="text-sm">{tasks.length} active · {doneCount} done · {failCount} failed</dd>
              </div>
            </dl>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>configuration</Card.Title>
            <Card.Description>applies to the next run{#if current?.status === "running"} — brain is working now{/if}</Card.Description>
          </Card.Header>
          <Card.Content>
            <div class="border-b border-border pb-4">
              <div class="mb-2 text-xs font-medium">model_control</div>
              <div class="mb-3 truncate text-xs text-muted-foreground">{brain ? `${brain.agent} (${brain.agentSource}) · ${brain.bin}${brain.subcommand ? " " + brain.subcommand : " -p"}` : "…"} · {brain?.model || "default CLI"} ({brain?.modelSource || "…"}) · {brain?.effort || "default CLI"} ({brain?.effortSource || "…"})</div>
              <div class="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label for="bagent" class="mb-1 block text-xs font-medium">coding agent</label>
                  <Select.Root type="single" bind:value={brainAgent}>
                    <Select.Trigger aria-label="coding agent" class={cSelectTrigger}>
                      <Select.Value placeholder="— env default —" class="truncate" />
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class={cSelectContent} sideOffset={4}>
                        <div class="overflow-y-auto p-1">
                          {#each agentOptions as o (o.value)}
                            <Select.Item value={o.value} label={o.label} disabled={o.disabled} class={cSelectItem}>{o.label}</Select.Item>
                          {:else}
                            <div class={cSelectEmpty}>no match</div>
                          {/each}
                        </div>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                </div>
                <div>
                  <label for="bbin" class="mb-1 block text-xs font-medium">binary (empty = env default)</label>
                  <input id="bbin" bind:value={brainBin} placeholder="muse / opencode" autocomplete="off" class={cInput} />
                </div>
              </div>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {#if (brain?.catalog?.providers || []).length}
                  <div>
                    <label for="bprov" class="mb-1 block text-xs font-medium">provider</label>
                    <Select.Root type="single" bind:value={brainProvider}>
                      <Select.Trigger aria-label="provider" class={cSelectTrigger}>
                        <Select.Value placeholder="all providers" class="truncate" />
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content class={cSelectContent} sideOffset={4}>
                          <div class="overflow-y-auto p-1">
                            {#each providerOptions as o (o.value)}
                              <Select.Item value={o.value} label={o.label} disabled={o.disabled} class={cSelectItem}>{o.label}</Select.Item>
                            {:else}
                              <div class={cSelectEmpty}>no match</div>
                            {/each}
                          </div>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>
                  </div>
                {/if}
                <div>
                  <label for="bmodel" class="mb-1 block text-xs font-medium">model</label>
                  <Select.Root type="single" bind:value={brainModel} bind:open={modelSelOpen}>
                    <Select.Trigger aria-label="model" class={cSelectTrigger}>
                      <Select.Value placeholder="— CLI default —" class="truncate" />
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class={cSelectContent} sideOffset={4}>
                        <div class="shrink-0 border-b border-border p-1">
                          <input bind:this={modelSearchEl} bind:value={modelQuery} placeholder="search model…" aria-label="search options" autocomplete="off" class="h-8 w-full rounded-sm bg-transparent px-2 text-sm text-white outline-none placeholder:text-muted-foreground" onkeydown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }} />
                        </div>
                        <div class="overflow-y-auto p-1">
                          {#each modelSelItems as o (o.value)}
                            <Select.Item value={o.value} label={o.label} disabled={o.disabled} class={cSelectItem}>{o.label}</Select.Item>
                          {:else}
                            <div class={cSelectEmpty}>no match</div>
                          {/each}
                        </div>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                </div>
                <div>
                  <label for="beff" class="mb-1 block text-xs font-medium">reasoning effort</label>
                  <Select.Root type="single" bind:value={brainEffort}>
                    <Select.Trigger aria-label="reasoning effort" class={cSelectTrigger}>
                      <Select.Value placeholder="— CLI default —" class="truncate" />
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class={cSelectContent} sideOffset={4}>
                        <div class="overflow-y-auto p-1">
                          {#each ([{ value: "", label: "— CLI default —" }, ...(brain?.efforts || []).map((e) => ({ value: e, label: e }))] as SelectOption[]) as o (o.value)}
                            <Select.Item value={o.value} label={o.label} disabled={o.disabled} class={cSelectItem}>{o.label}</Select.Item>
                          {:else}
                            <div class={cSelectEmpty}>no match</div>
                          {/each}
                        </div>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                </div>
              </div>
            </div>
            <div class="pt-4">
              <div class="mb-2 text-xs font-medium">execution_limit</div>
              <div class="mb-3 text-xs text-muted-foreground">active: {limits ? `${limits.timeoutSeconds}s` : "…"} ({limits?.timeoutSource || "…"})</div>
              <div>
                <label for="totime" class="mb-1 block text-xs font-medium">timeout per run, seconds{meta?.timeout ? ` (env default ${meta.timeout.seconds}s)` : ""}</label>
                <input id="totime" type="number" inputmode="numeric" bind:value={timeoutInput} placeholder={limits ? `e.g. 3600 (min ${limits.min}, max ${limits.max})` : "e.g. 3600"} autocomplete="off" class={cInput} />
              </div>
            </div>
          </Card.Content>
          <Card.Footer>
            <Button variant="default" onclick={saveBrain} disabled={busy === "brain"}>save brain</Button>
            <Button variant="default" onclick={saveLimits} disabled={busy === "limits"}>save timeout</Button>
            {#if brainMsg}<span class="text-xs text-muted-foreground">{brainMsg}</span>{/if}
            {#if limitsMsg}<span class="text-xs text-muted-foreground">{limitsMsg}</span>{/if}
          </Card.Footer>
        </Card.Root>
      </div>

      <Card.Root class="h-fit">
        <Card.Header>
          <Card.Title>laptop</Card.Title>
          <Card.Description>resource_monitoring</Card.Description>
        </Card.Header>
        <Card.Content>
          {#if metrics}
            <div class="mb-1 flex items-center justify-between text-xs">
              <span class="text-muted-foreground">cpu</span><span class="font-mono text-sm">{metrics.cpuPercent}%</span>
            </div>
            <Progress.Root value={metrics.cpuPercent} class={cProgress}>
              <div class={cProgressFill} style={`transform: translateX(-${100 - (100 * (metrics.cpuPercent ?? 0)) / 100}%)`}></div>
            </Progress.Root>
            <svg class="spark" viewBox="0 0 260 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={spark} /></svg>
            <div class="mt-2 mb-1 flex items-center justify-between text-xs">
              <span class="text-muted-foreground">mem</span><span class="font-mono text-sm">{metrics.memUsedPercent}%</span>
            </div>
            <Progress.Root value={metrics.memUsedPercent} class={cProgress}>
              <div class={cProgressFill} style={`transform: translateX(-${100 - (100 * (metrics.memUsedPercent ?? 0)) / 100}%)`}></div>
            </Progress.Root>
            <div class="mt-3 grid grid-cols-2 gap-x-4">
              <div class="border-b border-border py-1.5">
                <div class="text-xs text-muted-foreground">memory</div>
                <div class="truncate font-mono text-sm">{gb(metrics.memTotal - metrics.memFree)} / {gb(metrics.memTotal)}</div>
              </div>
              <div class="border-b border-border py-1.5">
                <div class="text-xs text-muted-foreground">althea</div>
                <div class="font-mono text-sm">{metrics.procMemMb} MB</div>
              </div>
              <div class="border-b border-border py-1.5">
                <div class="text-xs text-muted-foreground">uptime</div>
                <div class="truncate font-mono text-sm">{dur(metrics.uptimeSec)}</div>
              </div>
              <div class="border-b border-border py-1.5">
                <div class="text-xs text-muted-foreground">althea up</div>
                <div class="font-mono text-sm">{dur(metrics.procUptimeSec)}</div>
              </div>
              <div class="border-b border-border py-1.5">
                <div class="text-xs text-muted-foreground">network</div>
                <div class="truncate font-mono text-sm">{metrics.net.length ? metrics.net.map((n) => `${n.name}:${n.address}`).join("  ") : "—"}</div>
              </div>
              <div class="border-b border-border py-1.5">
                <div class="text-xs text-muted-foreground">runtime</div>
                <div class="truncate font-mono text-sm">{metrics.platform} · {metrics.node}</div>
              </div>
            </div>
          {:else}
            <span class="text-xs text-muted-foreground">loading metrics…</span>
          {/if}
        </Card.Content>
      </Card.Root>
    </div>

    <div class="grid" style="margin-top:12px">
      <div class="panel">
        <h2>report</h2>
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
    <span class="clock">{new Date(now).toLocaleString("en-US")}</span>
  </div>
  {#if authed === null}
    <div class="panel"><span class="v-dim">connecting to runtime…</span></div>
  {:else}
    <div class="panel login-box">
      <h2>login_required</h2>
      <p class="hint">Enter the admin password (ADMIN_PASSWORD). The session is an HttpOnly cookie.</p>
      <label for="pw">password</label>
      <input id="pw" type="password" bind:value={pw} onkeydown={(e) => e.key === "Enter" && login()} autocomplete="current-password" />
      {#if loginErr}<div class="err">✕ {loginErr}</div>{/if}
      <div class="btnrow"><button onclick={login} disabled={busy === "login" || !pw}>log in</button></div>
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
        placeholder="type a command… (↑↓ + enter)"
        bind:value={palQ}
        onkeydown={palKey}
        autofocus
      />
      <div class="palitems">
        {#if !palItems.length}<div class="palempty v-dim">no match.</div>{/if}
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
