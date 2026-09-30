# DESAIN-UI Aruna — v0 (awal)

Bahasa: Indonesia. Berlaku untuk semua halaman di `template/aruna`.
Arah gaya: hangat dan tenang seperti Helio (kertas hangat + aksen
amber, dark mode navy-ink), tetapi seluruh token dan kalimat di sini
ditulis dari nol untuk Aruna.

## 1. Prinsip

1. Satu bahasa visual: token CSS di `resources/css/app.css`, bukan
   warna lepas di tiap halaman.
2. Hierarki dulu, dekorasi belakangan: ukuran dan jarak membedakan
   bagian, bukan bayangan atau warna-warni.
3. Angka selalu `tabular-nums` agar tidak bergeser saat berubah.
4. Mobile dulu: grid 1 kolom, naik ke 2–3 kolom di `sm`/`lg`.

## 2. Warna

Terang = kertas hangat, gelap = ink navy. Aksen = amber (emas),
bukan ungu/biru.

| Token | Terang | Gelap | Dipakai untuk |
|---|---|---|---|
| `background` | kertas hangat `oklch(0.98 0.004 90)` | ink `oklch(0.17 0.02 265)` | latar halaman |
| `card` | hampir putih hangat | ink terangkat `oklch(0.20 0.023 264)` | panel, kartu |
| `primary` | amber `oklch(0.70 0.15 65)` | amber terang `oklch(0.79 0.15 71)` | tombol utama, badge status jalan |
| `muted` | abu hangat | ink lembut | latar sekunder |
| `muted-foreground` | abu baca | abu terang | teks sekunder |
| `border`/`input` | garis hangat tipis | garis ink | pembatas, field |
| `destructive` | merah bata | merah terang | hapus, supresi |

Aturan: teks di atas `primary` memakai `primary-foreground`
(gelap di terang, terang di gelap) agar kontras lolos. Dilarang:
gradasi ungu-biru, teks gradasi, glow di semua kartu, emoji sebagai
ikon fitur.

## 3. Tipografi

- UI: `Instrument Sans` (sudah terpasang via Bunny).
- Angka/statistik: tambah `tabular-nums`.
- Serif display: hanya untuk halaman sambutan/marketing, bukan
  untuk dasbor dan tabel kerja.
- Skala: judul halaman dari komponen `Heading` (sudah ada),
  judul panel `font-medium` (16px), isi tabel `text-sm` (14px),
  teks bantu `text-muted-foreground`.

## 4. Spacing (ini yang dirapikan dari Aruna sekarang)

Basis 4px. Pakai tangga ini, jangan nilai acak:

- `gap-6` (24px): jarak antar blok besar di halaman.
- `gap-4` (16px): jarak antar kartu di grid.
- `gap-3` (12px): isi form (`space-y-3`).
- `gap-2` (8px): label–field, tombol bersebelahan.
- Panel/kartu: `p-4`, naik ke `p-6` bila isinya lega.
- Sel tabel: `px-4 py-2`; baris data boleh `py-3` bila dua baris teks.
- Judul panel di dalam kartu: `mb-3`.
- Jangan campur `p-4` dan `p-6` untuk kartu sejenis di satu halaman.

## 5. Radius & bayangan

- Kartu/panel: `rounded-xl` (12px).
- Input/select/textarea/tombol: `rounded-md` (8px).
- Badge: `rounded-full`, `text-xs`.
- Bayangan: hampir tidak ada — pemisah utama adalah `border`.
  Satu bayangan lembut hanya untuk dropdown/dialog/modal.

## 6. Komponen baku

- Tombol: `Button` (`default` aksi utama, `outline` aksi kedua,
  `destructive` hapus, `sm` untuk aksi tabel). Link yang tampil
  seperti tombol memakai `asChild` + `Link`, bukan `href` di Button.
- Field: `Label` + `Input`/`select`/`textarea` + `InputError`.
  `select` dan `textarea` polos diberi class yang sama dengan Input:
  `w-full rounded-md border border-input bg-background px-3 py-2 text-sm`.
- Status: `Badge` (`default` = jalan/aktif/tercatat,
  `secondary` = draf/unsubscribed, `destructive` = supresi/gagal,
  `outline` = info netral).
- Tabel: `w-full text-sm`, thead `border-b text-left
  text-muted-foreground`, baris `border-b last:border-0`,
  bungkus `overflow-x-auto rounded-xl border`.
- Kosong: satu baris tengah `text-muted-foreground`
  ("Belum ada kontak."), bukan ilustrasi.
- Umpan balik: toast global (`Inertia::flash('toast', ...)`)
  untuk sukses/gagal; `InputError` untuk salah isi.

## 7. Pola halaman

1. `AppHead` + `Heading` (judul + satu kalimat deskripsi).
2. Panel form (buat/ubah) di atas, tabel di bawah.
3. Pagination: tombol Sebelumnya/Berikutnya, hanya bila ada.
4. Detail (mis. kampanye): baris ringkasan badge + aksi,
   lalu tabel isi.
5. Sidebar: Dashboard, Kontak, Segmen, Template, Kampanye, Supresi.

## 8. Cara memakai

1. Ubah warna hanya lewat variabel di `app.css` (`:root` dan `.dark`).
2. Halaman baru mencontoh `contacts/Index.svelte` (form + tabel),
   bukan menulis gaya sendiri.
3. Perubahan standar didiskusikan lewat file ini dulu, bukan
   langsung di tiap halaman.
