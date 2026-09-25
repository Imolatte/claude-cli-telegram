import { readFileSync, writeFileSync, statSync } from "fs";
import { execFile, execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf-8")); } catch {}

// One bot token allows one poller. "primary" (the box) holds the bot unless the owner picked
// the mac; "standby" (the mac) takes it when the box is gone or the target is the mac.
// "solo" is the old single-worker behaviour.
export const ROLE = cfg.role || "solo";
// Standby only: how to reach the primary. Set in config.json, see README, "Mac and server".
const PRIMARY_HOST = cfg.primaryHost || "";
const PRIMARY_UNIT = cfg.primaryUnit || "tg-claude";
const PRIMARY_TARGET_FILE = cfg.primaryTargetFile || "";
const TARGET_FILE = join(__dirname, "target");
const HEARTBEAT_FILE = join(homedir(), ".tg-standby-heartbeat");
const CHECK_MS = 20_000;
const STANDBY_STALE_MS = 90_000;
const FAILS_BEFORE_TAKEOVER = 3;

let notify = () => {};
let holding = ROLE !== "standby";
let fails = 0;

const readTarget = () => {
  try { return readFileSync(TARGET_FILE, "utf-8").trim() || "server"; } catch { return "server"; }
};
const writeTarget = (target) => writeFileSync(TARGET_FILE, `${target}\n`);
const ssh = (cmd) => ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", PRIMARY_HOST, cmd];

export const isPaired = () => ROLE === "primary" || ROLE === "standby";

// The standby only ever runs things while it holds the bot, and then it runs them locally.
export function pairedTarget() {
  return ROLE === "primary" ? readTarget() : "mac";
}

export function setPairedTarget(target) {
  if (ROLE === "primary") {
    writeTarget(target);
    return true;
  }
  try {
    execFileSync("ssh", ssh(`echo ${target} > ${PRIMARY_TARGET_FILE}`), { timeout: 12_000 });
  } catch {
    return false;
  }
  if (target === "server") holding = false;
  return true;
}

function standbyAge() {
  try { return Date.now() - statSync(HEARTBEAT_FILE).mtimeMs; } catch { return Infinity; }
}

export function shouldPoll() {
  if (ROLE !== "primary") return holding;
  if (readTarget() !== "mac") return true;
  if (standbyAge() <= STANDBY_STALE_MS) return false;
  writeTarget("server");
  notify("🖥 Мак не отвечает - бот вернулся на сервер.");
  return true;
}

function setHolding(next, reason) {
  if (next === holding) return;
  holding = next;
  notify(reason);
}

function checkPrimary() {
  const cmd =
    "touch ~/.tg-standby-heartbeat; " +
    `if systemctl is-active --quiet ${PRIMARY_UNIT}; then cat ${PRIMARY_TARGET_FILE} 2>/dev/null || echo server; else echo down; fi`;
  execFile("ssh", ssh(cmd), { timeout: 15_000 }, (err, out) => {
    if (err) {
      fails += 1;
      if (fails >= FAILS_BEFORE_TAKEOVER) setHolding(true, "☁️ Сервер не отвечает - бот работает с мака.");
      return;
    }
    fails = 0;
    const state = String(out).trim();
    if (state === "down") setHolding(true, "☁️ Воркер на сервере остановлен - бот работает с мака.");
    else if (state === "mac") setHolding(true, "🖥 Бот на маке.");
    else setHolding(false, "☁️ Сервер на связи - бот вернулся туда.");
  });
}

export function startRole() {
  notify = (text) => console.log(`[role:${ROLE}] ${text}`);
  if (ROLE !== "standby") return;
  if (!PRIMARY_HOST || !PRIMARY_TARGET_FILE) {
    console.error("[role:standby] primaryHost and primaryTargetFile are required - acting as solo");
    holding = true;
    return;
  }
  checkPrimary();
  setInterval(checkPrimary, CHECK_MS);
}
