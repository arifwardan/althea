// Estimasi token JUJUR: CLI langganan tak melaporkan pemakaian dan Anthropic
// tak mempublikasikan tokenizer Muse — jadi Althea menghitung KARAKTER secara
// pasti, lalu mengestimasi token (≈3,5 karakter/token, panduan Anthropic).
// Selalu tampilkan sebagai "estimasi", bukan angka exact.
export const CHARS_PER_TOKEN = 3.5;

export interface Usage {
  runs: number;
  charsIn: number;
  charsOut: number;
  tokIn: number;
  tokOut: number;
}

export function emptyUsage(): Usage {
  return { runs: 0, charsIn: 0, charsOut: 0, tokIn: 0, tokOut: 0 };
}

export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / CHARS_PER_TOKEN);
}

/** Catat satu run: karakter pasti masuk/keluar + estimasi tokennya. */
export function addRun(u: Usage, charsIn: number, charsOut: number): void {
  u.runs += 1;
  u.charsIn += charsIn;
  u.charsOut += charsOut;
  u.tokIn += Math.ceil(charsIn / CHARS_PER_TOKEN);
  u.tokOut += Math.ceil(charsOut / CHARS_PER_TOKEN);
}

export function totalTok(u: Usage): number {
  return u.tokIn + u.tokOut;
}

/** 950 → "950", 1500 → "1.5k". */
export function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
