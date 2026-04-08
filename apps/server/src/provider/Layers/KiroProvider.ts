import type { KiroSettings } from "@t3tools/contracts";
import { Effect, Equal, Layer, Stream } from "effect";

import { AgentRegistry } from "../../agentRegistry";
import { ServerSettingsService } from "../../serverSettings";
import { buildServerProvider } from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { KiroProvider } from "../Services/KiroProvider";

const PROVIDER = "kiro" as const;

const checkKiroProviderStatus = Effect.gen(function* () {
  const agentRegistry = yield* AgentRegistry;
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings;
  const kiroSettings = settings.providers.kiro;
  const checkedAt = new Date().toISOString();
  if (!kiroSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kiro is disabled in T3 Code settings.",
      },
    });
  }
  const entries = yield* agentRegistry.getEntries;
  const kiroEntry = entries.find((e) => e.id === "kiro" && e.enabled);
  const isInstalled = kiroEntry !== undefined;
  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models: [],
    probe: {
      installed: isInstalled,
      version: null,
      status: isInstalled ? "ready" : "error",
      auth: { status: "authenticated" },
      ...(!isInstalled ? { message: "kiro-cli is not registered in the agent registry." } : {}),
    },
  });
}).pipe(Effect.orDie);

export const KiroProviderLive = Layer.effect(
  KiroProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const agentRegistry = yield* AgentRegistry;
    return yield* makeManagedServerProvider<KiroSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((s) => s.providers.kiro),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(Stream.map((s) => s.providers.kiro)),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider: checkKiroProviderStatus.pipe(
        Effect.provideService(AgentRegistry, agentRegistry),
        Effect.provideService(ServerSettingsService, serverSettings),
      ),
    });
  }),
);
