import { spawn, execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { getActiveSession, getModel, getCustomCwd, clearActiveSession, getTarget } from "./sessions.mjs";
import { ROLE } from "./role.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
let _configTimeout = 300000; // 5 min default
let _ownerChatId = null;
try {
  const cfg = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf-8"));
  if (cfg.claudeTimeoutMs) _configTimeout = cfg.claudeTimeoutMs;
  if (cfg.chatId) _ownerChatId = String(cfg.chatId);
} catch {}
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || String(_configTimeout), 10);
// The "server" target: the same CLI on a Linux box. Everything about that box comes from
// config.json - see README, "Mac and server". Paths are as seen on the server.
let _server = {};
try { _server = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf-8")); } catch {}
const _serverHost = _server.serverHost || "";
const _serverClaude = _server.serverClaude || "claude";
const _serverPrompt = _server.serverPrompt || "";
const _serverMcpConfig = _server.serverMcpConfig || "";
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
// A mac path means nothing on the server: the session's cwd is per-machine, so anything that
// is not a server path falls back to the home directory there.
const remoteCd = (cwd) => (cwd && !cwd.startsWith("/Users") && cwd.startsWith("/") ? `cd ${shQuote(cwd)}` : "cd");
const DEFAULT_CWD = process.env.DEFAULT_CWD || homedir();

// Find claude binary via PATH
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try { return execSync("which claude", { encoding: "utf-8" }).trim(); } catch {}
  return "claude";
}
const CLAUDE_BIN = findClaude();

const SYSTEM_PROMPT_FILE = join(__dirname, "..", "bot-system-prompt.md");
const SYSTEM_PROMPT_DIR = join(__dirname, "..");

// Per-chat default working directory (for guest accounts with isolated workspaces)
const GUEST_CWDS = {
  "738387207": join(homedir(), "develop", "yana-lawyer"), // Yana — legal assistant
};
const MCP_TELEGRAM_PATH = join(__dirname, "mcp-telegram.mjs");
const MCP_CONFIG_FILE = join(__dirname, "..", "mcp-config.json");

// Ensure mcp-config.json has absolute path to MCP server
try {
  const mcpConfig = { mcpServers: { telegram: { command: "node", args: [MCP_TELEGRAM_PATH] } } };
  writeFileSync(MCP_CONFIG_FILE, JSON.stringify(mcpConfig, null, 2));
} catch {}

const activeChildren = new Map(); // chatId → child process

export function killActiveChild(chatId = "default") {
  const child = activeChildren.get(chatId);
  if (child) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    activeChildren.delete(chatId);
    return true;
  }
  return false;
}

function spawnClaude(prompt, onEvent, { sessionId: resumeId, cwd, chatId = "default" } = {}) {
  return new Promise((resolve) => {
    const model = getModel();

    // Per-chat system prompt: bot-system-prompt.<chatId>.md, fallback to default
    let systemPrompt;
    try {
      const perChatFile = join(SYSTEM_PROMPT_DIR, `bot-system-prompt.${chatId}.md`);
      systemPrompt = readFileSync(perChatFile, "utf-8").trim();
    } catch {
      try { systemPrompt = readFileSync(SYSTEM_PROMPT_FILE, "utf-8").trim(); } catch {}
    }

    const isOwner = chatId === _ownerChatId;

    const toServer = getTarget() === "server";
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", model,
      "--disable-slash-commands",
    ];
    args.push("--dangerously-skip-permissions");
    if (!toServer) args.push("--mcp-config", MCP_CONFIG_FILE);

    // Guests can't run shell - too dangerous
    if (!isOwner) args.push("--disallowedTools", "Bash");

    // The server gets its own MCP servers and prompt instead of the mac's telegram bridge.
    if (toServer) {
      if (_serverMcpConfig) args.push("--mcp-config", _serverMcpConfig);
      if (_serverPrompt) args.push("--append-system-prompt-file", _serverPrompt);
    } else if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (resumeId) args.push("--resume", resumeId);
    // On the box itself the server target is local; only a mac worker reaches it over ssh.
    const remote = toServer && ROLE !== "primary";
    if (!remote) args.push(prompt);
    if (remote && !_serverHost) {
      resolve({ success: false, output: "serverHost is not set in config.json - see README, \"Mac and server\".", exitCode: -1 });
      return;
    }
    const child = remote
      ? spawn(
          "ssh",
          [
            "-o", "BatchMode=yes",
            "-o", "ServerAliveInterval=20",
            "-o", "StrictHostKeyChecking=accept-new",
            _serverHost,
            `[ -f ~/.claude-token.env ] && . ~/.claude-token.env; ${remoteCd(cwd)} && exec ${shQuote(_serverClaude)} ${args.map(shQuote).join(" ")}`,
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: CLAUDE_TIMEOUT,
            detached: true,
            env: { ...process.env, CLAUDE_SOURCE: "telegram" },
          },
        )
      : spawn(CLAUDE_BIN, args, {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: CLAUDE_TIMEOUT,
          detached: true,
          ...(cwd && { cwd }),
          env: { ...process.env, CLAUDE_SOURCE: "telegram", CLAUDECODE: "" },
        });

    if (remote) {
      child.stdin.end(prompt);
    }

    activeChildren.set(chatId, child);

    let resultText = "";
    let sessionId = null;
    let projectDir = null;
    let eventCwd = null;
    let usage = null;
    let costUsd = 0;
    let stderr = "";
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "system") {
            if (event.session_id) sessionId = event.session_id;
            if (event.cwd) {
              eventCwd = event.cwd;
              projectDir = event.cwd.replace(/\//g, "-");
            }
          }

          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") resultText = block.text;
            }
          }

          if (event.type === "result") {
            if (event.result && typeof event.result === "string") resultText = event.result;
            if (event.session_id) sessionId = event.session_id;
            if (event.usage) usage = event.usage;
            if (event.total_cost_usd) costUsd = event.total_cost_usd;
          }

          if (onEvent) onEvent(event);
        } catch {}
      }
    });

    child.stderr.on("data", (d) => { stderr += d; });

    child.on("error", (err) => {
      activeChildren.delete(chatId);
      resolve({ success: false, output: err.message, exitCode: -1 });
    });

    child.on("close", (code) => {
      activeChildren.delete(chatId);

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") {
            if (event.result && typeof event.result === "string") resultText = event.result;
            if (event.session_id) sessionId = event.session_id;
            if (event.usage) usage = event.usage;
            if (event.total_cost_usd) costUsd = event.total_cost_usd;
          }
          if (event.type === "system" && event.session_id) sessionId = event.session_id;
          if (onEvent) onEvent(event);
        } catch {}
      }

      if (!projectDir && cwd) projectDir = cwd.replace(/\//g, "-");

      const output = code !== 0
        ? (stderr.trim() || resultText.trim() || `Exit code ${code}`)
        : (resultText.trim() || "(empty response)");

      resolve({ success: code === 0, output, sessionId, projectDir, cwd: eventCwd, usage, costUsd, exitCode: code });
    });

    setTimeout(() => {
      activeChildren.delete(chatId);
      try { child.kill(); } catch {}
      resolve({ success: false, output: "Timeout", exitCode: -1 });
    }, CLAUDE_TIMEOUT);
  });
}

/**
 * Run Claude. If --resume fails, retry without it (stale session).
 */
export async function runClaude(prompt, onEvent, chatId = "default") {
  let { activeSessionId, activeCwd } = getActiveSession(chatId);

  // No session fallback to owner DM — each chat gets its own isolated session

  const cwd = getCustomCwd() || activeCwd || GUEST_CWDS[chatId] || DEFAULT_CWD;

  console.log(`🚀 runClaude chat=${chatId} session=${activeSessionId?.slice(0,8) || "none"} cwd=${cwd} prompt=${prompt.slice(0,60)}`);
  const result = await spawnClaude(prompt, onEvent, { sessionId: activeSessionId, cwd, chatId });
  console.log(`🏁 runClaude done exit=${result.exitCode} success=${result.success}`);

  // If resume failed — retry as new session
  if (!result.success && activeSessionId && result.exitCode === 1) {
    console.log("⚠️ Resume failed, retrying as new session…");
    clearActiveSession(chatId);
    return spawnClaude(prompt, onEvent, { cwd, chatId });
  }

  return result;
}
