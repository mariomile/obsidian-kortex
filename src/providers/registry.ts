import type { ProviderAdapter, ProviderId } from "./types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";

/** Provider adapter registry, shared by the view and one-shot callers. */
export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};
