#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- Path normalization ---

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

// --- Persistent peer names (survives broker restarts) ---

const PERSISTENT_NAMES_FILE = nodePath.join(
  process.env.HOME || process.env.USERPROFILE || os.homedir(),
  ".claude-peers-names.json"
);

function readPersistentName(cwd: string): string | null {
  try {
    if (!fs.existsSync(PERSISTENT_NAMES_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(PERSISTENT_NAMES_FILE, "utf8"));
    const key = normalizePath(cwd);
    return data[key]?.name ?? null;
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath: string, data: unknown) {
  const tmpFile = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, filePath);
}

function writePersistentName(cwd: string, name: string) {
  try {
    let data: Record<string, { name: string; updated: number }> = {};
    if (fs.existsSync(PERSISTENT_NAMES_FILE)) {
      try {
        data = JSON.parse(fs.readFileSync(PERSISTENT_NAMES_FILE, "utf8"));
      } catch {
        // Corrupted, start fresh
      }
    }
    const key = normalizePath(cwd);
    data[key] = { name, updated: Date.now() };
    atomicWriteJson(PERSISTENT_NAMES_FILE, data);
    log(`Persistent name saved: ${key} -> ${name}`);
  } catch (e) {
    log(`Persistent name write failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Peer name bridge (for statusline) ---

const PEER_NAME_BRIDGE = nodePath.join(os.tmpdir(), "claude-peer-names.json");

function writePeerNameBridge(cwd: string, name: string, peerId: string) {
  try {
    let data: Record<string, { name: string; peer_id: string; pid: number; updated: number }> = {};
    if (fs.existsSync(PEER_NAME_BRIDGE)) {
      try {
        data = JSON.parse(fs.readFileSync(PEER_NAME_BRIDGE, "utf8"));
      } catch {
        // Corrupted file, start fresh
      }
    }
    const key = normalizePath(cwd);
    data[key] = { name, peer_id: peerId, pid: process.pid, updated: Date.now() };
    atomicWriteJson(PEER_NAME_BRIDGE, data);
    log(`Peer name bridge updated: ${key} -> ${name}`);
  } catch (e) {
    log(`Peer name bridge write failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- File-based inbox (durable buffer for missed channel pushes) ---

function getInboxDir(): string {
  return nodePath.join(myCwd, ".claudia", "inbox");
}

function writeInboxFile(msg: Message, sender?: Peer | null) {
  try {
    const inboxDir = getInboxDir();
    fs.mkdirSync(inboxDir, { recursive: true });
    const filePath = nodePath.join(inboxDir, `${msg.id}.json`);
    if (fs.existsSync(filePath)) return; // Already written (dedup)
    const data = {
      broker_message_id: msg.id,
      from_id: msg.from_id,
      from_name: sender?.name ?? "",
      from_cwd: sender?.cwd ?? "",
      text: msg.text,
      sent_at: msg.sent_at,
      received_at: new Date().toISOString(),
      processed: false,
    };
    atomicWriteJson(filePath, data);
    log(`Inbox file written: ${filePath}`);
  } catch (e) {
    log(`Inbox write failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function scanInboxFiles(): Array<{ broker_message_id: number; from_id: string; from_name: string; text: string; sent_at: string; processed: boolean }> {
  try {
    const inboxDir = getInboxDir();
    if (!fs.existsSync(inboxDir)) return [];
    const files = fs.readdirSync(inboxDir).filter((f: string) => f.endsWith(".json"));
    return files.map((f: string) => {
      try {
        return JSON.parse(fs.readFileSync(nodePath.join(inboxDir, f), "utf8"));
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// --- State ---

let myId: PeerId | null = null;
let myName: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages. Each instance is auto-assigned an Italian name for easy identification.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_name, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id. Use from_name to address them by name.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_name: Change your display name (overrides the auto-assigned one)
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "set_name",
    description:
      "Set a custom name for this instance (overrides the auto-assigned Italian name). This name is visible to other peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "The name for this instance (e.g. 'Pippo', 'Claudio')",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const label = p.name ? `${p.name} (${p.id})` : p.id;
          const parts = [
            `Name: ${label}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_name": {
      const { name } = args as { name: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-name", { id: myId, name });
        myName = name;
        writePeerNameBridge(myCwd, name, myId);
        writePersistentName(myCwd, name);
        return {
          content: [{ type: "text" as const, text: `Name updated: "${name}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting name: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        // Check broker for undelivered messages
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

        // Also scan file inbox for unprocessed messages
        const inboxFiles = scanInboxFiles().filter((f) => !f.processed);

        const brokerLines = result.messages.map(
          (m) => `[broker] From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        const inboxLines = inboxFiles.map(
          (f) => `[inbox] From ${f.from_name || f.from_id} (${f.sent_at}):\n${f.text}`
        );
        const allLines = [...brokerLines, ...inboxLines];

        if (allLines.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `${allLines.length} message(s) (${brokerLines.length} broker, ${inboxLines.length} inbox):\n\n${allLines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

// Exponential backoff state for broker connectivity
let pollBackoffMs = POLL_INTERVAL_MS;
const MAX_BACKOFF_MS = 30_000;

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    // Reset backoff on successful poll
    pollBackoffMs = POLL_INTERVAL_MS;

    if (result.messages.length === 0) return;

    // Cache sender info for this batch (avoid repeated lookups)
    let peerCache: Peer[] = [];
    try {
      peerCache = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        cwd: myCwd,
        git_root: myGitRoot,
      });
    } catch {
      // Non-critical
    }

    const ackedIds: number[] = [];

    for (const msg of result.messages) {
      const sender = peerCache.find((p) => p.id === msg.from_id);

      // Write to file inbox (durable buffer)
      writeInboxFile(msg, sender);

      // Attempt channel push
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.text,
            meta: {
              from_id: msg.from_id,
              from_name: sender?.name ?? "",
              from_summary: sender?.summary ?? "",
              from_cwd: sender?.cwd ?? "",
              sent_at: msg.sent_at,
            },
          },
        });
        ackedIds.push(msg.id);
        log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
      } catch (e) {
        log(`Channel push failed for msg ${msg.id}: ${e instanceof Error ? e.message : String(e)}`);
        // Don't ACK — will retry on next poll
      }
    }

    // ACK only successfully pushed messages
    if (ackedIds.length > 0) {
      try {
        await brokerFetch("/ack-messages", { id: myId, message_ids: ackedIds });
        log(`ACKed ${ackedIds.length} message(s)`);
      } catch (e) {
        log(`ACK failed (messages will be re-delivered): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    // Broker unreachable — apply exponential backoff
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
    pollBackoffMs = Math.min(pollBackoffMs * 2, MAX_BACKOFF_MS);
    log(`Backoff: next poll in ${pollBackoffMs}ms`);
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
  });
  myId = reg.id;
  myName = reg.name;
  log(`Registered as peer ${myId} (name: ${myName})`);

  // Restore persistent name if one was previously set for this CWD
  const persistedName = readPersistentName(myCwd);
  if (persistedName && persistedName !== myName) {
    try {
      await brokerFetch("/set-name", { id: myId, name: persistedName });
      myName = persistedName;
      log(`Restored persistent name: ${persistedName}`);
    } catch (e) {
      log(`Failed to restore persistent name (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Write peer name to bridge file so the statusline script can display it
  writePeerNameBridge(myCwd, myName, myId);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages (with dynamic backoff)
  let pollTimer: ReturnType<typeof setTimeout>;
  const schedulePoll = () => {
    pollTimer = setTimeout(async () => {
      await pollAndPushMessages();
      schedulePoll();
    }, pollBackoffMs);
  };
  schedulePoll();

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearTimeout(pollTimer);
    clearInterval(heartbeatTimer);
    // Remove peer name from bridge file
    try {
      if (fs.existsSync(PEER_NAME_BRIDGE)) {
        const data = JSON.parse(fs.readFileSync(PEER_NAME_BRIDGE, "utf8"));
        const key = normalizePath(myCwd);
        delete data[key];
        fs.writeFileSync(PEER_NAME_BRIDGE, JSON.stringify(data, null, 2));
      }
    } catch {
      // Best effort
    }
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
