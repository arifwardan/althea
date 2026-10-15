// Tipe data dashboard. Tipe inti (StackTask, Project, …) dipakai ulang
// dari backend via `import type` — import type terhapus saat kompilasi,
// jadi tidak ada coupling runtime antara web dan backend.
import type {
  AltheaState,
  Approval,
  ApprovalRecord,
  ApprovalItem,
  ApprovalListItem,
  ApprovalVia,
  BrainSetting,
  LimitsSetting,
  Project,
  StackTask,
  TaskActivity,
} from "../../../src/state";
import type { Metrics } from "../../../src/metrics";

export type {
  AltheaState,
  Approval,
  ApprovalRecord,
  ApprovalItem,
  ApprovalListItem,
  ApprovalVia,
  BrainSetting,
  LimitsSetting,
  Project,
  StackTask,
  TaskActivity,
  Metrics,
};

export interface BrainProvider {
  id: string;
  name: string;
}

export interface BrainModelOption {
  value: string;
  label: string;
  provider: string;
}

export interface BrainCatalog {
  providers: BrainProvider[];
  models: BrainModelOption[];
}

/** GET /api/brain — BrainSetting + katalog model + sumber tiap nilai. */
export interface BrainInfo extends BrainSetting {
  agentSource?: string;
  binSource?: string;
  modelSource?: string;
  effortSource?: string;
  efforts: string[];
  catalog: BrainCatalog;
}

/** GET /api/limits */
export interface LimitsInfo {
  timeoutSeconds: number;
  timeoutSource: string;
  timeoutOverride: number;
  min: number;
  max: number;
  defaultSeconds: number;
}

export interface BrainCheck {
  bin: string;
  ok: boolean;
  version: string;
  checkedAt: string;
}

/** GET /api/meta */
export interface MetaInfo {
  authRequired: boolean;
  approvalWebMinutes: number;
  approvalTelegramMinutes: number;
  approvalAutodecide: boolean;
  projectMaxMb: number;
  dryRun: boolean;
  loopSeconds: number;
  timeout: { seconds: number; source: string };
  timeoutMin: number;
  timeoutMax: number;
  graphEnabled: boolean;
  graphMaxRounds: number;
  brain: BrainCheck;
  stackOptions: Record<string, { id: string; label: string }[]>;
  categoryTaxonomy: Record<string, { id: string; label: string }[]>;
  categoryDimLabels: Record<string, string>;
  now: string;
}

/** GET /api/projects/:name/diff */
export interface ProjectDiff {
  repo: string;
  stat: string;
  diff: string;
}

/** GET /api/projects/:name/mcps */
export interface McpServer {
  id: string;
  desc: string;
  enabled: boolean;
  runnable: boolean;
  setupHint?: string;
}

export interface McpInfo {
  servers: McpServer[];
  enabled: string[];
  failed?: boolean;
}

/** GET /api/projects/:name/preview */
export interface PreviewInfo {
  state?: string;
  mode?: string;
  port?: number;
  url?: string;
  tabUrl?: string;
  savedCmd?: string;
  cmd?: string;
  cmdNote?: string;
  error?: string;
  logs?: string[];
  previewAvailable?: boolean;
  kind?: string;
  reachable?: boolean;
  lerdOk?: boolean;
}

/** Opsi Select (agent/provider/model/effort). */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
