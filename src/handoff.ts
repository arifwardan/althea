// Handoff antar-run: konteks "yang sudah dikerjakan" untuk MELANJUTKAN tugas.
// Setiap spawn CLI = proses baru TANPA memori run sebelumnya, jadi saat limit
// provider → ganti model/provider, timeout → retry, atau requeue manual, run
// berikutnya kehilangan konteks dan model baru mengulang dari nol (baca PRD
// dari awal). Ringkasan + diff di disk disuntik ke prompt berikutnya agar
// model baru LANJUT dari status terakhir.
//
// Kenapa bukan MCP: MCP hanya memberi TOOL ke model di dalam satu run — ia tak
// membawa konteks lintas proses. Konteks antar-run harus dibawa oleh Althea
// lewat prompt (inilah modul ini).

export const HANDOFF_MAX_CHARS = 2400;
const ROUND_MAX_CHARS = 800;

/**
 * Ringkasan pekerjaan dari output node implement yang sudah selesai.
 * Ambil EKOR tiap ronde (implementer menutup output dengan ringkasan kerjanya),
 * batasi agar prompt resume tetap ringkas. Tanpa output implement → "".
 */
export function buildHandoff(outputs: string[], maxChars = HANDOFF_MAX_CHARS): string {
  const rounds = outputs
    .filter((o) => o.startsWith("[implement]"))
    .map((o) => o.slice("[implement]".length).trim())
    .filter(Boolean)
    .map((s, i) => `- Round ${i + 1}: ${s.length > ROUND_MAX_CHARS ? `…${s.slice(-ROUND_MAX_CHARS)}` : s}`);
  if (!rounds.length) return "";
  const out = rounds.join("\n");
  return out.length > maxChars ? `…${out.slice(-maxChars)}` : out;
}

/**
 * Bagian prompt untuk run lanjutan: pekerjaan yang sudah selesai + diff di
 * disk + instruksi eksplisit agar model baru melanjutkan, bukan mulai ulang.
 * Dua-duanya kosong → "" (tak ada yang disuntik).
 */
export function buildResumeSection(handoff: string, diffStat: string): string {
  const h = handoff.trim();
  const stat = diffStat.trim();
  if (!h && !stat) return "";
  return [
    h ? `<WORK ALREADY DONE (earlier run of this task — continue, do NOT redo it):>\n${h}\n</WORK ALREADY DONE>` : "",
    stat ? `<CHANGES ALREADY ON DISK (git diff --stat):>\n${stat}\n</CHANGES ALREADY ON DISK>` : "",
    "The previous run stopped (provider limit / model switch / timeout). Continue exactly from where it stopped: check what already exists on disk first, then do only the remaining work — do NOT start over or re-read everything from scratch.",
  ].filter(Boolean).join("\n\n");
}
