# Desain Althea — v0.1

Bahasa: Indonesia. Pasangan dari [PRD.md](/mnt/c/ai/playground/althea/PRD.md). Isi: arsitektur runtime, alur otonomi, kontrak API web + Telegram, format state, dan jalur migrasi VPS.

## 1. Arsitektur (ringkas)

Satu proses Node, nol dependensi runtime. Semua modul di `src/`:

```
index.ts      loop tick: telegram → eskalasi → approval? → tidur? → limit? → kerja
workflow.ts   stack LIFO: push / peek / done / failed / approval
escalation.ts aturan 3+3 menit + keputusan otomatis (murni waktu → unit-test)
auth.ts       sesi login + rate-limit (tanpa framework)
state.ts      JSON persisten (data/state.json) = memori auto-lanjut
claude.ts     spawn `muse exec` (+ model/effort) + deteksi limit + cooldown resume
sleeper.ts    mode tidur + 5 pemicu bangun
telegram.ts   long-poll bot: notif, perintah, tombol izin
report.ts     laporan teks ringkas (dipakai web + Telegram)
server.ts     API JSON + file statis + guard auth (http bawaan)
config.ts     parse .env manual
web/          dashboard Svelte 5 (sumber) → build ke public/
```

Alasan nol dependensi runtime: boot < 5 detik, idle ~0% CPU. Dashboard Svelte
dikompilasi jadi statis ±100 KB (JS+CSS+font) lalu disajikan backend http bawaan.

## 2. Alur tick (detak otonomi)

Setiap `LOOP_SECONDS` (default 15 dtk):

1. **Poll Telegram** — selalu jalan duluan, supaya `/bangun` dan tombol izin responsif walau runtime tidur/cooldown.
2. **Eskalasi izin** — `processEscalations`: approval stage `web` yang berumur > N menit naik ke `telegram` (kirim tombol + batas waktu); stage `telegram` yang berumur > M menit diputuskan otomatis (non-destruktif = setuju, destruktif = tolak) lalu dinotifikasi. Nonaktif via `APPROVAL_AUTODECIDE=0`.
3. **Approval pending?** — jika `state.approvals` tidak kosong, berhenti di sini. Tidak ada tugas lain yang dikerjakan sampai admin/auto memutuskan.
4. **Tidur?** — jika `sleepUntil` belum lewat, skip eksekusi Muse (hemat kuota).
5. **Cooldown limit?** — jika `limitCooldownUntil` belum lewat, skip. Saat lewat, flag di-reset + event `resume otomatis` dicatat.
6. **Kerja** — ambil puncak stack (`peek`), jalankan graph LangGraph
   (`src/agent/graph.ts`, lazy-import): node `planner` → `coder` → `reviewer`;
   tiap node satu panggilan `muse exec` (+ `--model`/`--reasoning-effort`
   dari dashboard bila diset), fix loop maks `GRAPH_MAX_ROUNDS`.
   Progres graph tersimpan di `task.graph` agar limit/restart/resume tak mengulang.
   - limit di node mana pun → tugas kembali `queued` + cooldown (progres aman).
   - output gabungan mengandung `IZIN: ...` → `waiting_approval` (eskalasi langkah 2).
   - review APPROVED → `done`; ronde habis → `failed` + notif Telegram.
   - `GRAPH_ENABLED=0` = mode single-shot lama (satu panggilan CLI).
7. **Laporan berkala** — tiap `REPORT_EVERY_HOURS` kirim ringkasan ke Telegram (0 = mati).

Kunci auto-lanjut tanpa prompt ulang: **prompt lengkap tersimpan per tugas di `state.json`**, jadi limit / restart / tidur tidak pernah menghilangkan konteks. Boot ulang tinggal `peek` dan lanjut.

## 3. API web (dashboard)

| Method | Path | Fungsi | Auth |
|---|---|---|---|
| GET | `/` | Dashboard Svelte (publik; data via API) | – |
| GET | `/api/meta` | Flag auth + batas eskalasi + status otak + jam server | – |
| POST | `/api/login` | `{password}` → cookie sesi HttpOnly | rate-limit |
| POST | `/api/logout` | Hapus sesi | – |
| GET | `/api/state` | Seluruh state (stack, approval, event) | Ya |
| GET | `/api/report` | Laporan teks | Ya |
| POST | `/api/tasks` | `{title, prompt}` → push tugas + bangunkan | Ya |
| POST | `/api/approve` | `{id, ok, note}` → setuju/tolak izin | Ya |
| POST | `/api/sleep` | `{minutes}` → tidur | Ya |
| POST | `/api/wake` | bangun | Ya |
| GET | `/api/projects` | Daftar project workspace | Ya |
| POST | `/api/projects` | `{name, repoUrl}` → git clone | Ya |
| POST | `/api/projects/upload` | Multipart `name` + `file.zip` → ekstrak | Ya |
| DELETE | `/api/projects/:name` | Hapus project | Ya |
| GET | `/api/metrics` | CPU/mem/uptime/network laptop + proses (cache 2 dtk) | Ya |
| GET | `/api/brain` | Otak efektif: bin, model, effort + sumbernya | Ya |
| PUT | `/api/brain` | `{model, effort}` → simpan override, berlaku spawn berikut | Ya |
| POST | `/api/tasks/:id/cancel` | Kill-switch: matikan proses + gagalkan tugas | Ya |
| GET | `/api/tasks/:id/log` | SSE log output Muse (200 baris terakhir) | Ya |
| GET | `/api/projects/:n/diff` | Git diff + status untracked (100 KB) | Ya |
| GET | `/api/projects/:n/files` | Pohon file (200 entri, skip berat) | Ya |
| GET | `/api/projects/:n/file?path=` | Isi file teks (200 KB, anti-traversal) | Ya |

Auth: satu `ADMIN_PASSWORD` → token 32-byte (disimpan sha256, 7 hari) via cookie
HttpOnly SameSite=Lax atau header Bearer. Tanpa password: API hanya melayani
localhost. Login: 5x gagal → kunci 1 menit per IP; password timing-safe.
File statis anti-traversal (hanya dari `public/`). Belum ada: `/healthz` khusus
(pakai `/api/state`), SSE log streaming — keduanya opsional pasca-MVP.

## 4. Bot Telegram

Token via `@BotFather` → `TELEGRAM_BOT_TOKEN`. Admin dikunci via `TELEGRAM_ADMIN_IDS` (kosong = mode awal, terima semua).

Perintah: `/status /stack /lapor /tidur <mnt> /bangun /tambah Judul|prompt /setuju <id> /tolak <id> [alasan]`

Flow izin: Muse mencetak `IZIN: <pertanyaan>` → muncul di web (stage `web`); tanpa respons N menit → bot kirim pesan + tombol inline (`ok:<id>` / `no:<id>`) + info batas waktu; tanpa respons M menit lagi → keputusan otomatis (non-destruktif = setuju → `queued`, destruktif = tolak → `failed`) + notifikasi. Semua keputusan tercatat di `events` (audit) beserta pengambilnya.

Bangun saat tidur dipicu oleh: pesan Telegram, approval baru/selesai, timer reset tiba, tugas prioritas, perintah manual.

## 5. Format state (`data/state.json`)

```jsonc
{
  "version": 1,
  "brain": {"model": "", "effort": ""}, // override dashboard ("" = default env/CLI)
  "stack": [{ "id": "t_...", "title": "...", "prompt": "...", "status": "queued|running|waiting_approval|done|failed", "attempts": 0, "usage": {"runs":1,"charsIn":500,"charsOut":600,"tokIn":143,"tokOut":172} }],
  "usage": {"runs":10,"charsIn":5000,"charsOut":6000,"tokIn":1429,"tokOut":1715}, // total runtime (estimasi)
  "approvals": [{ "id": "t_...", "title": "...", "question": "...", "createdAt": "..." }],
  "sleepUntil": "ISO|null",
  "limitCooldownUntil": "ISO|null",
  "lastReset": "ISO|null",
  "events": ["ISO pesan ..."] // maks 200
}
```

File ini adalah satu-satunya database di MVP (cukup untuk solo builder; SQLite/Postgres opsional nanti).

## 6. Strategi limit ±5 jam

- Deteksi: pola `usage limit / rate limit / quota / 429 / overloaded / try again in / reset at|in / limit reached` (case-insensitive) pada gabungan stdout+stderr.
- Tunggu eksplisit: `try again in N detik|menit|jam` → cooldown tepat N. Tanpa itu → +5 jam (konfigurasi `CLAUDE_RESET_HOURS`).
- Resume: otomatis di tick berikutnya setelah cooldown lewat — prompt diambil dari state, bukan dari ketikan ulang.
- Risiko: format pesan limit berubah → ada pola ganda + fallback keyword; probe manual via `/bangun`.

## 7. Workspace projects

`workspace/<nama>/` per project, registry di `state.projects`. Tiga jalur masuk:
clone URL (`git clone --depth 1`, URL https/scp saja, timeout 180 dtk), upload zip
(multipart, batas `PROJECT_MAX_MB`, saring zip-slip, rapikan bungkus root tunggal
ala zip GitHub), dan folder manual (terdeteksi otomatis). Stack dari penanda
(`package.json`/`go.mod`/`pyproject|requirements`). Tugas boleh mengikat
`project` → `spawn Muse` dengan `cwd` folder itu; project hilang = tugas `failed`
dengan pesan jelas. Hapus = `rm -rf` folder + registry (di balik auth + konfirmasi UI).

## 8. Migrasi laptop → VPS

Tidak ada perubahan kode: `scp` proyek → `npm install --omit=dev && npm run build` → systemd (`deploy/althea.service`) atau pm2 (`deploy/ecosystem.config.cjs`) → Nginx reverse-proxy + TLS → isi `.env` produksi. State ikut terbawa (`data/state.json`), jadi antrean tugas pindah utuh.
