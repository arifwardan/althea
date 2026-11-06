# 🌙 Althea — Runtime Otonom (Laptop-first → VPS)

Bahasa: Indonesia. Web-based. Otak: **Muse CLI** (langganan).
Backend satu dependensi kecil (`adm-zip`, untuk upload); dashboard Svelte (~110 KB total) tema dark navy + emerald.

## Stack: kenapa Node+TS (vs Go)

| Aspek | Node+TS (dipilih) | Go |
|---|---|---|
| Kecepatan bangun | Cepat: 1 bahasa untuk web+bot+CLI wrapper | Perlu boilerplate HTTP/JSON lebih banyak |
| Ekosistem bot/web | `fetch` bawaan cukup, deploy npm familiar | Biner tunggal, hemat RAM, tapi iterasi awal lebih lambat |
| Cocok untuk | Laptop-first, iterasi harian, nanti pindah VPS | Optimasi nanti bila butuh 1 biner super-irit |

Kesimpulan: mulai **Node+TS** agar cepat hidup; Go tetap opsi rewrite bila sudah stabil.
Dashboard memakai **Svelte 5 + Vite** (build statis ±100 KB, tanpa framework runtime berat).

## PostgreSQL (credential bersama)

App buatan **tidak pernah diminta menginstall PostgreSQL** — Althea memakai
pgsql lokal yang sudah terinstall (`DB_HOST`/`DB_PORT`, default
`127.0.0.1:5432`). Kredensial default:

- `DB_USER` default **`althea`**, `DB_PASSWORD` default **`password`** —
  ubah lewat `.env` (`DB_PASSWORD=...`) lalu restart Althea.
- Role dibuat otomatis di server (best-effort, idempotent: punya `CREATEDB`);
  bila gagal, log event + notifikasi Telegram menyertakan perintah SQL manualnya.
- Kredensial yang sama **disuntik ke prompt tiap fase pipeline** — setiap app
  cukup `CREATE DATABASE` sendiri, dilarang membuat role/user atau mengganti
  password. Lihat `src/db.ts`.

## Aturan izin (eskalasi otomatis)

1. Pertanyaan/izin Muse (`IZIN: ...`) **muncul di dashboard web dulu**.
2. Tanpa respons **3 menit** → dilempar ke **bot Telegram** (tombol ✅/⛔).
3. Tanpa respons **3 menit lagi** → **Althea memutuskan sendiri**: aksi non-destruktif
   = lanjut, aksi destruktif (hapus/deploy produksi/dll) = tolak. Semua tercatat di event.
4. Batas waktu bisa diubah (`APPROVAL_WEB_MINUTES`, `APPROVAL_TELEGRAM_MINUTES`);
   `APPROVAL_AUTODECIDE=0` = tunggu admin selamanya.

## Fitur otonomi

1. **Workflow dinamis (LIFO)** — `src/workflow.ts`. Puncak dikerjakan dulu;
   tugas/anak-tugas bisa di-`push` kapan saja (web/Telegram/Muse).
2. **Mode tidur tapi tetap bangun** — `src/sleeper.ts`. `/tidur 60` hening 60 menit,
   tapi otomatis bangun untuk: pesan Telegram, approval, tugas baru.
3. **Prompt tersimpan, siap jalan ulang** — `src/state.ts`. Tiap tugas menyimpan
   prompt lengkapnya di `data/state.json`, jadi boot ulang tinggal lanjut.
   Progres graph + **handoff** (`src/handoff.ts`: ringkasan pekerjaan yang sudah
   selesai + diff di disk) ikut disuntik saat resume — limit → ganti
   model/provider → run ulang berarti **lanjut dari status terakhir**, bukan
   baca PRD/kerja dari nol.
4. **Deteksi limit token (tanpa cooldown)** — pola `usage limit / rate limit / quota /
   429 / overloaded / try again in …` pada **error asli CLI/API** (bukan jawaban AI)
   → tugas langsung `failed` + notif Telegram. Tanpa tunggu otomatis: ganti ke
   model/provider yang masih ada kuotanya, lalu jalankan ulang tugasnya.
5. **Kill-switch** — tombol [hentikan] di dashboard / `/batal <id>` di Telegram
   mematikan proses Muse detik itu juga (SIGTERM → SIGKILL).
   Tombol **[correct]** di panel running_task: menghentikan run, menempelkan
   arahan admin ke prompt, lalu mengantre ulang tugas yang sama.
   Setiap tugas selesai → notif "task complete, please review" (Telegram +
   tombol ✓, AI tetap lanjut) dan checklist [review] di riwayat.
6. **Log live + review code** — output Muse mengalir ke dashboard (SSE, tersimpan
   200 baris/tugas); panel review menampilkan `git diff` project, pohon file,
   dan isi file untuk diperiksa.
7. **Agen LangGraph** — tiap tugas jalan sebagai graph plan → implement → review
   (loop fix maks `GRAPH_MAX_ROUNDS`, default 3). Tiap node memanggil Muse CLI
   langganan (tanpa API key); limit menggagalkan tugas, kill-switch tetap sama.
8. **Hitung token (estimasi jujur)** — CLI langganan tak melaporkan pemakaian dan
   Anthropic tak mempublikasikan tokenizer Muse, jadi Althea menghitung karakter
   pasti + estimasi token (≈3,5 char/token). Tampil per tugas, total di laporan,
   dan di dashboard. Bukan angka exact — labelnya selalu estimasi.
9. **Timeout + antre-ulang otomatis** — satu eksekusi Muse dibatasi
   `CLAUDE_TIMEOUT_SECONDS` (default 1800); timeout → tugas diantre-ulang
   (file yang sudah ditulis aman) sampai `TASK_MAX_ATTEMPTS` (default 3).

## Jalankan di laptop (WSL Ubuntu)

Otak = `muse exec` (langganan Meta), jadi server jalan di WSL tempat `muse` + loginmu berada.
Dashboard tetap dibuka di browser Windows (`http://127.0.0.1:9999` terus ke WSL otomatis).

```bash
cp .env.example .env   # isi TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_IDS, ADMIN_PASSWORD
# Node 20 tanpa sudo (sekali saja):
curl -sO https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-x64.tar.xz
mkdir -p ~/.local/node && tar -xf node-v20.19.0-linux-x64.tar.xz -C ~/.local/node --strip-components=1
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.bashrc && export PATH="$HOME/.local/node/bin:$PATH"
npm install
npm run build          # build dashboard Svelte + backend
npm start              # buka http://127.0.0.1:9999 di browser Windows
```

Dev harian: `npm run dev` (backend hot-reload) + `npm run dev:web` (dashboard HMR :5173).
Tes tanpa kuota: `CLAUDE_DRY_RUN=1` di `.env`.

Telegram commands: `/status /stack /report /sleep <min> /wake /add Title|prompt /ask question /prompt anything /approve <id> /reject <id> /cancel <id>`. `/ask` answers only (changes nothing); `/prompt` runs anything except destructive actions. Write in any language — Althea translates prompts to English.

## Workspace projects

Semua project tinggal di `workspace/` (satu folder per project). Form cukup isi **nama**,
lalu pilih sumber (semua opsional selain nama):

1. **Dari prompt**: mis. "buat aplikasi pos kasir" → Althea susun PRD, eksekusi MVP,
   lanjutkan fitur, sampai verifikasi rilis — otomatis via pipeline.
2. **Link repo**: isi link (`https://…` / `git@…`); prompt awal opsional.
3. **File zip**: upload `.zip` (maks `PROJECT_MAX_MB`, default 50 MB); prompt awal opsional.
4. **Upload PRD**: file `.md`/`.txt` (maks 2 MB) → disimpan sebagai `PRD.md`,
   langsung eksekusi MVP.
5. **Manual**: taruh folder langsung di `workspace/` — otomatis terdeteksi sebagai `manual`.

**Pipeline otonom** (`src/pipeline.ts`): PRD → MVP → fitur (berulang, maks
`PIPELINE_FEATURE_ROUNDS`, default 3) → rilis. Tiap fase = 1 tugas; gagal di tengah
menghentikan pipeline, batal menjeda. Pantau + jeda/lanjutkan/hentikan dari panel
review project. Review hasil: aktivitas tugas ([hasil]/[log]), tindak lanjut per
tugas, instruksi bebas, diff git, pohon file, dan isi file. Halaman Tasks punya
panel [detail] per tugas: prompt, file disentuh, feed aktivitas tool/file, hasil.

**MCP server** (`src/mcp.ts`): project bisa dipasangi MCP server (bawaan:
`playwright` — otak bisa membuka, screenshot, dan mengklik app hasil generate
untuk verifikasi). Aktifkan dari panel review project (bagian `mcp_server`);
Althea menyuntikkan entri `althea-<id>` ke `~/.config/muse/settings.json` milik
CLI saat tugas project itu jalan — entri lain milikmu tak pernah disentuh.
Tiap tugas juga menampilkan **audit tool calls** (tool apa × berapa kali,
sukses/gagal) di bawah barisnya. Server kustom bisa didaftarkan via
`ALTHEA_MCP_SERVERS` (JSON, lihat `.env.example`); Playwright butuh
`npm i -g @playwright/mcp` + `npx playwright install chromium` agar runnable.

**Preview aplikasi** (`src/preview.ts`): panel review project punya bagian
`preview_aplikasi` — jalankan app langsung dari dashboard dan lihat dalam
iframe. Tiap preview dapat **port dan origin sendiri** (9001–9090,
`PREVIEW_BASE_PORT`) sehingga path absolut, fetch, module script, dan storage
app modern (Next/Vite) tetap jalan. Project HTML statis disajikan otomatis
dari portnya; stack `node` default `<runner> run dev` (runner = env `JS_RUNNER`
`npm`/`bun`; env `PORT`/`HOST`/`HOSTNAME` diset), `python` default `http.server`, sisanya isi command sendiri (`{port}`
diganti otomatis, tersimpan per project). Proses dibatasi 8, log 200 baris,
dan semua preview dimatikan saat project dihapus / server berhenti. Iframe
di-sandbox (`allow-same-origin` sebatas origin preview itu sendiri) sehingga
app tak bisa menyentuh dashboard; prefix proxy `/app/*` dan
`/preview-file/*` tetap tersedia untuk kasus same-origin.

Stack terdeteksi otomatis (`node`/`go`/`python`/`generic`). Saat membuat tugas,
pilih project agar Muse bekerja di folder itu (terisolasi, tidak mengacak-acak
root Althea). Tanpa project = perilaku lama (cwd root Althea).

## Keamanan

- Dashboard wajib login bila `ADMIN_PASSWORD` diisi (**wajib saat deploy**);
  tanpa password hanya localhost yang dilayani API-nya.
- Sesi cookie HttpOnly + SameSite=Lax, token disimpan sha256, kedaluwarsa 7 hari.
- Login dibatasi: 5x salah → kunci 1 menit per IP. Password dibanding timing-safe.
- Bind default `127.0.0.1`; di VPS pasang di belakang reverse-proxy + TLS.
- Project: nama ketat (anti traversal), zip disaring dari zip-slip, batas 50 MB,
  clone hanya `https://` / `git@`, tugas jalan terisolasi di folder project-nya.

## Pindah ke VPS Linux + domain

1. `scp -r` proyek ke `/opt/althea` (tanpa `node_modules/`, `.env`, `dist/`, `public/*`).
2. `npm install --omit=dev && npm run build`.
3. `sudo cp deploy/althea.service /etc/systemd/system/ && sudo systemctl enable --now althea`.
4. Nginx reverse-proxy `althea.domainmu.id → 127.0.0.1:9999` + TLS (certbot).
5. Isi `.env` produksi (`ADMIN_PASSWORD` kuat, token bot, admin ids).

## Struktur

```
src/index.ts      loop runtime hidup (telegram→eskalasi→approval→tidur→kerja)
src/workflow.ts   stack dinamis push/peek/done + approval
src/escalation.ts aturan 3+3 menit + keputusan otomatis
src/auth.ts       sesi login + rate-limit
src/sleeper.ts    tidur yang bisa dibangunkan 5 pemicu
src/claude.ts     wrapper `muse exec` + model/effort + deteksi limit (tanpa cooldown)
src/telegram.ts   bot long-poll: notif, perintah, tombol izin
src/report.ts     laporan ringkas
src/agent/graph.ts LangGraph plan→implement→review di atas CLI langganan
src/server.ts     API + file statis + guard auth
src/projects.ts   workspace: clone repo, upload zip, registry, deteksi stack
src/config.ts     env (parse .env manual)
src/state.ts      JSON persisten = memori auto-lanjut
web/              dashboard Svelte 5 tema terminal (sumber)
public/           hasil build dashboard (disajikan backend)
workspace/        rumah semua project (di luar git)
```

## Aset

- Font JetBrains Mono (latin 400/700, woff2, ~43 KB) — unduhan Fontsource CDN,
  lisensi SIL Open Font License 1.1, disajikan lokal dari `web/src/assets/fonts/`.
- Logo/favicon `>_`: SVG orisinal di `web/public/favicon.svg`.

## Lisensi

Althea dilisensikan di bawah **GNU Affero General Public License v3.0 or later**
(AGPL-3.0-or-later) — lihat file [`LICENSE`](LICENSE).

Ketentuan ketat yang perlu diketahui:

- **Copyleft penuh**: modifikasi apa pun harus dirilis dengan lisensi yang sama
  (AGPL-3.0), lengkap dengan source code-nya.
- **Berlaku juga lewat jaringan**: menjalankan versi termodifikasi Althea sebagai
  layanan web/VPS wajib menyediakan source code-nya kepada pemakainya
  (bab 13 AGPL) — bukan hanya saat mendistribusikan binernya.
- **Tanpa warranty dan tanpa dukungan komersial** dari penulis.
- Dependensi pihak ketiga (MIT/Apache-2.0/SIL OFL) tetap sesuai lisensinya
  masing-masing; lisensi ini berlaku untuk kode Althea sendiri.

Kecuali dinyatakan lain pada file tertentu, semua kode di repo ini memakai
lisensi tersebut.
