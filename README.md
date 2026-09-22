# 🌙 Althea — Runtime Otonom (Laptop-first → VPS)

Bahasa: Indonesia. Web-based. Otak: **Muse CLI** (langganan, reset ±5 jam).
Backend satu dependensi kecil (`adm-zip`, untuk upload); dashboard Svelte (~110 KB total) tema dark navy + emerald.

## Stack: kenapa Node+TS (vs Go)

| Aspek | Node+TS (dipilih) | Go |
|---|---|---|
| Kecepatan bangun | Cepat: 1 bahasa untuk web+bot+CLI wrapper | Perlu boilerplate HTTP/JSON lebih banyak |
| Ekosistem bot/web | `fetch` bawaan cukup, deploy npm familiar | Biner tunggal, hemat RAM, tapi iterasi awal lebih lambat |
| Cocok untuk | Laptop-first, iterasi harian, nanti pindah VPS | Optimasi nanti bila butuh 1 biner super-irit |

Kesimpulan: mulai **Node+TS** agar cepat hidup; Go tetap opsi rewrite bila sudah stabil.
Dashboard memakai **Svelte 5 + Vite** (build statis ±100 KB, tanpa framework runtime berat).

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
   tapi otomatis bangun untuk: pesan Telegram, approval, timer reset limit, tugas prioritas.
3. **Resume tiap reset ±5 jam tanpa prompt ulang** — `src/claude.ts` + `src/state.ts`.
   Prompt tersimpan di `data/state.json`; limit → `queued` + cooldown → lanjut sendiri.
4. **Deteksi limit token** — pola `usage limit / rate limit / quota / 429 / overloaded /
   try again in …` → notif Telegram + cooldown (`retryAfter` bila ada, else +5 jam).
5. **Kill-switch** — tombol [hentikan] di dashboard / `/batal <id>` di Telegram
   mematikan proses Muse detik itu juga (SIGTERM → SIGKILL).
6. **Log live + review code** — output Muse mengalir ke dashboard (SSE, tersimpan
   200 baris/tugas); panel review menampilkan `git diff` project, pohon file,
   dan isi file untuk diperiksa.
7. **Agen LangGraph** — tiap tugas jalan sebagai graph plan → implement → review
   (loop fix maks `GRAPH_MAX_ROUNDS`, default 3). Tiap node memanggil Muse CLI
   langganan (tanpa API key); limit/kill-switch/resume tetap lewat jalur yang sama.
8. **Hitung token (estimasi jujur)** — CLI langganan tak melaporkan pemakaian dan
   Anthropic tak mempublikasikan tokenizer Muse, jadi Althea menghitung karakter
   pasti + estimasi token (≈3,5 char/token). Tampil per tugas, total di laporan,
   dan di dashboard. Bukan angka exact — labelnya selalu estimasi.

## Jalankan di laptop (WSL Ubuntu)

Otak = `muse exec` (langganan Meta), jadi server jalan di WSL tempat `muse` + loginmu berada.
Dashboard tetap dibuka di browser Windows (`http://127.0.0.1:3000` terus ke WSL otomatis).

```bash
cp .env.example .env   # isi TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_IDS, ADMIN_PASSWORD
# Node 20 tanpa sudo (sekali saja):
curl -sO https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-x64.tar.xz
mkdir -p ~/.local/node && tar -xf node-v20.19.0-linux-x64.tar.xz -C ~/.local/node --strip-components=1
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.bashrc && export PATH="$HOME/.local/node/bin:$PATH"
npm install
npm run build          # build dashboard Svelte + backend
npm start              # buka http://127.0.0.1:3000 di browser Windows
```

Dev harian: `npm run dev` (backend hot-reload) + `npm run dev:web` (dashboard HMR :5173).
Tes tanpa kuota: `CLAUDE_DRY_RUN=1` di `.env`.

Perintah Telegram: `/status /stack /lapor /tidur <mnt> /bangun /tambah Judul|prompt /setuju <id> /tolak <id> /batal <id>`.

## Workspace projects

Semua project tinggal di `workspace/` (satu folder per project). Tiga cara menambah:

1. **Dashboard → clone repo**: isi nama + link (`https://…` / `git@…`).
2. **Dashboard → upload zip**: isi nama + file `.zip` (maks `PROJECT_MAX_MB`, default 50 MB).
3. **Manual**: taruh folder langsung di `workspace/` — otomatis terdeteksi sebagai `manual`.

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
4. Nginx reverse-proxy `althea.domainmu.id → 127.0.0.1:3000` + TLS (certbot).
5. Isi `.env` produksi (`ADMIN_PASSWORD` kuat, token bot, admin ids).

## Struktur

```
src/index.ts      loop runtime hidup (telegram→eskalasi→approval→tidur→limit→kerja)
src/workflow.ts   stack dinamis push/peek/done + approval
src/escalation.ts aturan 3+3 menit + keputusan otomatis
src/auth.ts       sesi login + rate-limit
src/sleeper.ts    tidur yang bisa dibangunkan 5 pemicu
src/claude.ts     wrapper `muse exec` + model/effort + deteksi limit + resume reset
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
