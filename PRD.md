# PRD Althea — v0.1 (Bootstrap)

Bahasa: Indonesia. Status: Draft untuk disetujui.

## 1. Visi

Althea adalah runtime web ringan yang membuat satu laptop menjadi pusat kendali agen koding: hidup terus, bisa auto-lanjut kerja tanpa prompt ulang, melapor sendiri, meminta izin saat perlu, dan siap pindah ke VPS Linux + domain tanpa ubah arsitektur.

Prinsip: laptop-first, web-based, ringan-cepat, otak Muse CLI (subscription, reset ±5 jam), operasional via browser + Telegram.

## 2. Tujuan

1. **Runtime hidup:** proses Althea jalan persisten di laptop (lalu VPS), survive restart, bisa dipantau dari browser.
2. **Auto-lanjut tanpa prompt ulang:** tugas multi-langkah berjalan sebagai workflow dinamis; jika berhenti (limit token, butuh izin, error, restart), lanjut otomatis saat kondisi pulih.
3. **Laporan otomatis:** setiap run menghasilkan laporan ringkas (status, diff, test, next action) yang bisa dibaca di web.
4. **Notifikasi limit token:** deteksi limit/reset subscription Muse ±5 jam, beri estimasi lanjut + notifikasi.
5. **Izin via Telegram bot:** approval (lanjut/deploy/hapus/akses sensitif) bisa dilakukan dari Telegram, bukan cuma browser.
6. **Workflow dinamis multi-stack:** satu mesin workflow bisa menjalankan stack berbeda (Node/TS, Go, Python, dst) tanpa rewrite.
7. **Ringan & cepat:** idle hemat RAM/CPU, UI web responsif, start < 5 detik di laptop.

Non-tujuan v0: multi-user/team, billing, marketplace plugin, mobile app native, dukungan multi-otak (hanya Muse CLI di MVP).

## 3. Konteks & Kendala

- **Mulai folder kosong.** Laptop sebagai host utama; nanti migrasi ke VPS Linux + domain.
- **Web-based:** UI utama browser (dashboard, run detail, log, approval, laporan).
- **Otak: Muse CLI subscription** dengan reset ±5 jam. Implikasi:
  - Harus ada pencatat sesi/kuota, pendeteksi pesan limit, penjadwal retry setelah reset.
  - Tidak boleh kehilangan konteks tugas saat limit; state workflow harus persisten.
  - Butuh mode hemat token (ringkas konteks, batasi log, jeda cerdas).
- **Stack utama: Node.js + TypeScript.** Perbandingan singkat vs Go ada di §6.
- **Operasional:** butuh instalasi satu perintah di laptop dan VPS, update mudah, log terpusat.

## 4. Persona

1. **Solo Builder (utama):** pemilik laptop, merangkap PM+dev+ops. Ingin menembak tugas lalu ditinggal, dapat laporan + ping Telegram saat butuh izin/limit.
2. **Operator VPS (fase 2):** orang yang sama di mode produksi; butuh deploy deterministik, domain+TLS, healthcheck, backup state.
3. **Agen (sistem):** Muse CLI sebagai pekerja; butuh instruksi jelas, direktori kerja terisolasi, izin eksplisit untuk aksi destruktif.

## 5. User Stories (MVP)

Prioritas: P0 wajib MVP, P1 segera setelah MVP.

- **US-01 [P0]:** Sebagai Builder, saya bisa membuat tugas dari web ("kerjakan X di repo Y") lalu menutup browser, dan Althea tetap jalan.
- **US-02 [P0]:** Sebagai Builder, saya bisa melihat daftar run, status, log streaming, dan laporan akhir dari web.
- **US-03 [P0]:** Sebagai Builder, saat run butuh izin (deploy/hapus/akses sensitif), saya dapat notifikasi Telegram + tombol Setuju/Tolak, dan run lanjut/berhenti sesuai keputusan.
- **US-04 [P0]:** Sebagai Builder, saat Muse menyentuh limit token, saya dapat notifikasi (web + Telegram) berisi estimasi reset ±5 jam dan run auto-resume tanpa saya mengetik ulang prompt.
- **US-05 [P0]:** Sebagai Builder, setiap run menghasilkan laporan (ringkasan, file berubah, hasil test, keputusan, next step) yang tersimpan dan bisa dibuka ulang.
- **US-06 [P0]:** Sebagai Builder, saya bisa restart laptop/Althea dan run yang belum selesai lanjut dari checkpoint terakhir.
- **US-07 [P0]:** Sebagai Builder, saya bisa menjalankan workflow yang sama untuk proyek Node/TS maupun proyek lain tanpa ganti kode Althea (workflow dinamis berbasis step + adapter stack).
- **US-08 [P1]:** Sebagai Operator, saya bisa deploy Althea yang sama ke VPS Linux + domain dengan satu skrip + file env.
- **US-09 [P1]:** Sebagai Builder, saya bisa menjadwalkan tugas berulang (cron) dan melihat riwayatnya.
- **US-10 [P1]:** Sebagai Builder, saya bisa membatasi anggaran token/waktu per tugas agar tidak boros.

Acceptance umum US P0: ada e2e test/manual checklist dari create task → limit/izin (simulasi) → resume → laporan → restart-resume.

## 6. Stack: Node+TS vs Go (ringkas)

Keputusan MVP: **Node.js + TypeScript.**

| Aspek | Node+TS | Go | Catatan untuk Althea |
|---|---|---|---|
| Ekosistem web realtime | Kuat (WS/SSE, UI tooling) | Cukup, tapi UI tetap butuh JS | Web dashboard lebih cepat di TS |
| Orkestrasi CLI/subproses | Mudah, banyak lib | Bagus, binary tunggal | Keduanya layak |
| Integrasi Telegram/bot | Lib matang | Lib ada, lebih sedikit contoh | TS lebih cepat |
| Biner/deploy VPS | Butuh Node runtime / bundle | Satu biner, ringan | Go menang deploy |
| Kecepatan dev MVP | Tinggi (satu bahasa FE+BE) | Sedang | TS menang untuk solo builder |
| Performa/resource | Cukup, perlu jaga idle | Sangat ringan | Keduanya bisa ringan bila disiplin |

Alasan pilih Node+TS: satu bahasa untuk BE+FE, ekosistem bot/web realtime tercepat, cocok untuk workflow dinamis (step sebagai data + adapter). Kekurangan deploy diatasi dengan Docker + skrip instalasi. Go dipertimbangkan ulang jika target biner tunggal/offline menjadi P0.

Target runtime: Node LTS, TS strict, SQLite (lokal) → Postgres opsional di VPS, file-state JSON untuk checkpoint workflow.

## 7. Functional Requirements

### FR-1 Manajemen Tugas & Run
- FR-1.1: CRUD task (judul, repo/path, instruksi, stack, anggaran, jadwal opsional).
- FR-1.2: Setiap task dapat memiliki banyak run; run punya ID, status (`queued|running|waiting_approval|waiting_quota|failed|done|cancelled`), timeline event, log, artefak.
- FR-1.3: Batalkan/ulangi run; clone task.
- FR-1.4: Registry project di `workspace/`: tambah via link repo (clone) / upload zip / folder manual, daftar + deteksi stack, hapus, dan kaitkan tugas ke project (eksekusi terisolasi di folder itu).

### FR-2 Workflow Dinamis
- FR-2.1: Workflow = daftar step deklaratif (contoh: `plan → edit → test → report → request_approval → deploy`), bisa beda per task/stack.
- FR-2.2: Adapter stack minimal: `node-ts` (npm/pnpm, tsc, vitest/jest) dan satu `generic-shell` agar stack lain tetap jalan.
- FR-2.3: State tiap step persisten (checkpoint) agar bisa resume.
- FR-2.4: Retry dengan backoff untuk error transien; gagal permanen masuk `failed` + laporan.

### FR-3 Eksekutor Muse CLI
- FR-3.1: Jalankan Muse CLI sebagai subproses terisolasi per run (cwd, env, timeout).
- FR-3.2: Tangkap stdout/stderr streaming ke web; simpan ringkas ke DB/file.
- FR-3.3: Parser event: deteksi `butuh izin`, `limit/kuota habis`, `selesai`, `error`.
- FR-3.4: Mode hemat: batasi konteks/log yang diumpan balik, ringkas otomatis.
- FR-3.5: Kill-switch: batalkan tugas aktif dari web/Telegram (matikan proses + tandai failed).
- FR-3.6: Log output Muse mengalir live ke web (SSE) dan tersimpan per tugas; review code via git diff + pohon file + isi file per project.
- FR-3.7: Orkestrasi LangGraph (tanpa API key; node memanggil CLI langganan): plan → implement → review dengan fix loop maks N ronde; progres persisten untuk resume.

### FR-4 Auto-lanjut & Kuota ±5 Jam
- FR-4.1: Saat limit terdeteksi, run → `waiting_quota`, simpan checkpoint + estimasi reset.
- FR-4.2: Scheduler otomatis resume saat jendela reset tiba, tanpa prompt ulang.
- FR-4.3: Notifikasi limit + resume (web badge + Telegram).
- FR-4.4: Riwayat kuota (kapan limit, kapan resume, durasi jeda).

### FR-5 Eskalasi Izin: Web → Telegram → Otomatis
- FR-5.1: Izin muncul di dashboard web dulu (dengan hitung mundur batas waktu).
- FR-5.2: Tanpa respons dalam `APPROVAL_WEB_MINUTES` (default 3) → eskalasi ke Telegram: pesan berisi run ID, aksi, risiko, tombol Approve/Reject + info batas auto-keputusan.
- FR-5.3: Tanpa respons dalam `APPROVAL_TELEGRAM_MINUTES` (default 3) → Althea memutuskan sendiri: non-destruktif = setuju, destruktif = tolak. `APPROVAL_AUTODECIDE=0` menonaktifkan (tunggu selamanya).
- FR-5.4: Keputusan dari web, Telegram, dan otomatis konsisten (satu sumber status); audit log semua keputusan + siapa pengambilnya (`admin-web|admin-telegram|auto`).
- FR-5.5: Bot Telegram terhubung via token; hanya merespons `TELEGRAM_ADMIN_IDS`.

### FR-6 Laporan
- FR-6.1: Laporan per run: ringkasan, status tiap step, file berubah, perintah+hasil test, keputusan izin, pemakaian (durasi, estimasi token), next action.
- FR-6.2: Laporan tersimpan persisten, bisa dibuka via URL run, bisa ekspor Markdown.
- FR-6.3: Laporan gagal/limit menjelaskan penyebab + apa yang akan dilakukan saat resume.

### FR-7 Dashboard Web
- FR-7.1: Konsol Svelte (build statis ringan), tema dark navy + emerald: header + sidebar (home/tasks/projects/system) + palette ⌘K. Home: header project, kartu status/token/otonomi, tugas berjalan + file berubah, activity stream, runtime timeline, terminal (terminal/logs/output), kartu project & agent. Semua angka dari data real (tanpa metrik palsu).
- FR-7.2: Refresh polling tiap 5 detik (SSE/WS opsional nanti).
- FR-7.3: Auth MVP: satu password admin (`ADMIN_PASSWORD`) → sesi cookie HttpOnly; tanpa password hanya localhost yang dilayani; rate-limit login 5x/menit per IP.

### FR-8 Operasional
- FR-8.1: Healthcheck `/healthz`, info versi, uptime.
- FR-8.2: Skrip `install/start/stop/update` untuk laptop dan VPS.
- FR-8.3: Backup/restore state (DB + file checkpoint + laporan).
- FR-8.4: Konfigurasi via env file (token Telegram, path kerja, batas konkurensi, timeout).

## 8. Non-Functional Requirements

- **NFR-1 Ringan:** idle < ~150 MB RAM (tanpa run), 0 run = CPU ~0%; satu run ringan tidak membuat laptop lemot.
- **NFR-2 Cepat:** boot UI < 5 dtk; buka detail run < 1 dtk (cache); log streaming jeda < 2 dtk.
- **NFR-3 Andal:** crash/restart tidak merusak state; minimal 99% resume sukses pada skenario uji restart/limit.
- **NFR-4 Aman (MVP):** token bot dan secrets hanya di env/file 600; approval destruktif default-deny; log menyamarkan secrets; audit untuk izin.
- **NFR-5 Portabel:** kode yang jalan di laptop (Windows/macOS/Linux) jalan sama di VPS Linux; path dan shell di-abstraksi via adapter.
- **NFR-6 Observabilitas:** setiap run punya timeline event + korelasi log; error punya kode dan pesan Indonesia yang jelas.
- **NFR-7 Maintainability:** TS strict, lint+test di CI lokal, modul terpisah (`web`, `runner`, `quota`, `notifier`, `workflow`, `adapters`).
- **NFR-8 Bahasa:** UI, laporan, dan pesan bot default Bahasa Indonesia.

## 9. MVP Scope

**Masuk (harus ada saat deploy VPS pertama):**
- Task+run CRUD, dashboard web realtime, log streaming.
- Workflow dinamis + adapter `node-ts` & `generic-shell`, checkpoint+resume.
- Eksekutor Muse CLI + parser limit/izin/selesai.
- Scheduler auto-resume kuota ±5 jam + notifikasi web+Telegram.
- Approval Telegram (approve/reject) + audit.
- Laporan Markdown per run + ekspor.
- Auth tunggal, healthcheck, skrip install/start/stop/update, backup/restore.

**Keluar (tunda):**
- Multi-user/roles, billing, multi-otak (Codex/dll), marketplace plugin.
- Cron tingkat lanjut (MVP cukup manual + satu jadwal sederhana bila murah).
- Mobile app, tema, i18n penuh.
- Postgres/Redis wajib (cukup SQLite + file; Postgres opsional).
- Auto-scaling multi-node.

Kriteria lulus MVP: checklist US-01 s.d. US-07 hijau di laptop + instalasi bersih di VPS bisa menjalankan satu run e2e.

## 10. Milestone 0 → Deploy

- **M0 — Bootstrap (hari 0–1):** repo + TS + lint/test, struktur modul, PRD ini disetujui, skrip dev.
  - Exit: `pnpm dev` tampil halaman kosong + `/healthz` OK.
- **M1 — Runtime hidup (hari 1–3):** model Task/Run + SQLite, eksekutor shell generik, log streaming web, start/stop persisten.
  - Exit: buat task → run shell → lihat log realtime → restart → state utuh.
- **M2 — Otak Muse + laporan (hari 3–6):** adapter Muse CLI, parser event, workflow step, laporan Markdown.
  - Exit: satu run Node/TS e2e menghasilkan laporan + diff + hasil test.
- **M3 — Limit & auto-resume (hari 6–8):** detektor kuota, scheduler reset ±5 jam, simulasi limit, notifikasi web.
  - Exit: run simulasi limit → `waiting_quota` → auto-resume → done tanpa prompt ulang.
- **M4 — Telegram izin (hari 8–10):** pairing bot, pesan approval + tombol, audit, timeout.
  - Exit: run butuh izin → approve dari Telegram → lanjut; reject → berhenti aman.
- **M5 — Hardening + VPS deploy (hari 10–14):** auth tunggal, backup/restore, Docker/skrip VPS, domain+TLS (reverse proxy), panduan operasi.
  - Exit: instalasi bersih di VPS Linux + domain bisa menjalankan run e2e + Telegram.

Setiap milestone: demo 5 menit + catatan risiko + update KPI.

## 11. KPI (diukur mingguan)

1. **Time-to-first-run:** dari install bersih ke run pertama selesai < 30 menit (laptop), < 45 menit (VPS).
2. **Auto-resume success:** ≥ 95% run yang kena limit/restart lanjut otomatis tanpa prompt ulang.
3. **Approval latency:** median waktu dari request izin ke keputusan < 10 menit (dengan Telegram).
4. **Report coverage:** 100% run selesai/gagal punya laporan Markdown.
5. **Ringan:** idle RAM < 150 MB, boot < 5 dtk pada laptop dev.
6. **Stabilitas:** 0 kehilangan state pada uji restart 10x; crash rate < 1 per 50 run.
7. **Kecepatan iterasi:** satu fitur kecil (satu adapter/step baru) selesai < 1 hari kerja.

## 12. Risiko & Mitigasi (ringkas)

- Format pesan limit Muse berubah → parser berbasis pola + fallback keyword + mode manual "tandai limit".
- Reset tidak tepat 5 jam → jadikan estimasi + probe berkala, bukan asumsi kaku.
- Telegram tidak stabil → web tetap bisa approve; antrean retry notifikasi.
- Subproses nyangkut → timeout + kill + checkpoint per step.
- Secrets bocor di log → redaction + file 600 + panduan env.

## 13. Pertanyaan Terbuka

1. OS laptop utama + manajer paket? (menentukan skrip M0/M1)
2. Domain VPS sudah ada? Butuh TLS otomatis (Caddy/Nginx)?
3. Batas konkurensi run default (1 atau 2) agar laptop tetap ringan?
4. Perlu mode offline penuh (tanpa Telegram) di MVP?

---
*File ini adalah sumber kebenaran MVP. Perubahan scope setelah M1 harus dicatat di sini + alasan.*
