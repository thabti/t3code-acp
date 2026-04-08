import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

/** Branded identifier for an agent in the registry. */
export const AgentId = TrimmedNonEmptyString.pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;

/** Transport used to communicate with the agent. */
export const AgentTransport = Schema.Literals(["stdio", "websocket"]);
export type AgentTransport = typeof AgentTransport.Type;

/** Connection status of a registered agent. */
export const AgentConnectionStatus = Schema.Literals(["disconnected", "connecting", "connected"]);
export type AgentConnectionStatus = typeof AgentConnectionStatus.Type;

/** A single agent entry in the registry config file (~/.t3code/agents.json). */
export const AgentRegistryEntry = Schema.Struct({
  id: AgentId,
  name: TrimmedNonEmptyString,
  transport: AgentTransport,
  /** Required for stdio transport: the command to spawn. */
  command: Schema.optional(TrimmedNonEmptyString),
  /** Arguments passed to the spawned command. */
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Environment variables for the spawned process. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Required for websocket transport: the URL to connect to. */
  url: Schema.optional(TrimmedNonEmptyString),
  /** Whether this agent is enabled. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
});
export type AgentRegistryEntry = typeof AgentRegistryEntry.Type;

/** The full agent registry config (persisted as JSON array). */
export const AgentRegistryConfig = Schema.Array(AgentRegistryEntry);
export type AgentRegistryConfig = typeof AgentRegistryConfig.Type;

/** Agent info exposed to the browser via ServerConfig. */
export const ServerAgent = Schema.Struct({
  id: AgentId,
  name: TrimmedNonEmptyString,
  transport: AgentTransport,
  enabled: Schema.Boolean,
  status: AgentConnectionStatus,
});
export type ServerAgent = typeof ServerAgent.Type;

export const ServerAgents = Schema.Array(ServerAgent);
export type ServerAgents = typeof ServerAgents.Type;
