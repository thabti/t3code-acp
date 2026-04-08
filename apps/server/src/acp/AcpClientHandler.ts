/**
 * AcpClientHandler — implements the ACP `Client` interface.
 *
 * The ACP agent calls methods on this handler to:
 * - Request permission for tool calls (forwarded to the browser for user approval)
 * - Stream session updates (forwarded to the browser via WebSocket push)
 * - Read/write files on the local filesystem
 * - Create and manage terminal processes
 *
 * @module AcpClientHandler
 */
import type * as acp from "@agentclientprotocol/sdk";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as childProcess from "node:child_process";

/** Callback invoked when the agent sends a session/update notification. */
export type SessionUpdateListener = (params: acp.SessionNotification) => void;

/** Callback invoked when the agent requests permission. Returns the user's decision. */
export type PermissionRequestHandler = (
  params: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

interface AcpClientHandlerOptions {
  readonly onSessionUpdate: SessionUpdateListener;
  readonly onPermissionRequest: PermissionRequestHandler;
}

interface ManagedTerminal {
  readonly process: childProcess.ChildProcess;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
  readonly outputByteLimit: number;
  readonly exitPromise: Promise<void>;
}

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024; // 1 MB

/** Creates an `acp.Client` implementation backed by local fs and child processes. */
export function createAcpClientHandler(options: AcpClientHandlerOptions): acp.Client {
  const terminals = new Map<string, ManagedTerminal>();
  let terminalCounter = 0;

  return {
    async requestPermission(
      params: acp.RequestPermissionRequest,
    ): Promise<acp.RequestPermissionResponse> {
      return options.onPermissionRequest(params);
    },

    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
      options.onSessionUpdate(params);
    },

    async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
      const content = fs.readFileSync(params.path, "utf-8");
      if (params.line === undefined && params.limit === undefined) {
        return { content };
      }
      const lines = content.split("\n");
      const startLine = (params.line ?? 1) - 1;
      const sliced =
        params.limit != null
          ? lines.slice(startLine, startLine + params.limit)
          : lines.slice(startLine);
      return { content: sliced.join("\n") };
    },

    async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
      const dir = nodePath.dirname(params.path);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(params.path, params.content, "utf-8");
      return {};
    },

    async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
      const terminalId = `term_${++terminalCounter}`;
      const outputByteLimit = params.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT;
      const env = buildTerminalEnv(params.env);
      const proc = childProcess.spawn(params.command, params.args ?? [], {
        cwd: params.cwd ?? undefined,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });

      const terminal: ManagedTerminal = {
        process: proc,
        output: "",
        truncated: false,
        exitCode: null,
        signal: null,
        exited: false,
        outputByteLimit,
        exitPromise: new Promise<void>((resolve) => {
          proc.on("close", (code, sig) => {
            terminal.exitCode = code;
            terminal.signal = sig;
            terminal.exited = true;
            resolve();
          });
          proc.on("error", () => {
            terminal.exited = true;
            resolve();
          });
        }),
      };

      const appendOutput = (chunk: Buffer) => {
        terminal.output += chunk.toString("utf-8");
        truncateOutput(terminal);
      };
      proc.stdout?.on("data", appendOutput);
      proc.stderr?.on("data", appendOutput);

      terminals.set(terminalId, terminal);
      return { terminalId };
    },

    async terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
      const terminal = getTerminal(terminals, params.terminalId);
      return {
        output: terminal.output,
        truncated: terminal.truncated,
        ...(terminal.exited
          ? { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } }
          : {}),
      };
    },

    async waitForTerminalExit(
      params: acp.WaitForTerminalExitRequest,
    ): Promise<acp.WaitForTerminalExitResponse> {
      const terminal = getTerminal(terminals, params.terminalId);
      await terminal.exitPromise;
      return { exitCode: terminal.exitCode, signal: terminal.signal };
    },

    async killTerminal(params: acp.KillTerminalRequest): Promise<void> {
      const terminal = getTerminal(terminals, params.terminalId);
      if (!terminal.exited) {
        terminal.process.kill("SIGTERM");
      }
    },

    async releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<void> {
      const terminal = terminals.get(params.terminalId);
      if (!terminal) return;
      if (!terminal.exited) {
        terminal.process.kill("SIGTERM");
      }
      terminals.delete(params.terminalId);
    },
  };
}

function getTerminal(terminals: Map<string, ManagedTerminal>, terminalId: string): ManagedTerminal {
  const terminal = terminals.get(terminalId);
  if (!terminal) throw new Error(`Unknown terminal: ${terminalId}`);
  return terminal;
}

function truncateOutput(terminal: ManagedTerminal): void {
  const bytes = Buffer.byteLength(terminal.output, "utf-8");
  if (bytes <= terminal.outputByteLimit) return;
  terminal.truncated = true;
  // Truncate from the beginning to stay within the limit
  let buf = Buffer.from(terminal.output, "utf-8");
  const excess = buf.length - terminal.outputByteLimit;
  buf = buf.subarray(excess);
  // Ensure we're at a valid character boundary
  terminal.output = buf.toString("utf-8");
}

function buildTerminalEnv(
  envVars?: Array<{ name: string; value: string }>,
): Record<string, string> | undefined {
  if (!envVars || envVars.length === 0) return undefined;
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const { name, value } of envVars) {
    env[name] = value;
  }
  return env;
}
