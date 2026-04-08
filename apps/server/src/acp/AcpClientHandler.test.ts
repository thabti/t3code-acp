import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";

import { createAcpClientHandler } from "./AcpClientHandler.ts";

describe("AcpClientHandler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-client-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeHandler = (overrides?: {
    onSessionUpdate?: (params: acp.SessionNotification) => void;
    onPermissionRequest?: (
      params: acp.RequestPermissionRequest,
    ) => Promise<acp.RequestPermissionResponse>;
  }) =>
    createAcpClientHandler({
      onSessionUpdate: overrides?.onSessionUpdate ?? vi.fn(),
      onPermissionRequest:
        overrides?.onPermissionRequest ??
        (async () => ({ outcome: { outcome: "cancelled" as const } })),
    });

  // ── requestPermission ──────────────────────────────────────────

  it("delegates requestPermission to the callback", async () => {
    const expectedResponse: acp.RequestPermissionResponse = {
      outcome: { outcome: "selected", optionId: "allow" },
    };
    const handler = makeHandler({
      onPermissionRequest: async () => expectedResponse,
    });

    const result = await handler.requestPermission({
      sessionId: "sess_1",
      toolCall: {
        toolCallId: "call_1",
        title: "Test tool",
        kind: "read",
        status: "pending",
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });

    expect(result).toEqual(expectedResponse);
  });

  // ── sessionUpdate ──────────────────────────────────────────────

  it("delegates sessionUpdate to the callback", async () => {
    const mockListener = vi.fn();
    const handler = makeHandler({ onSessionUpdate: mockListener });

    const notification: acp.SessionNotification = {
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    };

    await handler.sessionUpdate(notification);
    expect(mockListener).toHaveBeenCalledWith(notification);
  });

  // ── readTextFile ───────────────────────────────────────────────

  it("reads a full file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "line1\nline2\nline3\n");

    const handler = makeHandler();
    const result = await handler.readTextFile!({
      sessionId: "sess_1",
      path: filePath,
    });

    expect(result.content).toBe("line1\nline2\nline3\n");
  });

  it("reads a file with line and limit", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\n");

    const handler = makeHandler();
    const result = await handler.readTextFile!({
      sessionId: "sess_1",
      path: filePath,
      line: 2,
      limit: 2,
    });

    expect(result.content).toBe("line2\nline3");
  });

  // ── writeTextFile ──────────────────────────────────────────────

  it("writes a file and creates parent directories", async () => {
    const filePath = path.join(tmpDir, "nested", "dir", "output.txt");
    const handler = makeHandler();

    await handler.writeTextFile!({
      sessionId: "sess_1",
      path: filePath,
      content: "written content",
    });

    expect(fs.readFileSync(filePath, "utf-8")).toBe("written content");
  });

  // ── terminal lifecycle ─────────────────────────────────────────

  it("creates a terminal, gets output, waits for exit, and releases", async () => {
    const handler = makeHandler();

    const { terminalId } = await handler.createTerminal!({
      sessionId: "sess_1",
      command: "echo",
      args: ["hello world"],
    });

    expect(terminalId).toBeTruthy();

    const exitResult = await handler.waitForTerminalExit!({
      sessionId: "sess_1",
      terminalId,
    });

    expect(exitResult.exitCode).toBe(0);

    const outputResult = await handler.terminalOutput!({
      sessionId: "sess_1",
      terminalId,
    });

    expect(outputResult.output).toContain("hello world");
    expect(outputResult.truncated).toBe(false);
    expect(outputResult.exitStatus).toBeDefined();

    await handler.releaseTerminal!({
      sessionId: "sess_1",
      terminalId,
    });

    // After release, terminal should be gone
    await expect(handler.terminalOutput!({ sessionId: "sess_1", terminalId })).rejects.toThrow(
      "Unknown terminal",
    );
  });

  it("kills a terminal and retrieves output after kill", async () => {
    const handler = makeHandler();

    const { terminalId } = await handler.createTerminal!({
      sessionId: "sess_1",
      command: "sleep",
      args: ["60"],
    });

    await handler.killTerminal!({
      sessionId: "sess_1",
      terminalId,
    });

    const exitResult = await handler.waitForTerminalExit!({
      sessionId: "sess_1",
      terminalId,
    });

    // Killed processes have non-zero exit or a signal
    expect(exitResult.exitCode !== 0 || exitResult.signal !== null).toBe(true);

    // Release still works after kill
    await handler.releaseTerminal!({
      sessionId: "sess_1",
      terminalId,
    });
  });

  it("throws on unknown terminal id", async () => {
    const handler = makeHandler();

    await expect(
      handler.terminalOutput!({ sessionId: "sess_1", terminalId: "nonexistent" }),
    ).rejects.toThrow("Unknown terminal");
  });
});
