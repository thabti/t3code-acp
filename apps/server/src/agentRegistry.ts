/**
 * AgentRegistry — loads agent configuration from ~/.t3code/agents.json,
 * validates entries, and exposes them to the rest of the server.
 *
 * Auto-detects kiro-cli on PATH and adds it as the default agent.
 *
 * @module AgentRegistry
 */
import { AgentRegistryConfig, type AgentRegistryEntry, type ServerAgent } from "@t3tools/contracts";
import { Cause, Effect, FileSystem, Layer, Ref, Schema, ServiceMap } from "effect";
import { execSync } from "node:child_process";
import { ServerConfig } from "./config";

export class AgentRegistryError extends Schema.TaggedErrorClass<AgentRegistryError>()(
  "AgentRegistryError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Agent registry error at ${this.path}: ${this.detail}`;
  }
}

export interface AgentRegistryShape {
  readonly getEntries: Effect.Effect<ReadonlyArray<AgentRegistryEntry>, AgentRegistryError>;
  readonly getServerAgents: Effect.Effect<ReadonlyArray<ServerAgent>, AgentRegistryError>;
  readonly reload: Effect.Effect<void, AgentRegistryError>;
}

export class AgentRegistry extends ServiceMap.Service<AgentRegistry, AgentRegistryShape>()(
  "t3/agentRegistry/AgentRegistry",
) {}

const KIRO_CLI_AGENT_ID = "kiro" as AgentRegistryEntry["id"];

function detectKiroCli(): AgentRegistryEntry | null {
  try {
    const path = execSync("which kiro-cli", { encoding: "utf-8", timeout: 3000 }).trim();
    if (!path) return null;
    return {
      id: KIRO_CLI_AGENT_ID,
      name: "Kiro",
      transport: "stdio",
      command: path,
      args: ["acp"],
      enabled: true,
    };
  } catch {
    return null;
  }
}

const resolveAgentsPath = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const agentsPath = `${config.stateDir}/agents.json`;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(config.stateDir, { recursive: true }).pipe(Effect.ignore({ log: true }));
  return agentsPath;
});

const loadEntriesFromDisk = (agentsPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(agentsPath)
      .pipe(
        Effect.mapError(
          (cause) => new AgentRegistryError({ path: agentsPath, detail: "stat failed", cause }),
        ),
      );
    if (!exists) return [] as AgentRegistryEntry[];
    const raw = yield* fs
      .readFileString(agentsPath)
      .pipe(
        Effect.mapError(
          (cause) => new AgentRegistryError({ path: agentsPath, detail: "read failed", cause }),
        ),
      );
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => new AgentRegistryError({ path: agentsPath, detail: "invalid JSON", cause }),
    });
    const decoded = Schema.decodeUnknownExit(AgentRegistryConfig)(json);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("Failed to parse agents.json, using empty registry", {
        path: agentsPath,
        issues: Cause.pretty(decoded.cause),
      });
      return [] as AgentRegistryEntry[];
    }
    return decoded.value;
  });

/** Merge auto-detected kiro-cli with user-configured entries. */
function mergeWithAutoDetected(entries: ReadonlyArray<AgentRegistryEntry>): AgentRegistryEntry[] {
  const hasKiro = entries.some((e) => e.id === KIRO_CLI_AGENT_ID);
  if (hasKiro) return [...entries];
  const detected = detectKiroCli();
  if (!detected) return [...entries];
  return [detected, ...entries];
}

const toServerAgent = (entry: AgentRegistryEntry): ServerAgent => ({
  id: entry.id,
  name: entry.name,
  transport: entry.transport,
  enabled: entry.enabled,
  status: "disconnected",
});

export const AgentRegistryLive = Layer.effect(
  AgentRegistry,
  Effect.gen(function* () {
    const agentsPath = yield* resolveAgentsPath;
    const fs = yield* FileSystem.FileSystem;
    const diskEntries = yield* loadEntriesFromDisk(agentsPath).pipe(
      Effect.provide(Layer.succeed(FileSystem.FileSystem, fs)),
    );
    const initial = mergeWithAutoDetected(diskEntries);
    const entriesRef = yield* Ref.make<ReadonlyArray<AgentRegistryEntry>>(initial);

    yield* Effect.log(`Agent registry: ${initial.length} agent(s) registered`, {
      agents: initial.map((e) => ({ id: e.id, transport: e.transport, command: e.command })),
    });

    const reloadFromDisk = loadEntriesFromDisk(agentsPath).pipe(
      Effect.provide(Layer.succeed(FileSystem.FileSystem, fs)),
      Effect.map(mergeWithAutoDetected),
    );

    return {
      getEntries: Ref.get(entriesRef),
      getServerAgents: Ref.get(entriesRef).pipe(
        Effect.map((entries) => entries.filter((e) => e.enabled).map(toServerAgent)),
      ),
      reload: reloadFromDisk.pipe(Effect.flatMap((entries) => Ref.set(entriesRef, entries))),
    } satisfies AgentRegistryShape;
  }),
);
