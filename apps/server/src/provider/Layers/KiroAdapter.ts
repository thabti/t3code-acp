/**
 * KiroAdapterLive - ACP-based agent adapter implementation.
 *
 * Spawns an ACP agent (e.g. `kiro-cli acp`) as a child process, creates a
 * ClientSideConnection over ndjson stdio, and translates ACP session
 * notifications into canonical ProviderRuntimeEvents.
 *
 * @module KiroAdapterLive
 */
import type {
  AgentRegistryEntry,
  ProviderRuntimeEvent,
  RuntimeContentStreamKind,
} from "@t3tools/contracts";
import { EventId, RuntimeItemId, RuntimeRequestId, ThreadId, TurnId } from "@t3tools/contracts";
import * as acp from "@agentclientprotocol/sdk";
import { Deferred, Effect, Layer, Queue, Stream } from "effect";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { AgentRegistry } from "../../agentRegistry.ts";
import { createAcpClientHandler } from "../../acp/AcpClientHandler.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import { KiroAdapter, type KiroAdapterShape } from "../Services/KiroAdapter.ts";

const PROVIDER = "kiro" as const;
const KIRO_AGENT_ID = "kiro";

interface SessionContext {
  readonly acpSessionId: string;
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  activeTurnId: TurnId | undefined;
}

type PendingPermission = {
  readonly deferred: Deferred.Deferred<acp.RequestPermissionResponse, never>;
  readonly requestId: RuntimeRequestId;
};

function makeEventId(): EventId {
  return EventId.makeUnsafe(crypto.randomUUID());
}

function makeTurnId(): TurnId {
  return TurnId.makeUnsafe(crypto.randomUUID());
}

function makeItemId(): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(crypto.randomUUID());
}

function makeRequestId(): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(crypto.randomUUID());
}

function nowIso(): string {
  return new Date().toISOString();
}

function runtimeEvent(
  type: ProviderRuntimeEvent["type"],
  threadId: ThreadId,
  payload: Record<string, unknown>,
  opts?: {
    turnId?: TurnId;
    itemId?: RuntimeItemId;
    requestId?: RuntimeRequestId;
  },
): ProviderRuntimeEvent {
  return {
    eventId: makeEventId(),
    provider: PROVIDER,
    createdAt: nowIso(),
    threadId,
    ...(opts?.turnId ? { turnId: opts.turnId } : {}),
    ...(opts?.itemId ? { itemId: opts.itemId } : {}),
    ...(opts?.requestId ? { requestId: opts.requestId } : {}),
    type,
    payload,
  } as ProviderRuntimeEvent;
}

function nodeReadableToWeb(readable: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      readable.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      readable.on("end", () => controller.close());
      readable.on("error", (err) => controller.error(err));
    },
    cancel() {
      readable.destroy();
    },
  });
}

function nodeWritableToWeb(writable: Writable): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        writable.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise((resolve) => writable.end(resolve));
    },
    abort() {
      writable.destroy();
    },
  });
}

function findKiroEntry(entries: ReadonlyArray<AgentRegistryEntry>): AgentRegistryEntry | undefined {
  return entries.find((e) => e.id === KIRO_AGENT_ID && e.enabled);
}

function translateSessionUpdate(
  update: acp.SessionUpdate,
  threadId: ThreadId,
  turnId: TurnId | undefined,
  toolItemIds: Map<string, RuntimeItemId>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const turnOpts = turnId ? { turnId } : {};
  const kind = update.sessionUpdate;
  switch (kind) {
    case "agent_message_chunk": {
      const content = update.content;
      if (content && "text" in content && content.type === "text") {
        return [
          runtimeEvent(
            "content.delta",
            threadId,
            { streamKind: "assistant_text" as RuntimeContentStreamKind, delta: content.text },
            turnOpts,
          ),
        ];
      }
      return [];
    }
    case "agent_thought_chunk": {
      const content = update.content;
      if (content && "text" in content && content.type === "text") {
        return [
          runtimeEvent(
            "content.delta",
            threadId,
            { streamKind: "reasoning_text" as RuntimeContentStreamKind, delta: content.text },
            turnOpts,
          ),
        ];
      }
      return [];
    }
    case "tool_call": {
      const itemId = makeItemId();
      toolItemIds.set(update.toolCallId, itemId);
      return [
        runtimeEvent(
          "item.started",
          threadId,
          { itemType: "dynamic_tool_call", status: "inProgress", title: update.title },
          { ...turnOpts, itemId },
        ),
      ];
    }
    case "tool_call_update": {
      const itemId = toolItemIds.get(update.toolCallId) ?? makeItemId();
      const status = update.status;
      if (status === "completed") {
        return [
          runtimeEvent(
            "item.completed",
            threadId,
            {
              itemType: "dynamic_tool_call",
              status: "completed",
              title: update.title ?? undefined,
            },
            { ...turnOpts, itemId },
          ),
        ];
      }
      if (status === "in_progress") {
        return [
          runtimeEvent(
            "item.updated",
            threadId,
            {
              itemType: "dynamic_tool_call",
              status: "inProgress",
              title: update.title ?? undefined,
            },
            { ...turnOpts, itemId },
          ),
        ];
      }
      if (status === "failed") {
        return [
          runtimeEvent(
            "item.completed",
            threadId,
            { itemType: "dynamic_tool_call", status: "failed", title: update.title ?? undefined },
            { ...turnOpts, itemId },
          ),
        ];
      }
      return [];
    }
    case "plan": {
      const steps = update.entries.map((entry) => ({
        step: entry.content,
        status:
          entry.status === "completed"
            ? "completed"
            : entry.status === "in_progress"
              ? "inProgress"
              : "pending",
      }));
      return [runtimeEvent("turn.plan.updated", threadId, { plan: steps }, turnOpts)];
    }
    case "user_message_chunk":
    case "config_option_update":
    case "available_commands_update":
    case "current_mode_update":
    case "session_info_update":
    case "usage_update":
      return [];
    default:
      return [];
  }
}

const makeKiroAdapter = Effect.fn("makeKiroAdapter")(function* () {
  const agentRegistry = yield* AgentRegistry;
  const entries = yield* agentRegistry.getEntries;
  const kiroEntry = findKiroEntry(entries);

  if (!kiroEntry || !kiroEntry.command) {
    return yield* new ProviderAdapterProcessError({
      provider: PROVIDER,
      threadId: "" as ThreadId,
      detail: "kiro-cli agent not found in registry or missing command",
    });
  }

  const command = kiroEntry.command;
  const args = [...(kiroEntry.args ?? [])];

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: kiroEntry.env
      ? { ...process.env, ...kiroEntry.env }
      : (process.env as Record<string, string>),
  });

  const inputStream = nodeReadableToWeb(proc.stdout!);
  const outputStream = nodeWritableToWeb(proc.stdin!);
  const stream = acp.ndJsonStream(outputStream, inputStream);

  const sessions = new Map<string, SessionContext>();
  const pendingPermissions = new Map<string, PendingPermission>();
  const toolItemIds = new Map<string, RuntimeItemId>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const services = yield* Effect.services<never>();

  const publishEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    events.length > 0 ? Queue.offerAll(runtimeEventQueue, events) : Effect.void;

  const acpClient = createAcpClientHandler({
    onSessionUpdate(params) {
      const ctx = Array.from(sessions.values()).find((s) => s.acpSessionId === params.sessionId);
      if (!ctx) return;
      const events = translateSessionUpdate(
        params.update,
        ctx.threadId,
        ctx.activeTurnId,
        toolItemIds,
      );
      if (events.length > 0) {
        Queue.offerAll(runtimeEventQueue, events).pipe(Effect.runSyncWith(services));
      }
    },
    async onPermissionRequest(params) {
      const ctx = Array.from(sessions.values()).find((s) => s.acpSessionId === params.sessionId);
      if (!ctx) {
        return { outcome: { outcome: "cancelled" as const } };
      }
      const requestId = makeRequestId();
      const deferred = Deferred.make<acp.RequestPermissionResponse, never>().pipe(
        Effect.runSyncWith(services),
      );
      const key = `${ctx.threadId}:${requestId}`;
      pendingPermissions.set(key, { deferred, requestId });
      const turnOpts = ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {};
      const event = runtimeEvent(
        "request.opened",
        ctx.threadId,
        {
          requestType: "dynamic_tool_call",
          detail: params.toolCall.title ?? "Permission requested",
          args: { options: params.options, toolCall: params.toolCall },
        },
        { ...turnOpts, requestId },
      );
      Queue.offer(runtimeEventQueue, event).pipe(Effect.runSyncWith(services));
      return Deferred.await(deferred).pipe(Effect.runPromiseWith(services));
    },
  });

  const connection = new acp.ClientSideConnection(() => acpClient, stream);

  yield* Effect.tryPromise({
    try: () =>
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "t3code", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }),
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: "" as ThreadId,
        detail: `ACP initialize failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

  const getSession = (threadId: ThreadId): SessionContext => {
    const ctx = sessions.get(threadId);
    if (!ctx) throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    return ctx;
  };

  const startSession: KiroAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      const cwd = input.cwd ?? process.cwd();
      const result = yield* Effect.tryPromise({
        try: () => connection.newSession({ cwd, mcpServers: [] }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: `newSession failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });
      const ctx: SessionContext = {
        acpSessionId: result.sessionId,
        threadId: input.threadId,
        cwd,
        activeTurnId: undefined,
      };
      sessions.set(input.threadId, ctx);
      yield* publishEvents([
        runtimeEvent("session.started", input.threadId, {}),
        runtimeEvent("session.state.changed", input.threadId, { state: "ready" }),
      ]);
      return {
        provider: PROVIDER,
        status: "ready" as const,
        runtimeMode: input.runtimeMode,
        cwd,
        threadId: input.threadId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    },
  );

  const sendTurn: KiroAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const ctx = getSession(input.threadId);
    const turnId = makeTurnId();
    ctx.activeTurnId = turnId;
    yield* publishEvents([
      runtimeEvent("turn.started", input.threadId, {}, { turnId }),
      runtimeEvent("session.state.changed", input.threadId, { state: "running" }),
    ]);
    const promptText = input.input ?? "";
    Effect.tryPromise({
      try: () =>
        connection.prompt({
          sessionId: ctx.acpSessionId,
          prompt: [{ type: "text" as const, text: promptText }],
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.tap((response) =>
        publishEvents([
          runtimeEvent(
            "turn.completed",
            input.threadId,
            {
              state: response.stopReason === "cancelled" ? "interrupted" : "completed",
              stopReason: response.stopReason,
            },
            { turnId },
          ),
          runtimeEvent("session.state.changed", input.threadId, { state: "waiting" }),
        ]),
      ),
      Effect.catch((err: ProviderAdapterRequestError) =>
        publishEvents([
          runtimeEvent(
            "turn.completed",
            input.threadId,
            { state: "failed", errorMessage: err.message },
            { turnId },
          ),
          runtimeEvent("session.state.changed", input.threadId, { state: "waiting" }),
        ]),
      ),
      Effect.runPromiseWith(services),
    );
    return { threadId: input.threadId, turnId };
  });

  const interruptTurn: KiroAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const ctx = getSession(threadId);
      yield* Effect.tryPromise({
        try: () => connection.cancel({ sessionId: ctx.acpSessionId }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cancel",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    },
  );

  const respondToRequest: KiroAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const key = `${threadId}:${requestId}`;
      const pending = pendingPermissions.get(key);
      if (!pending) return;
      pendingPermissions.delete(key);
      const outcome: acp.RequestPermissionOutcome =
        decision === "accept" || decision === "acceptForSession"
          ? { outcome: "selected", optionId: "allow" }
          : { outcome: "cancelled" };
      yield* Deferred.succeed(pending.deferred, { outcome });
      yield* publishEvents([
        runtimeEvent(
          "request.resolved",
          threadId,
          { requestType: "dynamic_tool_call", decision },
          { requestId: pending.requestId },
        ),
      ]);
    },
  );

  const respondToUserInput: KiroAdapterShape["respondToUserInput"] = () => Effect.void;

  const stopSession: KiroAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      sessions.delete(threadId);
      yield* publishEvents([
        runtimeEvent("session.state.changed", threadId, { state: "stopped" }),
        runtimeEvent("session.exited", threadId, { reason: "stopped" }),
      ]);
    },
  );

  const listSessions: KiroAdapterShape["listSessions"] = () =>
    Effect.succeed(
      Array.from(sessions.values()).map((ctx) => ({
        provider: PROVIDER,
        status: "ready" as const,
        runtimeMode: "full-access" as const,
        cwd: ctx.cwd,
        threadId: ctx.threadId,
        activeTurnId: ctx.activeTurnId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })),
    );

  const hasSession: KiroAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: KiroAdapterShape["readThread"] = (threadId) =>
    Effect.succeed({ threadId, turns: [] });

  const rollbackThread: KiroAdapterShape["rollbackThread"] = (threadId) =>
    Effect.succeed({ threadId, turns: [] });

  const stopAll: KiroAdapterShape["stopAll"] = Effect.fn("stopAll")(function* () {
    for (const ctx of sessions.values()) {
      yield* publishEvents([
        runtimeEvent("session.state.changed", ctx.threadId, { state: "stopped" }),
        runtimeEvent("session.exited", ctx.threadId, { reason: "stopped" }),
      ]);
    }
    sessions.clear();
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Finalizers must not throw.
      }
    }).pipe(Effect.andThen(Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies KiroAdapterShape;
});

export const KiroAdapterLive = Layer.effect(KiroAdapter, makeKiroAdapter());

export function makeKiroAdapterLive(_options?: { nativeEventLogger?: unknown }) {
  return Layer.effect(KiroAdapter, makeKiroAdapter());
}
