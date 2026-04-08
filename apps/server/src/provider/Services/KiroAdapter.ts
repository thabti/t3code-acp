/**
 * KiroAdapter - ACP-based agent adapter service contract.
 *
 * Wraps any ACP-compatible agent (starting with kiro-cli) behind the shared
 * ProviderAdapterShape interface so the rest of the provider layer can treat
 * it identically to Codex or Claude adapters.
 *
 * @module KiroAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * KiroAdapterShape - Service API for the ACP-based agent adapter.
 */
export interface KiroAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kiro";
}

/**
 * KiroAdapter - Service tag for ACP-based agent adapter operations.
 */
export class KiroAdapter extends ServiceMap.Service<KiroAdapter, KiroAdapterShape>()(
  "t3/provider/Services/KiroAdapter",
) {}
