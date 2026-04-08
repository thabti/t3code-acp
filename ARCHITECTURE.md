# T3 Code: deep architectural documentation

A minimal web GUI for coding agents (Codex, Claude). This document covers the full system architecture from build configuration through to the UI layer.

## Table of contents

1. [Monorepo structure and build pipeline](#1-monorepo-structure-and-build-pipeline)
2. [Package dependency graph](#2-package-dependency-graph)
3. [Contracts package: shared schema layer](#3-contracts-package-shared-schema-layer)
4. [Shared package: runtime utilities](#4-shared-package-runtime-utilities)
5. [Server architecture](#5-server-architecture)
6. [Orchestration engine (CQRS/Event Sourcing)](#6-orchestration-engine-cqrsevent-sourcing)
7. [Provider system](#7-provider-system)
8. [Persistence layer](#8-persistence-layer)
9. [WebSocket RPC protocol](#9-websocket-rpc-protocol)
10. [Web application architecture](#10-web-application-architecture)
11. [Desktop application](#11-desktop-application)
12. [Observability](#12-observability)
13. [Data flow: end-to-end message lifecycle](#13-data-flow-end-to-end-message-lifecycle)

---

## 1. Monorepo structure and build pipeline

The project uses Bun workspaces with Turborepo for task orchestration. Four apps and two shared packages live under a single repository.

```
t3code/
├── apps/
│   ├── server/       # Node.js/Bun WebSocket + HTTP server (npm: "t3")
│   ├── web/          # React 19 + Vite 8 SPA
│   ├── desktop/      # Electron 40 shell
│   └── marketing/    # Astro static site
├── packages/
│   ├── contracts/    # Effect Schema definitions (schema-only, no runtime)
│   └── shared/       # Shared runtime utilities (subpath exports)
└── scripts/          # Dev runner, release tooling, desktop artifact builder
```

### Build tools per package

| Package              | Build tool            | Output                                   |
| -------------------- | --------------------- | ---------------------------------------- |
| `apps/server`        | tsdown                | `dist/bin.mjs` (single ESM bundle)       |
| `apps/web`           | Vite 8                | `dist/` (static assets)                  |
| `apps/desktop`       | tsdown                | `dist-electron/` (Electron main process) |
| `apps/marketing`     | Astro                 | Static HTML                              |
| `packages/contracts` | tsdown                | `dist/` (ESM + CJS + DTS)                |
| `packages/shared`    | None (source imports) | Consumed via subpath exports             |

### Turborepo task graph

```mermaid
graph TD
    A["turbo build"] --> B["@t3tools/contracts#build"]
    B --> C["t3 (server)#build"]
    B --> D["@t3tools/web#build"]
    B --> E["@t3tools/desktop#build"]
    C --> F["dist/bin.mjs"]
    D --> G["dist/ (static)"]
    E --> H["dist-electron/"]

    I["turbo dev"] --> B
    B --> J["server dev (bun run src/bin.ts)"]
    B --> K["web dev (vite)"]
    B --> L["desktop dev (tsdown --watch + electron)"]
```

### Key toolchain choices

- **Runtime**: Bun 1.3.9+ or Node.js 24.10+ (dual-runtime support via dynamic imports)
- **TypeScript**: 5.7+ with strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- **Linting**: oxlint (Rust-based, plugins: eslint, oxc, react, unicorn, typescript)
- **Formatting**: oxfmt (Rust-based, includes `sortPackageJson`)
- **Testing**: Vitest 4 (unit + integration), Playwright (browser tests for web)
- **Effect-TS**: 4.0.0-beta.43 throughout (managed via Bun catalog)

---

## 2. Package dependency graph

```mermaid
graph LR
    subgraph Packages
        CONTRACTS["@t3tools/contracts<br/>(Effect Schema definitions)"]
        SHARED["@t3tools/shared<br/>(Runtime utilities)"]
    end

    subgraph Apps
        SERVER["t3 (server)<br/>Node.js/Bun"]
        WEB["@t3tools/web<br/>React + Vite"]
        DESKTOP["@t3tools/desktop<br/>Electron 40"]
        MARKETING["@t3tools/marketing<br/>Astro"]
    end

    CONTRACTS --> SHARED
    CONTRACTS --> SERVER
    CONTRACTS --> WEB
    CONTRACTS --> DESKTOP
    SHARED --> SERVER
    SHARED --> WEB
    SHARED --> DESKTOP
    WEB --> SERVER
    WEB --> DESKTOP
```

The dependency flow is strictly unidirectional: `contracts` → `shared` → `apps`. The server embeds the web app's built output to serve it as static files in production.

---

## 3. Contracts package: shared schema layer

`packages/contracts` is the single source of truth for all data shapes exchanged between server and client. It contains zero runtime logic; only Effect Schema definitions and TypeScript types.

```mermaid
graph TD
    subgraph "@t3tools/contracts"
        BASE["baseSchemas.ts<br/>ThreadId, TurnId, EventId,<br/>CommandId, ProjectId, IsoDateTime"]
        MODEL["model.ts<br/>ModelCapabilities, CodexModelOptions,<br/>ClaudeModelOptions, MODEL_SLUG_ALIASES"]
        ORCH["orchestration.ts<br/>OrchestrationEvent, OrchestrationCommand,<br/>OrchestrationReadModel, ProviderKind,<br/>ModelSelection, RuntimeMode"]
        PROV_RT["providerRuntime.ts<br/>RuntimeEvent types (50+ variants),<br/>CanonicalItemType, ToolLifecycleItemType"]
        PROVIDER["provider.ts<br/>ProviderSession, ProviderSendTurnInput,<br/>ProviderEvent, ProviderApprovalDecision"]
        TERMINAL["terminal.ts<br/>TerminalOpenInput, TerminalEvent,<br/>TerminalSessionSnapshot"]
        GIT["git.ts<br/>GitStackedAction, GitStatusResult,<br/>GitCreateWorktreeInput, GitHostingProvider"]
        SERVER["server.ts<br/>ServerConfig, ServerProvider,<br/>ServerConfigStreamEvent"]
        SETTINGS["settings.ts<br/>ServerSettings, ServerSettingsPatch"]
        RPC["rpc.ts<br/>WsRpcGroup (35 RPC methods),<br/>WS_METHODS constants"]
        IPC["ipc.ts<br/>NativeApi interface,<br/>DesktopBridge interface"]
        KEYBIND["keybindings.ts<br/>KeybindingRule,<br/>ResolvedKeybindingsConfig"]
        EDITOR["editor.ts<br/>EditorId, OpenInEditorInput"]
        PROJECT["project.ts<br/>ProjectSearchEntriesInput"]
    end

    BASE --> ORCH
    BASE --> PROV_RT
    BASE --> PROVIDER
    BASE --> TERMINAL
    BASE --> GIT
    BASE --> SERVER
    MODEL --> ORCH
    MODEL --> SERVER
    ORCH --> PROVIDER
    ORCH --> RPC
    PROVIDER --> RPC
    TERMINAL --> RPC
    GIT --> RPC
    SERVER --> RPC
    SETTINGS --> RPC
    KEYBIND --> SERVER
    EDITOR --> RPC
    PROJECT --> RPC
```

### RPC method categories (35 total)

| Category              | Methods                                                                                                                                                           | Transport            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Orchestration         | `getSnapshot`, `dispatchCommand`, `getTurnDiff`, `getFullThreadDiff`, `replayEvents`                                                                              | Request/Response     |
| Orchestration streams | `subscribeOrchestrationDomainEvents`                                                                                                                              | Server push (stream) |
| Terminal              | `open`, `write`, `resize`, `clear`, `restart`, `close`                                                                                                            | Request/Response     |
| Terminal streams      | `subscribeTerminalEvents`                                                                                                                                         | Server push (stream) |
| Git                   | `pull`, `refreshStatus`, `listBranches`, `createWorktree`, `removeWorktree`, `createBranch`, `checkout`, `init`, `resolvePullRequest`, `preparePullRequestThread` | Request/Response     |
| Git streams           | `subscribeGitStatus`, `runStackedAction`                                                                                                                          | Server push (stream) |
| Server                | `getConfig`, `refreshProviders`, `upsertKeybinding`, `getSettings`, `updateSettings`                                                                              | Request/Response     |
| Server streams        | `subscribeServerConfig`, `subscribeServerLifecycle`                                                                                                               | Server push (stream) |
| Project               | `searchEntries`, `writeFile`                                                                                                                                      | Request/Response     |
| Shell                 | `openInEditor`                                                                                                                                                    | Request/Response     |

---

## 4. Shared package: runtime utilities

`packages/shared` uses explicit subpath exports (no barrel index). Each export is a focused module consumed by both server and web.

| Subpath export                          | Purpose                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `@t3tools/shared/git`                   | Git status parsing, worktree helpers, status stream event application |
| `@t3tools/shared/logging`               | Structured logging utilities                                          |
| `@t3tools/shared/shell`                 | Shell command execution helpers                                       |
| `@t3tools/shared/Net`                   | Network port utilities (find free port, check availability)           |
| `@t3tools/shared/model`                 | Model slug resolution, alias mapping, provider defaults               |
| `@t3tools/shared/serverSettings`        | Settings file parsing and validation                                  |
| `@t3tools/shared/DrainableWorker`       | Effect-based worker that drains pending items before shutdown         |
| `@t3tools/shared/KeyedCoalescingWorker` | Deduplicates concurrent work by key (coalesces rapid updates)         |
| `@t3tools/shared/schemaJson`            | JSON encode/decode with Effect Schema validation                      |
| `@t3tools/shared/Struct`                | Struct manipulation utilities                                         |
| `@t3tools/shared/String`                | String utilities                                                      |
| `@t3tools/shared/projectScripts`        | Project script detection and parsing                                  |

---

## 5. Server architecture

The server (`apps/server`) is the system's backbone. It runs as a single Node.js/Bun process exposing HTTP + WebSocket endpoints, managing provider sessions, persisting state to SQLite, and orchestrating the full agent lifecycle.

### Server startup sequence

```mermaid
sequenceDiagram
    participant CLI as cli.ts (Effect CLI)
    participant BIN as bin.ts (Entry)
    participant CFG as ServerConfig
    participant BOOT as bootstrap.ts
    participant SRV as server.ts (runServer)
    participant HTTP as HTTP Server
    participant WS as WebSocket RPC
    participant STARTUP as ServerRuntimeStartup
    participant ORCH as OrchestrationEngine
    participant PROV as ProviderRegistry

    BIN->>CLI: Command.run(cli)
    CLI->>CFG: Resolve config (flags + env + bootstrap FD)
    CLI->>BOOT: readBootstrapEnvelope (optional FD 3)
    CLI->>SRV: runServer(config)
    SRV->>HTTP: Start HTTP server (Bun or Node)
    SRV->>WS: Mount WebSocket RPC route
    SRV->>STARTUP: Initialize runtime startup sequence
    STARTUP->>ORCH: Initialize orchestration engine
    STARTUP->>PROV: Detect and register providers (Codex, Claude)
    STARTUP-->>HTTP: markHttpListening()
    Note over STARTUP: Opens browser (unless --no-browser)
```

### Server layer composition

The server uses Effect's Layer system for dependency injection. All services are composed at startup into a single runtime layer.

````mermaid
graph TB
    subgraph "Infrastructure Layers"
        SQLITE["SqlitePersistenceLayer<br/>(SQLite + migrations)"]
        PTY["PtyAdapterLive<br/>(BunPTY or NodePTY)"]
        HTTP_SRV["HttpServerLive<br/>(BunHttpServer or NodeHttpServer)"]
        PLATFORM["PlatformServicesLive<br/>(Bun or Node services)"]
        FETCH["FetchHttpClient"]
    end

    subgraph "Domain Service Layers"
        ORCH_ENGINE["OrchestrationEngineLive"]
        ORCH_PIPELINE["OrchestrationProjectionPipelineLive"]
        ORCH_REACTOR["OrchestrationReactorLive"]
        PROV_CMD["ProviderCommandReactorLive"]
        PROV_INGEST["ProviderRuntimeIngestionLive"]
        CHKPT_REACTOR["CheckpointReactorLive"]
        RECEIPT_BUS["RuntimeReceiptBusLive"]
        PROV_SVC["ProviderServiceLive"]
        PROV_REG["ProviderRegistryLive"]
        CODEX["CodexAdapterLive"]
        CLAUDE["ClaudeAdapterLive"]
        ADAPTER_REG["ProviderAdapterRegistryLive"]
        GIT_CORE["GitCoreLive"]
        GIT_MGR["GitManagerLive"]
        GIT_STATUS["GitStatusBroadcasterLive"]
        GIT_HUB["GitHubCliLive"]
        TEXT_GEN["RoutingTextGenerationLive"]
        TERM_MGR["TerminalManagerLive"]
        KEYBIND["KeybindingsLive"]
        SETTINGS["ServerSettingsLive"]
        OPEN["OpenLive"]
        ANALYTICS["AnalyticsServiceLive"]
        OBSERV["ObservabilityLive"]
    end

    subgraph "Persistence Layers"
        EVT_STORE["OrchestrationEventStoreLive"]
        CMD_RECEIPT["OrchestrationCommandReceiptRepositoryLive"]
        PROJ_SNAP["OrchestrationProjectionSnapshotQueryLive"]
        CHKPT_STORE["CheckpointStoreLive"]
        CHKPT_DIFF["CheckpointDiffQueryLive"]
        PROV_SESS_RT["ProviderSessionRuntimeRepositoryLive"]
        PROV_SESS_DIR["ProviderSessionDirectoryLive"]
        EVT_LOG["EventNdjsonLogger"]
    end

    subgraph "HTTP/WS Layers"
        WS_RPC["websocketRpcRouteLayer"]
        STATIC["staticAndDevRouteLayer"]
        ATTACH["attachmentsRouteLayer"]
        OTLP["otlpTracesProxyRouteLayer"]
        FAVICON["projectFaviconRouteLayer"]
    end

    SQLITE --> EVT_STORE
    SQLITE --> CMD_RECEIPT
    SQLITE --> PROJ_SNAP
    SQLITE --> CHKPT_STORE
    SQLITE --> PROV_SESS_RT

    EVT_STORE --> ORCH_ENGINE
    CMD_RECEIPT --> ORCH_ENGINE
    ORCH_ENGINE --> ORCH_PIPELINE
    ORCH_ENGINE --> ORCH_REACTOR
    ORCH_ENGINE --> PROV_CMD
    RECEIPT_BUS --> PROV_INGEST
    PROV_INGEST --> ORCH_ENGINE

    CODEX --> ADAPTER_REG
    CLAUDE --> ADAPTER_REG
    ADAPTER_REG --> PROV_SVC
    PROV_SVC --> PROV_REG

    PTY --> TERM_MGR
    GIT_CORE --> GIT_MGR
    GIT_HUB --> GIT_MGR
    TEXT_GEN --> GIT_MGR

---

## 6. Orchestration engine (CQRS/Event Sourcing)

The orchestration engine is the core domain model. It implements a CQRS/Event Sourcing pattern where all state changes flow through commands that produce events, which are then projected into read models.

```mermaid
graph LR
    subgraph "Command Side (Write)"
        CMD["OrchestrationCommand<br/>(from client or server)"]
        NORM["Normalizer<br/>(canonicalize model slugs,<br/>validate input)"]
        INV["commandInvariants<br/>(pre-condition checks)"]
        DEC["Decider<br/>(command → events)"]
        STORE["OrchestrationEventStore<br/>(SQLite append-only log)"]
    end

    subgraph "Event Side (Read)"
        PROJ["Projector<br/>(events → read model deltas)"]
        PIPELINE["ProjectionPipeline<br/>(applies projections to SQLite)"]
        SNAP["ProjectionSnapshotQuery<br/>(materialized read model)"]
        BROADCAST["WebSocket push<br/>(domain events to clients)"]
    end

    subgraph "Reactors (Side Effects)"
        ORCH_REACT["OrchestrationReactor<br/>(lifecycle side effects)"]
        PROV_CMD_REACT["ProviderCommandReactor<br/>(start/stop/send to providers)"]
        CHKPT_REACT["CheckpointReactor<br/>(git checkpoint creation)"]
    end

    CMD --> NORM --> INV --> DEC
    DEC --> STORE
    STORE --> PIPELINE
    PIPELINE --> PROJ
    PROJ --> SNAP
    STORE --> BROADCAST
    STORE --> ORCH_REACT
    STORE --> PROV_CMD_REACT
    STORE --> CHKPT_REACT
````

### Command types (client-dispatched)

Commands flow from the web client through `orchestration.dispatchCommand`:

- `thread.create` / `thread.archive` / `thread.unarchive` / `thread.rename`
- `thread.sendTurn` / `thread.interruptTurn`
- `thread.respondToApproval` / `thread.respondToUserInput`
- `thread.startSession` / `thread.stopSession`
- `thread.activity.append` (server-generated activities)
- `project.create` / `project.remove` / `project.rename`

### Event flow through the projection pipeline

```mermaid
sequenceDiagram
    participant Client as Web Client
    participant WS as WebSocket RPC
    participant Engine as OrchestrationEngine
    participant Decider as Decider
    participant Store as EventStore (SQLite)
    participant Pipeline as ProjectionPipeline
    participant Projector as Projector
    participant Reactors as Reactors
    participant Broadcast as WS Broadcast

    Client->>WS: dispatchCommand(thread.sendTurn)
    WS->>Engine: dispatch(command)
    Engine->>Decider: decide(command, currentState)
    Decider-->>Engine: OrchestrationEvent[]
    Engine->>Store: append(events)
    Store-->>Pipeline: new events available
    Pipeline->>Projector: project(events)
    Note over Projector: Updates SQLite projection tables:<br/>threads, sessions, messages,<br/>turns, checkpoints, activities
    Store-->>Reactors: react to events
    Note over Reactors: ProviderCommandReactor starts<br/>provider session, sends turn
    Store-->>Broadcast: push events to subscribed clients
    Broadcast-->>Client: orchestration.domainEvent
```

### Decider: pure command-to-event logic

The decider (`orchestration/decider.ts`) is a pure function that takes a command and the current aggregate state, returning zero or more events. It enforces business rules:

- Thread must exist before sending a turn
- Session must be in a valid state for the requested operation
- Model selection is normalized through alias resolution
- Approval responses must reference valid pending requests

### Projector: event-to-read-model materialization

The projector (`orchestration/projector.ts`) transforms events into SQLite projection table updates. Projection tables include:

| Table                              | Purpose                                                     |
| ---------------------------------- | ----------------------------------------------------------- |
| `projection_projects`              | Project metadata (name, cwd, scripts)                       |
| `projection_threads`               | Thread state (title, status, model selection, runtime mode) |
| `projection_thread_sessions`       | Provider session state per thread                           |
| `projection_thread_messages`       | Chat messages (user + assistant)                            |
| `projection_turns`                 | Turn lifecycle (started, completed, failed)                 |
| `projection_checkpoints`           | Git checkpoint references per turn                          |
| `projection_pending_approvals`     | Outstanding approval requests                               |
| `projection_thread_activities`     | Work log entries (tool calls, file changes)                 |
| `projection_thread_proposed_plans` | AI-proposed execution plans                                 |

---

## 7. Provider system

The provider system abstracts coding agent backends behind a unified adapter interface. Two providers are supported: Codex (via `codex app-server` JSON-RPC over stdio) and Claude (via `@anthropic-ai/claude-agent-sdk`).

```mermaid
graph TB
    subgraph "Provider Abstraction"
        ADAPTER_IF["ProviderAdapter Interface<br/>(startSession, sendTurn,<br/>interruptTurn, stopSession,<br/>respondToRequest)"]
        ADAPTER_REG["ProviderAdapterRegistry<br/>(maps ProviderKind → Adapter)"]
    end

    subgraph "Codex Provider"
        CODEX_ADAPTER["CodexAdapter"]
        CODEX_APP["codex app-server<br/>(JSON-RPC over stdio)"]
        CODEX_PROV["CodexProvider<br/>(CLI detection, auth check,<br/>model listing)"]
        CODEX_ACCT["codexAccount<br/>(auth status)"]
        CODEX_VER["codexCliVersion<br/>(version detection)"]
    end

    subgraph "Claude Provider"
        CLAUDE_ADAPTER["ClaudeAdapter"]
        CLAUDE_SDK["@anthropic-ai/claude-agent-sdk"]
        CLAUDE_PROV["ClaudeProvider<br/>(CLI detection, auth check,<br/>model listing)"]
    end

    subgraph "Provider Lifecycle"
        PROV_SVC["ProviderService<br/>(session lifecycle manager)"]
        PROV_REG["ProviderRegistry<br/>(provider status, models,<br/>health checks)"]
        PROV_DIR["ProviderSessionDirectory<br/>(active session tracking)"]
        EVT_LOG["EventNdjsonLogger<br/>(raw event logging to disk)"]
        MANAGED["makeManagedServerProvider<br/>(Effect Scope lifecycle)"]
    end

    ADAPTER_IF --> CODEX_ADAPTER
    ADAPTER_IF --> CLAUDE_ADAPTER
    CODEX_ADAPTER --> CODEX_APP
    CLAUDE_ADAPTER --> CLAUDE_SDK
    CODEX_PROV --> PROV_REG
    CLAUDE_PROV --> PROV_REG
    ADAPTER_REG --> PROV_SVC
    PROV_SVC --> PROV_DIR
    PROV_SVC --> EVT_LOG
    PROV_SVC --> MANAGED
```

### Codex integration detail

```mermaid
sequenceDiagram
    participant Engine as OrchestrationEngine
    participant Reactor as ProviderCommandReactor
    participant Adapter as CodexAdapter
    participant AppSrv as codex app-server (stdio)
    participant Ingestion as ProviderRuntimeIngestion

    Engine->>Reactor: thread.session.started event
    Reactor->>Adapter: startSession(threadId, config)
    Adapter->>AppSrv: spawn child process<br/>(codex app-server --json-rpc)
    AppSrv-->>Adapter: JSON-RPC notifications (streaming)
    Note over Adapter: Translates Codex events to<br/>canonical RuntimeEvent format
    Adapter-->>Ingestion: RuntimeEvent stream
    Ingestion->>Engine: dispatch(orchestration events)
    Note over Engine: Events: turn.started, message.delta,<br/>item.started, item.completed,<br/>approval.requested, turn.completed
```

### Provider runtime event ingestion

The `ProviderRuntimeIngestion` layer bridges provider-specific events into the orchestration domain. It receives raw `RuntimeEvent` objects from adapters and translates them into `OrchestrationCommand` dispatches:

- `runtime.session.ready` → marks session as connected
- `runtime.content.delta` → streams text to the client
- `runtime.item.started/completed` → tracks tool executions
- `runtime.approval.requested` → creates pending approval
- `runtime.turn.completed` → finalizes the turn
- `runtime.session.error` → handles provider failures

The `RuntimeReceiptBus` provides backpressure-aware delivery of runtime receipts from providers to the ingestion pipeline.

---

## 8. Persistence layer

All server state is persisted to a single SQLite database with a migration system.

```mermaid
graph TD
    subgraph "SQLite Database (state.sqlite)"
        EVT_TBL["orchestration_events<br/>(append-only event log)"]
        CMD_TBL["orchestration_command_receipts<br/>(idempotency tracking)"]
        PROJ_TBL["projection_projects"]
        THR_TBL["projection_threads"]
        SESS_TBL["projection_thread_sessions"]
        MSG_TBL["projection_thread_messages"]
        TURN_TBL["projection_turns"]
        CHKPT_TBL["projection_checkpoints +<br/>checkpoint_diff_blobs"]
        APPR_TBL["projection_pending_approvals"]
        ACT_TBL["projection_thread_activities"]
        PLAN_TBL["projection_thread_proposed_plans"]
        PROV_RT["provider_session_runtime<br/>(resume cursors)"]
        PROJ_STATE["projection_state<br/>(last processed sequence)"]
    end

    subgraph "Migration System"
        MIG["persistence/Migrations/<br/>001 through 019"]
    end

    MIG --> EVT_TBL
    MIG --> CMD_TBL
    MIG --> PROJ_TBL
```

### Database access pattern

- **Event store**: Append-only writes. Events are never mutated or deleted.
- **Command receipts**: Idempotency guard; prevents duplicate command processing.
- **Projection tables**: Derived from events. Can be rebuilt by replaying the event log.
- **Projection state**: Tracks the last event sequence number processed by the projector.
- **Provider session runtime**: Stores resume cursors for provider session reconnection.

The server supports both Bun's native SQLite (`@effect/sql-sqlite-bun`) and Node.js's built-in `node:sqlite` via `NodeSqliteClient.ts`, selected at runtime.

---

## 9. WebSocket RPC protocol

Client-server communication uses Effect RPC over WebSocket. The protocol supports both request/response and server-push streaming patterns.

```mermaid
sequenceDiagram
    participant Browser as Web App
    participant Transport as WsTransport
    participant WS as WebSocket
    participant RpcServer as RPC Server (Effect)
    participant Handlers as WsRpcGroup Handlers

    Note over Browser,Handlers: Connection establishment
    Browser->>Transport: new WsTransport(url)
    Transport->>WS: WebSocket connect
    WS-->>Transport: Connected
    Transport->>RpcServer: Effect RPC handshake

    Note over Browser,Handlers: Request/Response
    Browser->>Transport: request(orchestration.getSnapshot)
    Transport->>WS: JSON-RPC request
    WS->>RpcServer: Route to handler
    RpcServer->>Handlers: ProjectionSnapshotQuery.get()
    Handlers-->>RpcServer: OrchestrationReadModel
    RpcServer-->>WS: JSON-RPC response
    WS-->>Transport: Response
    Transport-->>Browser: Promise<OrchestrationReadModel>

    Note over Browser,Handlers: Server push (streaming)
    Browser->>Transport: subscribe(orchestration.domainEvents)
    Transport->>WS: Stream subscription
    loop On each domain event
        Handlers-->>RpcServer: OrchestrationEvent
        RpcServer-->>WS: Stream frame
        WS-->>Transport: Event
        Transport-->>Browser: callback(event)
    end
```

### Client-side RPC architecture

```mermaid
graph TD
    subgraph "Web App RPC Layer"
        NATIVE_API["nativeApi.ts<br/>(NativeApi facade)"]
        WS_NATIVE["wsNativeApi.ts<br/>(WS-backed NativeApi impl)"]
        WS_RPC_CLIENT["wsRpcClient.ts<br/>(WsRpcClient: typed method groups)"]
        WS_TRANSPORT["wsTransport.ts<br/>(WsTransport: connection lifecycle)"]
        RPC_PROTOCOL["rpc/protocol.ts<br/>(Effect RPC client layer)"]
        RPC_CLIENT["rpc/client.ts<br/>(WsRpcAtomClient: Effect Atom integration)"]
        CONN_STATE["rpc/wsConnectionState.ts<br/>(reconnect backoff, connection atoms)"]
        SERVER_STATE["rpc/serverState.ts<br/>(ServerConfig atoms, lifecycle atoms)"]
        LATENCY["rpc/requestLatencyState.ts<br/>(request timing atoms)"]
    end

    NATIVE_API --> WS_NATIVE
    WS_NATIVE --> WS_RPC_CLIENT
    WS_RPC_CLIENT --> WS_TRANSPORT
    WS_TRANSPORT --> RPC_PROTOCOL
    RPC_CLIENT --> RPC_PROTOCOL
    RPC_PROTOCOL --> CONN_STATE
    SERVER_STATE --> RPC_CLIENT
```

The web app has two RPC consumption paths:

1. **Imperative** (`WsRpcClient`): Promise-based API used by hooks and event handlers
2. **Reactive** (`WsRpcAtomClient`): Effect Atom-based subscriptions that auto-reconnect and push state updates to React components via `@effect/atom-react`

---

## 10. Web application architecture

The web app (`apps/web`) is a React 19 SPA built with Vite 8, using TanStack Router for file-based routing and a layered state management approach.

### Route structure

```mermaid
graph TD
    ROOT["__root.tsx<br/>(QueryClient, AtomRegistry,<br/>theme, keybindings, WS connection)"]
    CHAT_LAYOUT["_chat.tsx<br/>(Sidebar + main area layout)"]
    CHAT_INDEX["_chat.index.tsx<br/>(New thread / empty state)"]
    CHAT_THREAD["_chat.$threadId.tsx<br/>(Active thread view)"]
    SETTINGS_LAYOUT["settings.tsx<br/>(Settings layout)"]
    SETTINGS_GENERAL["settings.general.tsx"]
    SETTINGS_ARCHIVED["settings.archived.tsx"]

    ROOT --> CHAT_LAYOUT
    ROOT --> SETTINGS_LAYOUT
    CHAT_LAYOUT --> CHAT_INDEX
    CHAT_LAYOUT --> CHAT_THREAD
    SETTINGS_LAYOUT --> SETTINGS_GENERAL
    SETTINGS_LAYOUT --> SETTINGS_ARCHIVED
```

### State management layers

```mermaid
graph TD
    subgraph "Server State (Effect Atoms)"
        SRV_CFG["serverConfigAtom<br/>(providers, keybindings,<br/>observability, settings)"]
        SRV_WELCOME["welcomeAtom<br/>(cwd, projectName,<br/>bootstrapIds)"]
        CONN["wsConnectionState atoms<br/>(status, reconnect backoff)"]
        LATENCY["requestLatencyState atoms"]
    end

    subgraph "Domain State (Zustand)"
        STORE["store.ts (AppState)<br/>projects[], threads[],<br/>sidebarThreadsById,<br/>threadIdsByProjectId"]
        COMPOSER["composerDraftStore.ts<br/>(per-thread draft state,<br/>attachments, model selection)"]
        TERMINAL["terminalStateStore.ts<br/>(terminal sessions,<br/>history, activity)"]
        UI_STATE["uiStateStore.ts<br/>(sidebar width, panel state,<br/>diff view preferences)"]
        THREAD_SEL["threadSelectionStore.ts<br/>(multi-select state)"]
    end

    subgraph "Derived/Query State (TanStack Query)"
        GIT_Q["gitReactQuery.ts<br/>(branch list, status)"]
        PROV_Q["providerReactQuery.ts<br/>(provider status polling)"]
        PROJ_Q["projectReactQuery.ts<br/>(project list)"]
        DESKTOP_Q["desktopUpdateReactQuery.ts<br/>(update check)"]
    end

    subgraph "Session Logic (Pure Functions)"
        SESS["session-logic.ts<br/>(deriveSessionPhase,<br/>derivePendingApprovals,<br/>findLatestProposedPlan)"]
        COMP_LOGIC["composer-logic.ts<br/>(canSendTurn, resolveModel)"]
        CHAT_LOGIC["ChatView.logic.ts<br/>(message grouping, scroll)"]
        SIDEBAR_LOGIC["Sidebar.logic.ts<br/>(thread filtering, sorting)"]
    end

    SRV_CFG --> STORE
    SRV_WELCOME --> STORE
    STORE --> SESS
    STORE --> COMP_LOGIC
    STORE --> CHAT_LOGIC
    STORE --> SIDEBAR_LOGIC
```

### Component hierarchy

```mermaid
graph TD
    ROOT_COMP["__root.tsx<br/>(providers, global listeners)"]
    APP_LAYOUT["AppSidebarLayout.tsx"]
    SIDEBAR["Sidebar.tsx<br/>(83KB - thread list, project picker,<br/>drag-and-drop reorder)"]
    CHAT_VIEW["ChatView.tsx<br/>(170KB - main chat interface)"]
    CHAT_BROWSER["ChatView.browser.tsx<br/>(96KB - browser-specific behaviors)"]

    subgraph "Chat Components"
        TIMELINE["MessagesTimeline.tsx<br/>(virtualized message list)"]
        VIRT["MessagesTimeline.virtualization.browser.tsx<br/>(TanStack Virtual integration)"]
        COMPOSER["ComposerPromptEditor.tsx<br/>(Lexical rich text editor)"]
        HEADER["ChatHeader.tsx"]
        MODEL_PICK["ProviderModelPicker.tsx"]
        TRAITS["TraitsPicker.tsx<br/>(reasoning effort, fast mode)"]
        APPROVAL["ComposerPendingApprovalPanel.tsx"]
        USER_INPUT["ComposerPendingUserInputPanel.tsx"]
        PLAN_CARD["ProposedPlanCard.tsx"]
        CONTEXT_WIN["ContextWindowMeter.tsx"]
        CHANGED["ChangedFilesTree.tsx"]
        COPY["MessageCopyButton.tsx"]
        CMD_MENU["ComposerCommandMenu.tsx"]
    end

    subgraph "Side Panels"
        DIFF_PANEL["DiffPanel.tsx<br/>(@pierre/diffs rendering)"]
        TERM_DRAWER["ThreadTerminalDrawer.tsx<br/>(xterm.js terminal)"]
        PLAN_SIDE["PlanSidebar.tsx"]
        PR_DIALOG["PullRequestThreadDialog.tsx"]
    end

    subgraph "Git Controls"
        BRANCH_TB["BranchToolbar.tsx"]
        BRANCH_SEL["BranchToolbarBranchSelector.tsx"]
        GIT_ACTIONS["GitActionsControl.tsx<br/>(commit, push, PR)"]
        PROJ_SCRIPTS["ProjectScriptsControl.tsx"]
    end

    subgraph "Settings"
        SETTINGS_PANELS["SettingsPanels.tsx<br/>(60KB - all settings UI)"]
        SETTINGS_NAV["SettingsSidebarNav.tsx"]
    end

    subgraph "UI Primitives (40+ components)"
        BTN["button, badge, card, dialog,<br/>menu, select, toast, tooltip,<br/>sidebar, command, combobox,<br/>popover, sheet, toggle..."]
    end

    ROOT_COMP --> APP_LAYOUT
    APP_LAYOUT --> SIDEBAR
    APP_LAYOUT --> CHAT_VIEW
    CHAT_VIEW --> TIMELINE
    TIMELINE --> VIRT
    CHAT_VIEW --> COMPOSER
    CHAT_VIEW --> HEADER
    CHAT_VIEW --> DIFF_PANEL
    CHAT_VIEW --> TERM_DRAWER
    HEADER --> MODEL_PICK
    HEADER --> BRANCH_TB
    COMPOSER --> CMD_MENU
    COMPOSER --> TRAITS
```

### Key UI technology choices

| Concern            | Technology                                   |
| ------------------ | -------------------------------------------- |
| Rich text input    | Lexical editor with custom mention nodes     |
| Message rendering  | react-markdown + remark-gfm                  |
| Terminal emulation | xterm.js with @xterm/addon-fit               |
| Diff rendering     | @pierre/diffs (web worker pool)              |
| Virtualized lists  | @tanstack/react-virtual                      |
| Drag and drop      | @dnd-kit (sortable thread list)              |
| Animations         | @formkit/auto-animate                        |
| Styling            | Tailwind CSS v4                              |
| UI primitives      | Base UI (@base-ui/react) + custom components |
| Icons              | lucide-react + VS Code icon manifest         |
| React optimization | React Compiler (babel plugin)                |

---

## 11. Desktop application

The desktop app (`apps/desktop`) is an Electron 40 shell that wraps the web app and the server process.

```mermaid
graph TD
    subgraph "Electron Main Process"
        MAIN["main.ts (47KB)<br/>(window management, server spawn,<br/>menu, deep links, tray)"]
        PRELOAD["preload.ts<br/>(contextBridge → DesktopBridge)"]
        UPDATE["updateMachine.ts<br/>(state machine for auto-updates)"]
        UPDATE_STATE["updateState.ts<br/>(serializable update state)"]
        RUNTIME_ARCH["runtimeArch.ts<br/>(arm64 translation detection)"]
        SHELL_ENV["syncShellEnvironment.ts<br/>(inherit user PATH)"]
        CONFIRM["confirmDialog.ts"]
        ROTATE_LOG["rotatingFileSink.ts"]
    end

    subgraph "Renderer Process"
        WEB["@t3tools/web<br/>(loaded via file:// or dev URL)"]
    end

    subgraph "Server Process"
        SERVER["t3 server<br/>(spawned as child process)"]
    end

    MAIN -->|"contextBridge"| PRELOAD
    PRELOAD -->|"window.desktopBridge"| WEB
    MAIN -->|"spawn + bootstrap FD"| SERVER
    WEB -->|"WebSocket"| SERVER
    MAIN -->|"electron-updater"| UPDATE
```

### Desktop-specific features

- **Auto-updater**: State machine (`updateMachine.ts`) manages check → download → install lifecycle
- **Bootstrap FD**: Server receives config via file descriptor 3 (avoids CLI args in process list)
- **Shell environment sync**: Inherits user's PATH from login shell for provider CLI detection
- **ARM64 translation detection**: Warns when running x64 binary under Rosetta
- **Hash history**: Uses `createHashHistory` for TanStack Router (file:// protocol compatibility)
- **Native context menus**: `DesktopBridge.showContextMenu` delegates to Electron's native menus

---

## 12. Observability

```mermaid
graph LR
    subgraph "Server-side"
        SRV_LOG["Server Logger<br/>(structured JSON to file)"]
        TRACE["LocalFileTracer<br/>(rotating trace files)"]
        METRICS["Metrics<br/>(counters, histograms)"]
        OTLP_SRV["OTLP Exporter<br/>(traces + metrics)"]
        RPC_INST["RpcInstrumentation<br/>(per-method spans)"]
        EVT_NDJSON["EventNdjsonLogger<br/>(provider events to disk)"]
    end

    subgraph "Client-side"
        CLIENT_TRACE["clientTracing.ts<br/>(browser spans)"]
        OTLP_PROXY["POST /api/observability/v1/traces<br/>(proxy to OTLP collector)"]
        BROWSER_COLLECT["BrowserTraceCollector<br/>(server-side decode + forward)"]
    end

    CLIENT_TRACE --> OTLP_PROXY
    OTLP_PROXY --> BROWSER_COLLECT
    BROWSER_COLLECT --> OTLP_SRV
    RPC_INST --> TRACE
    RPC_INST --> OTLP_SRV
    METRICS --> OTLP_SRV
```

### Configuration (environment variables)

| Variable                         | Purpose                                 |
| -------------------------------- | --------------------------------------- |
| `T3CODE_TRACE_MIN_LEVEL`         | Minimum log level for local trace files |
| `T3CODE_TRACE_FILE`              | Path to trace output file               |
| `T3CODE_TRACE_MAX_BYTES`         | Max size per trace file before rotation |
| `T3CODE_TRACE_MAX_FILES`         | Max number of rotated trace files       |
| `T3CODE_OTLP_TRACES_URL`         | OTLP collector endpoint for traces      |
| `T3CODE_OTLP_METRICS_URL`        | OTLP collector endpoint for metrics     |
| `T3CODE_OTLP_EXPORT_INTERVAL_MS` | Export batch interval                   |
| `T3CODE_LOG_WS_EVENTS`           | Log outbound WebSocket push traffic     |

---

## 13. Data flow: end-to-end message lifecycle

This diagram traces a user message from keyboard input through to the AI response appearing in the chat.

```mermaid
sequenceDiagram
    participant User as User (Browser)
    participant Composer as ComposerPromptEditor
    participant Store as Zustand Store
    participant NativeAPI as NativeApi
    participant Transport as WsTransport
    participant WS_Server as WebSocket RPC Server
    participant Engine as OrchestrationEngine
    participant Decider as Decider
    participant EventStore as SQLite EventStore
    participant Pipeline as ProjectionPipeline
    participant Reactor as ProviderCommandReactor
    participant Adapter as CodexAdapter / ClaudeAdapter
    participant Provider as codex app-server / Claude SDK
    participant Ingestion as ProviderRuntimeIngestion
    participant Broadcast as WS Broadcast

    User->>Composer: Type message + press Enter
    Composer->>Store: composerDraftStore.submit()
    Store->>NativeAPI: orchestration.dispatchCommand<br/>(thread.sendTurn)
    NativeAPI->>Transport: request(dispatchCommand, payload)
    Transport->>WS_Server: WebSocket JSON-RPC

    WS_Server->>Engine: dispatch(thread.sendTurn)
    Engine->>Decider: decide(command, state)
    Decider-->>Engine: [turn.started, message.user.created]
    Engine->>EventStore: append(events)

    par Projection
        EventStore-->>Pipeline: process events
        Pipeline->>Pipeline: Update projection tables
    and Broadcast to client
        EventStore-->>Broadcast: push domain events
        Broadcast-->>Transport: orchestration.domainEvent
        Transport-->>Store: store.applyOrchestrationEvent()
        Store-->>User: UI updates (message appears)
    and Provider side effect
        EventStore-->>Reactor: react(turn.started)
        Reactor->>Adapter: sendTurn(threadId, input)
        Adapter->>Provider: JSON-RPC / SDK call
    end

    loop Streaming response
        Provider-->>Adapter: content delta / tool call / approval
        Adapter-->>Ingestion: RuntimeEvent
        Ingestion->>Engine: dispatch(orchestration events)
        Engine->>EventStore: append(events)
        EventStore-->>Broadcast: push to client
        Broadcast-->>Transport: domain events
        Transport-->>Store: apply events
        Store-->>User: Streaming text / work log updates
    end

    Provider-->>Adapter: turn completed
    Adapter-->>Ingestion: runtime.turn.completed
    Ingestion->>Engine: dispatch(turn.completed)
    Engine->>EventStore: append
    EventStore-->>Broadcast: push
    Broadcast-->>User: Turn complete, UI idle
```

### Git integration flow

```mermaid
graph TD
    subgraph "Git Operations"
        GIT_CORE["GitCore<br/>(low-level git commands)"]
        GIT_MGR["GitManager<br/>(stacked actions: commit+push+PR)"]
        GIT_STATUS["GitStatusBroadcaster<br/>(file watcher → status stream)"]
        GIT_HUB["GitHubCli<br/>(gh CLI wrapper for PRs)"]
        TEXT_GEN["RoutingTextGeneration<br/>(AI-generated commit messages)"]
    end

    subgraph "Checkpointing"
        CHKPT_REACTOR["CheckpointReactor<br/>(auto-checkpoint on turn boundaries)"]
        CHKPT_STORE["CheckpointStore<br/>(git stash-based snapshots)"]
        CHKPT_DIFF["CheckpointDiffQuery<br/>(diff between checkpoints)"]
    end

    subgraph "Worktree Management"
        WORKTREE["Git Worktrees<br/>(isolated branch workspaces)"]
    end

    GIT_CORE --> GIT_MGR
    GIT_HUB --> GIT_MGR
    TEXT_GEN --> GIT_MGR
    GIT_CORE --> GIT_STATUS
    GIT_CORE --> CHKPT_STORE
    CHKPT_STORE --> CHKPT_DIFF
    CHKPT_REACTOR --> CHKPT_STORE
    GIT_MGR --> WORKTREE

    TEXT_GEN -->|"Codex"| CODEX_TG["CodexTextGeneration<br/>(gpt-5.4-mini)"]
    TEXT_GEN -->|"Claude"| CLAUDE_TG["ClaudeTextGeneration<br/>(claude-haiku-4-5)"]
```

---

## Appendix: environment variables

| Variable                 | Default     | Purpose                             |
| ------------------------ | ----------- | ----------------------------------- |
| `T3CODE_PORT`            | `3773`      | HTTP/WebSocket server port          |
| `T3CODE_MODE`            | `web`       | Runtime mode (`web` or `desktop`)   |
| `T3CODE_HOME`            | `~/.t3code` | Base directory for state and config |
| `T3CODE_NO_BROWSER`      | `false`     | Disable auto-open browser on start  |
| `T3CODE_AUTH_TOKEN`      | none        | Required token for WebSocket auth   |
| `VITE_WS_URL`            | auto        | WebSocket URL override for dev      |
| `VITE_DEV_SERVER_URL`    | none        | Dev web URL for proxy/redirect      |
| `ELECTRON_RENDERER_PORT` | none        | Electron dev renderer port          |
| `T3CODE_DESKTOP_WS_URL`  | none        | Desktop WebSocket URL override      |
