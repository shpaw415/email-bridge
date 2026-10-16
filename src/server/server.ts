#!/usr/bin/env bun
// email-bridge dashboard page — multi-account manager.
// Runs under the open-bot control plane (OPEN_BOT_PAGE_PORT / OPEN_BOT_PAGE_TOKEN).
import * as fs from "node:fs";
import * as path from "node:path";

const PORT = Number(process.env.OPEN_BOT_PAGE_PORT ?? 4760);
const TOKEN = process.env.OPEN_BOT_PAGE_TOKEN ?? "";
const HOME = process.env.EMAILBRIDGE_HOME || "/home/agent";
const ACCOUNTS_PATH = process.env.EMAILBRIDGE_ACCOUNTS || path.join(HOME, ".open-bot", "pages-data", "email-bridge", "accounts.json");
const CLI = process.env.EMAILBRIDGE_CLI || "/usr/local/bin/ob-plugin-email-bridge-email";

const PRESETS: Record<string, { imap: [string, number]; smtp: [string, number]; smtpMode: string }> = {
  gmail: { imap: ["imap.gmail.com", 993], smtp: ["smtp.gmail.com", 465], smtpMode: "ssl" },
  yahoo: { imap: ["imap.mail.yahoo.com", 993], smtp: ["smtp.mail.yahoo.com", 465], smtpMode: "ssl" },
  outlook: { imap: ["outlook.office365.com", 993], smtp: ["smtp-mail.outlook.com", 587], smtpMode: "starttls" },
  custom: { imap: ["", 993], smtp: ["", 465], smtpMode: "ssl" },
};

type StoredAccount = {
  id: string; label: string; provider: string; email: string; password: string;
  imapHost: string; imapPort: number; imapMode: string;
  smtpHost: string; smtpPort: number; smtpMode: string; insecure: boolean;
};

function loadAccounts(): { defaultId: string; accounts: StoredAccount[] } {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
    return { defaultId: String(j.defaultId ?? ""), accounts: Array.isArray(j.accounts) ? j.accounts : [] };
  } catch {
    return { defaultId: "", accounts: [] };
  }
}

function saveAccounts(data: { defaultId: string; accounts: StoredAccount[] }): void {
  fs.mkdirSync(path.dirname(ACCOUNTS_PATH), { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 1), { mode: 0o600 });
}

function masked(a: StoredAccount) {
  const { password, ...rest } = a;
  return { ...rest, hasPassword: !!password };
}

function legacyAccount(): { provider: string; email: string } | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, ".config/open-bot/plugin-email-bridge.json"), "utf8"));
    const s = (k: string) => String(cfg?.settings?.[k] ?? "");
    const vaultAddr = String(cfg?.vault?.["email-address"]?.apiKey ?? "");
    const vaultPass = String(cfg?.vault?.["email-app-password"]?.apiKey ?? "");
    const addr = vaultAddr || s("email-address");
    const pass = vaultPass || s("email-password");
    return addr && pass ? { provider: s("provider") || "gmail", email: addr } : null;
  } catch {
    return null;
  }
}

function json(res: unknown, status = 200): Response {
  return new Response(JSON.stringify(res), { status, headers: { "content-type": "application/json" } });
}

function checkToken(req: Request): boolean {
  if (!TOKEN) return true;
  if (TOKEN === "dev-preview") return true;
  return req.headers.get("x-open-bot-page-token") === TOKEN;
}

function validAccountInput(b: any): { ok: true; fields: Omit<StoredAccount, "id"> } | { ok: false; error: string } {
  const provider = String(b.provider ?? "gmail").toLowerCase();
  if (!PRESETS[provider]) return { ok: false, error: "unknown provider: " + provider };
  const email = String(b.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, error: "invalid email address" };
  const label = String(b.label ?? "").trim() || email;
  const preset = PRESETS[provider];
  const imapHost = String(b.imapHost ?? "").trim() || preset.imap[0];
  const imapPort = Number(b.imapPort) || preset.imap[1];
  const smtpHost = String(b.smtpHost ?? "").trim() || preset.smtp[0];
  const smtpPort = Number(b.smtpPort) || preset.smtp[1];
  const imapMode = ["auto", "ssl", "starttls"].includes(b.imapMode) ? b.imapMode : "auto";
  const smtpMode = ["auto", "ssl", "starttls"].includes(b.smtpMode) ? b.smtpMode : (provider === "outlook" ? "starttls" : "ssl");
  return {
    ok: true,
    fields: {
      label, provider, email,
      password: String(b.password ?? ""),
      imapHost, imapPort, imapMode, smtpHost, smtpPort, smtpMode,
      insecure: !!b.insecure,
    },
  };
}

function testAccount(id: string): Response {
  const p = Bun.spawnSync([CLI, "folders", "--account", id], { timeout: 45000, stdout: "pipe", stderr: "pipe" });
  const out = (p.stdout.toString() + p.stderr.toString()).trim();
  const ok = p.exitCode === 0;
  const n = ok ? out.split("\n").filter((l) => l.trim()).length : 0;
  return json({ ok, output: ok ? out + `\n(${n} folders — auth OK)` : out });
}

// The UI is bundled by the control plane at install (from dashboard.pages.ui)
// and handed over via OPEN_BOT_PAGE_UI. Local checkouts / previews import the
// HTML live instead — Bun bundles app.ts + styles.css on the fly (bun --hot).
// Static value on purpose: the HTML import must be resolved before Bun.serve.
const routes: Record<string, unknown> = process.env.OPEN_BOT_PAGE_UI
  ? {
      "/": (): Response =>
        new Response(Bun.file(process.env.OPEN_BOT_PAGE_UI as string), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        }),
    }
  : { "/": await import("./index.html").then((m) => m.default) };

const server = Bun.serve({
  port: PORT,
  routes: routes as never,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (p === "/healthz") return new Response("ok");
    if (!checkToken(req)) return json({ error: "unauthorized" }, 401);

    const store = loadAccounts();

    if (p === "api/accounts" || p === "/api/accounts") {
      if (req.method === "GET") return json({ accounts: store.accounts.map(masked), defaultId: store.defaultId, legacy: legacyAccount() });
      if (req.method === "POST") {
        const b = await req.json().catch(() => null);
        const v = b && validAccountInput(b);
        if (!v || !v.ok) return json({ error: v ? v.error : "invalid JSON body" }, 400);
        if (store.accounts.some((a) => a.email.toLowerCase() === v.fields.email.toLowerCase()))
          return json({ error: "an account with this email already exists" }, 400);
        if (!v.fields.password) return json({ error: "app password required" }, 400);
        const acc: StoredAccount = { id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...v.fields };
        store.accounts.push(acc);
        if (!store.defaultId || b.makeDefault) store.defaultId = acc.id;
        saveAccounts(store);
        return json({ ok: true, account: masked(acc) });
      }
    }

    const m = p.match(/^\/api\/accounts\/([^/]+)(\/(default|test))?$/);
    if (m) {
      const acc = store.accounts.find((a) => a.id === m[1]);
      if (!acc) return json({ error: "account not found" }, 404);
      if (m[3] === "test" && req.method === "POST") return testAccount(acc.id);
      if (m[3] === "default" && req.method === "POST") {
        store.defaultId = acc.id;
        saveAccounts(store);
        return json({ ok: true, defaultId: store.defaultId });
      }
      if (!m[3] && req.method === "PUT") {
        const b = await req.json().catch(() => null);
        if (!b) return json({ error: "invalid JSON body" }, 400);
        const merged = { ...acc, ...b, password: (typeof b.password === "string" && b.password) ? b.password : acc.password };
        const v = validAccountInput(merged);
        if (!v.ok) return json({ error: v.error }, 400);
        Object.assign(acc, v.fields);
        saveAccounts(store);
        return json({ ok: true, account: masked(acc) });
      }
      if (!m[3] && req.method === "DELETE") {
        store.accounts = store.accounts.filter((a) => a.id !== acc.id);
        if (store.defaultId === acc.id) store.defaultId = store.accounts[0]?.id ?? "";
        saveAccounts(store);
        return json({ ok: true, defaultId: store.defaultId });
      }
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`email-bridge page listening on :${PORT}`);
