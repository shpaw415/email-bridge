#!/usr/bin/env bun
// email-bridge — IMAP/SMTP CLI for open-bot agents.
// Providers: gmail, yahoo, outlook, or custom (host/port settings).
// Credentials come from the plugin vault (email-address, email-app-password).
import * as fs from "node:fs";
import * as path from "node:path";
import * as tls from "node:tls";
import * as net from "node:net";

// ---------- config ----------

const CONFIG_PATH =
  process.env.EMAILBRIDGE_CONFIG ||
  path.join(process.env.HOME ?? "/home/agent", ".config", "open-bot", "plugin-email-bridge.json");

const ACCOUNTS_PATH =
  process.env.EMAILBRIDGE_ACCOUNTS ||
  path.join(process.env.HOME ?? "/home/agent", ".open-bot", "pages-data", "email-bridge", "accounts.json");

type StoredAccount = {
  id: string;
  label: string;
  provider: string;
  email: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapMode: string;
  smtpHost: string;
  smtpPort: number;
  smtpMode: string;
  insecure: boolean;
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

function loadConfig(): any {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function cfgGet(cfg: any, key: string): string {
  const v = cfg?.settings?.[key] ?? cfg?.configs?.[key] ?? cfg?.[key];
  return v === undefined || v === null ? "" : String(v);
}

function vaultGet(cfg: any, slug: string): string {
  const v = cfg?.vault?.[slug];
  if (!v) return "";
  return typeof v === "string" ? v : String(v.apiKey ?? "");
}

const PROVIDERS: Record<string, { imap: [string, number]; smtp: [string, number]; smtpMode: "ssl" | "starttls" }> = {
  gmail: { imap: ["imap.gmail.com", 993], smtp: ["smtp.gmail.com", 465], smtpMode: "ssl" },
  yahoo: { imap: ["imap.mail.yahoo.com", 993], smtp: ["smtp.mail.yahoo.com", 465], smtpMode: "ssl" },
  outlook: { imap: ["outlook.office365.com", 993], smtp: ["smtp-mail.outlook.com", 587], smtpMode: "starttls" },
};

let ACCT_FLAG = "";

function resolveAccount(): ReturnType<typeof settingsAccount> {
  const stored = loadAccounts();
  if (stored.accounts.length) {
    let pick = stored.accounts[0];
    if (ACCT_FLAG) {
      const t = ACCT_FLAG.trim().toLowerCase();
      const hit = stored.accounts.find((a) => a.id.toLowerCase() === t || a.label.toLowerCase() === t || a.email.toLowerCase() === t);
      if (!hit) {
        console.error("error: no account '" + ACCT_FLAG + "'. Known accounts: " + stored.accounts.map((a) => a.label + " <" + a.email + ">").join(", ") + ". Manage them on the Email dashboard tab.");
        process.exit(1);
      }
      pick = hit;
    } else if (stored.defaultId) {
      const def = stored.accounts.find((a) => a.id === stored.defaultId);
      if (def) pick = def;
    }
    return storedToAccount(pick);
  }
  if (ACCT_FLAG) {
    console.error("error: --account given but no accounts are configured. Add accounts on the Email dashboard tab, or with the email-address/email-password settings (single-account mode).");
    process.exit(1);
  }
  return settingsAccount();
}

function storedToAccount(a: StoredAccount): ReturnType<typeof settingsAccount> {
  const p = PROVIDERS[a.provider?.toLowerCase()] ?? PROVIDERS.gmail;
  const imapHost = a.imapHost || p.imap[0];
  const imapPort = Number(a.imapPort) || p.imap[1];
  const smtpHost = a.smtpHost || p.smtp[0];
  const smtpPort = Number(a.smtpPort) || p.smtp[1];
  const smtpMode = !a.smtpMode || a.smtpMode === "auto" ? p.smtpMode : (a.smtpMode as "ssl" | "starttls");
  const imapMode = !a.imapMode || a.imapMode === "auto" ? "ssl" : (a.imapMode as "ssl" | "starttls");
  return {
    cfg: {}, provider: a.provider, address: a.email, password: a.password.replace(/\s+/g, ""), insecure: !!a.insecure,
    id: a.id, label: a.label || a.email,
    imap: { host: imapHost, port: imapPort, mode: imapMode },
    smtp: { host: smtpHost, port: smtpPort, mode: smtpMode },
  };
}
function settingsAccount() {
  const cfg = loadConfig();
  const provider = (cfgGet(cfg, "provider") || "gmail").toLowerCase();
  const p = PROVIDERS[provider];
  const address = vaultGet(cfg, "email-address") || cfgGet(cfg, "email-address");
  const password = vaultGet(cfg, "email-app-password") || cfgGet(cfg, "email-password");
  if (!address || !password) {
    console.error(
      "error: account not configured. Set the settings 'email-address' and 'email-password' (app password) for plugin email-bridge — dashboard Plugins tab -> Email Bridge -> Settings, or from the shell: ob-plugin settings email-bridge email-address=you@example.com && ob-plugin settings email-bridge email-password=... . App passwords only (Gmail/Yahoo: needs 2FA; Outlook: myaccount.microsoft.com app passwords)."
    );
    process.exit(2);
  }
  const imapHost = cfgGet(cfg, "imap-host") || p?.imap[0] || "";
  const imapPort = Number(cfgGet(cfg, "imap-port")) || p?.imap[1] || 993;
  const smtpHost = cfgGet(cfg, "smtp-host") || p?.smtp[0] || "";
  const smtpPort = Number(cfgGet(cfg, "smtp-port")) || p?.smtp[1] || 465;
  const smtpModeRaw = cfgGet(cfg, "smtp-mode").toLowerCase();
  const smtpMode = smtpModeRaw === "auto" || !smtpModeRaw ? (p?.smtpMode ?? "ssl") : (smtpModeRaw as "ssl" | "starttls");
  const imapModeRaw = cfgGet(cfg, "imap-mode").toLowerCase();
  const imapMode = imapModeRaw === "auto" || !imapModeRaw ? "ssl" : (imapModeRaw as "ssl" | "starttls");
  const insecure = ["true", "1", "yes"].includes(cfgGet(cfg, "insecure").toLowerCase());
  if (!imapHost || !smtpHost) {
    console.error("error: provider '" + provider + "' unknown and no imap-host/smtp-host settings given. Set settings imap-host/imap-port/smtp-host/smtp-port/smtp-mode, or set provider to gmail|yahoo|outlook.");
    process.exit(2);
  }
  return { cfg, provider, address, password: password.replace(/\s+/g, ""), insecure, id: "", label: "settings", imap: { host: imapHost, port: imapPort, mode: imapMode }, smtp: { host: smtpHost, port: smtpPort, mode: smtpMode } };
}

// ---------- small utils ----------

function decodeBytes(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

function b64ToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
}

function decodeRfc2047(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs, enc, txt) => {
      const buf = enc.toLowerCase() === "b" ? b64ToBuf(txt) : decodeQuotedPrintableBytes(txt.replace(/_/g, " "));
      return decodeBytes(buf, cs);
    });
}

function decodeQuotedPrintableBytes(input: string): Buffer {
  const noSoft = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoft.length; i++) {
    if (noSoft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(noSoft.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(noSoft.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function b64Wrap(s: string): string {
  const b = Buffer.from(s, "base64").toString("base64");
  return (b.match(/.{1,76}/g) ?? []).join("\r\n");
}

function encodeHeaderWord(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = Buffer.from(s, "utf8").toString("base64");
  const chunks = b64.match(/.{1,40}/g) ?? [b64];
  return chunks.map((c) => "=?UTF-8?B?" + c + "?=").join(" ");
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
    "&agrave;": "à", "&Agrave;": "À", "&acirc;": "â", "&Acirc;": "Â", "&aacute;": "á", "&eacute;": "é", "&Eacute;": "É",
    "&egrave;": "è", "&Egrave;": "È", "&ecirc;": "ê", "&Ecirc;": "Ê", "&euml;": "ë", "&iuml;": "ï", "&ocirc;": "ô",
    "&Ocirc;": "Ô", "&ouml;": "ö", "&ugrave;": "ù", "&Ugrave;": "Ù", "&ucirc;": "û", "&ccedil;": "ç", "&Ccedil;": "Ç",
    "&ntilde;": "ñ", "&aelig;": "æ", "&oelig;": "œ", "&#8217;": "’", "&#8216;": "‘", "&#8220;": "“", "&#8221;": "”",
    "&#8211;": "–", "&#8212;": "—", "&#8230;": "…",
  };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (map[m]) return map[m];
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

function splitAddresses(s: string): { name: string; address: string }[] {
  if (!s) return [];
  const out: { name: string; address: string }[] = [];
  // split on commas not inside <>
  const parts: string[] = [];
  let cur = "", depth = 0;
  for (const ch of s) {
    if (ch === "<") depth++;
    if (ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const m = t.match(/^(.*?)<([^>]+)>/);
    if (m) out.push({ name: decodeRfc2047(m[1].trim().replace(/^"|"$/g, "")), address: m[2].trim() });
    else out.push({ name: "", address: t.replace(/^<|>$/g, "").trim() });
  }
  return out;
}

function parseHeaders(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = raw.replace(/\r\n/g, "\n").split(/\n(?=[^\s])/);
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim().replace(/\n\s+/g, " ");
    map.set(key, map.has(key) ? map.get(key) + ", " + val : val);
  }
  return map;
}

// ---------- MIME parsing ----------

type Part = {
  headers: Map<string, string>;
  contentType: string;
  charset: string;
  filename: string;
  text?: string;
  buf?: Buffer;
  children?: Part[];
};

function parsePart(headers: Map<string, string>, body: string): Part {
  const ctRaw = headers.get("content-type") || "text/plain; charset=utf-8";
  const ctMatch = ctRaw.match(/^([^;]+)/);
  const contentType = (ctMatch ? ctMatch[1] : "text/plain").trim().toLowerCase();
  const charsetM = ctRaw.match(/charset="?([^";]+)"?/i);
  const disp = headers.get("content-disposition") || "";
  const fname = ctRaw.match(/\bname="?([^";]+)"?/i)?.[1] || disp.match(/\bfilename="?([^";]+)"?/i)?.[1] || "";
  const part: Part = { headers, contentType, charset: charsetM?.[1] || "utf-8", filename: decodeRfc2047(fname) };
  const cte = (headers.get("content-transfer-encoding") || "7bit").trim().toLowerCase();
  const isAttachment = /^\s*attachment/i.test(disp) || (/\bname=/.test(ctRaw) && !contentType.startsWith("multipart") && fname !== "");

  if (contentType.startsWith("multipart/")) {
    const bM = ctRaw.match(/boundary="?([^";]+)"?/i);
    part.children = [];
    if (bM) {
      const boundary = "--" + bM[1];
      const segments = body.split(new RegExp("(?:^|\\r?\\n)" + escapeRe(boundary) + "(?:--)?[ \\t]*(?:\\r?\\n|$)"));
      for (const seg of segments) {
        if (!seg.trim()) continue;
        const idx = seg.search(/\r?\n\r?\n/);
        if (idx < 0) continue;
        const h = parseHeaders(seg.slice(0, idx));
        part.children.push(parsePart(h, seg.slice(idx).replace(/^\r?\n\r?\n/, "")));
      }
    }
    return part;
  }

  const decode = (): Buffer => {
    if (cte === "base64") return b64ToBuf(body);
    if (cte === "quoted-printable") return decodeQuotedPrintableBytes(body);
    return Buffer.from(body, "latin1");
  };

  if (isAttachment) {
    part.buf = decode();
    if (!part.filename) part.filename = "attachment-" + Math.random().toString(36).slice(2, 8);
    return part;
  }
  if (contentType === "text/plain" || contentType.startsWith("text/")) {
    part.text = decodeBytes(decode(), part.charset);
    return part;
  }
  if (contentType === "message/rfc822") {
    const raw = decode().toString("utf8");
    const idx = raw.search(/\r?\n\r?\n/);
    const h = parseHeaders(idx >= 0 ? raw.slice(0, idx) : raw);
    part.children = [parsePart(h, idx >= 0 ? raw.slice(idx).replace(/^\r?\n\r?\n/, "") : "")];
    return part;
  }
  // other (html handled by caller preference, keep text for html too)
  part.text = decodeBytes(decode(), part.charset);
  return part;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMessage(raw: Buffer): { headers: Map<string, string>; root: Part } {
  const s = raw.toString("latin1");
  let idx = s.search(/\r?\n\r?\n/);
  if (idx < 0) idx = s.length;
  const headerText = raw.subarray(0, Buffer.byteLength(s.slice(0, idx), "latin1")).toString("utf8");
  const headers = parseHeaders(headerText);
  const body = s.slice(idx).replace(/^\r?\n\r?\n/, "");
  return { headers, root: parsePart(headers, body) };
}

function pickText(part: Part): { text: string; attachments: Part[]; htmlOnly: boolean } {
  const attachments: Part[] = [];
  let plain = "", html = "";
  const walk = (p: Part) => {
    if (p.children) { p.children.forEach(walk); return; }
    if (p.buf !== undefined) { attachments.push(p); return; }
    const ct = p.contentType;
    if (ct === "text/plain") plain += (plain ? "\n\n" : "") + (p.text ?? "");
    else if (ct === "text/html") html += (p.text ?? "");
    else if (ct.startsWith("text/") || ct === "") plain += (plain ? "\n\n" : "") + (p.text ?? "");
    else attachments.push(p); // images inline etc.
  };
  walk(part);
  if (plain.trim()) return { text: plain.trim(), attachments, htmlOnly: false };
  if (html.trim()) return { text: stripHtml(html), attachments, htmlOnly: true };
  return { text: "", attachments, htmlOnly: false };
}

// ---------- IMAP client ----------

type ImapEntry = string | Buffer;

class Imap {
  sock: tls.TLSSocket | net.Socket;
  private rbuf = Buffer.alloc(0);
  private tagN = 0;
  private sockErr: Error | null = null;
  private closed = false;
  private pending: { res: () => void; rej: (e: Error) => void } | null = null;

  private constructor(sock: tls.TLSSocket | net.Socket) {
    this.sock = sock;
    sock.setNoDelay(true);
    this.attach(sock);
  }

  static async connect(host: string, port: number, insecure = false, mode: "ssl" | "starttls" = "ssl"): Promise<Imap> {
    if (mode === "ssl") {
      const sock = await new Promise<tls.TLSSocket>((res, rej) => {
        const s = tls.connect({ ...tlsOptions(host, insecure), port }, () => res(s));
        s.once("error", rej);
        s.setTimeout(30000, () => { s.destroy(new Error("IMAP timeout after 30s")); });
      });
      const c = new Imap(sock);
      const greet = await c.readLine();
      if (!/^\*\s+(OK|PREAUTH)/.test(greet)) throw new Error("IMAP: unexpected greeting: " + greet);
      return c;
    }
    const plain = await new Promise<net.Socket>((res, rej) => {
      const s = net.connect({ host, port }, () => res(s));
      s.once("error", rej);
      s.setTimeout(30000, () => s.destroy(new Error("IMAP timeout after 30s")));
    });
    const c = new Imap(plain as any);
    const greet = await c.readLine();
    if (!/^\*\s+(OK|PREAUTH)/.test(greet)) throw new Error("IMAP: unexpected greeting: " + greet);
    const r = await c.command("STARTTLS");
    if (r.status !== "OK") throw new Error("IMAP: STARTTLS refused: " + r.text);
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    const upgraded = await new Promise<tls.TLSSocket>((res, rej) => {
      const t = tls.connect({ ...tlsOptions(host, insecure), socket: plain }, () => res(t));
      t.once("error", rej);
    });
    c.sock = upgraded;
    c.attach(upgraded);
    return c;
  }

  private attach(sock: tls.TLSSocket | net.Socket) {
    sock.on("data", (d: Buffer) => {
      this.rbuf = Buffer.concat([this.rbuf, d]);
      const p = this.pending; this.pending = null; p?.res();
    });
    sock.on("error", (e) => {
      this.sockErr = e;
      const p = this.pending; this.pending = null; p?.rej(e);
    });
    sock.on("close", () => {
      this.closed = true;
      const p = this.pending; this.pending = null;
      p?.rej(new Error("IMAP connection closed" + (this.sockErr ? ": " + this.sockErr.message : "")));
    });
  }

  private fill(): Promise<void> {
    if (this.sockErr) return Promise.reject(this.sockErr);
    if (this.closed) return Promise.reject(new Error("IMAP connection closed"));
    return new Promise((res, rej) => { this.pending = { res, rej }; });
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const i = this.rbuf.indexOf("\r\n");
      if (i >= 0) {
        const line = this.rbuf.subarray(0, i).toString("utf8");
        this.rbuf = this.rbuf.subarray(i + 2);
        return line;
      }
      await this.fill();
    }
  }

  private async readLiteral(n: number): Promise<Buffer> {
    while (this.rbuf.length < n) await this.fill();
    const b = this.rbuf.subarray(0, n);
    this.rbuf = this.rbuf.subarray(n);
    return b;
  }

  async command(line: string): Promise<{ status: string; text: string; entries: ImapEntry[] }> {
    const tag = "A" + String(++this.tagN).padStart(4, "0");
    this.sock.write(tag + " " + line + "\r\n");
    const entries: ImapEntry[] = [];
    for (;;) {
      const phys = await this.readLine();
      const lit = phys.match(/\{(\d+)\}$/);
      if (lit) {
        entries.push(phys);
        entries.push(await this.readLiteral(Number(lit[1])));
        continue;
      }
      entries.push(phys);
      if (phys.startsWith(tag + " ")) {
        const rest = phys.slice(tag.length + 1);
        const sp = rest.indexOf(" ");
        return { status: rest.slice(0, sp < 0 ? rest.length : sp).toUpperCase(), text: sp < 0 ? "" : rest.slice(sp + 1), entries };
      }
    }
  }

  private records(entries: ImapEntry[]): { text: string; buffers: Buffer[] }[] {
    const out: { text: string; buffers: Buffer[] }[] = [];
    let cur = "", bufs: Buffer[] = [];
    for (const e of entries) {
      if (typeof e === "string") {
        cur += (cur ? "\n" : "") + e;
        if (!/\{\d+\}$/.test(e)) { out.push({ text: cur, buffers: bufs }); cur = ""; bufs = []; }
      } else bufs.push(e);
    }
    if (cur) out.push({ text: cur, buffers: bufs });
    return out;
  }

  quoteMailbox(name: string): string {
    return '"' + name.replace(/([\\"])/g, "\\$1") + '"';
  }

  async listFolders(): Promise<{ name: string; attrs: string[] }[]> {
    const r = await this.command('LIST "" "*"');
    const out: { name: string; attrs: string[] }[] = [];
    for (const rec of this.records(r.entries)) {
      const m = rec.text.match(/^\*\s+LIST\s+\(([^)]*)\)\s+(?:"([^"]*)"|(\S+))\s+(.+)$/);
      if (!m) continue;
      const raw = m[4].trim();
      const name = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"') : raw;
      out.push({ name, attrs: m[1].split(/\s+/).filter(Boolean) });
    }
    return out;
  }

  async resolveFolder(input: string): Promise<string> {
    const folders = await this.listFolders();
    const t = input.trim();
    const norm = (s: string) => s.toLowerCase().replace(/[/.]/g, "/");
    if (folders.some((f) => norm(f.name) === norm(t))) return t;
    const ci = folders.find((f) => norm(f.name) === norm(t));
    if (ci) return ci.name;
    const partial = folders.filter((f) => norm(f.name).endsWith("/" + norm(t)) || norm(f.name) === norm(t));
    if (partial.length === 1) return partial[0].name;
    const sub = folders.find((f) => f.name.toLowerCase().includes(norm(t)));
    if (sub) return sub.name;
    throw new Error('IMAP: folder "' + input + '" not found. Available: ' + folders.map((f) => f.name).join(", "));
  }

  async select(name: string): Promise<number> {
    const r = await this.command("SELECT " + this.quoteMailbox(name));
    if (r.status !== "OK") throw new Error("IMAP: cannot select folder " + name + ": " + r.text);
    const ex = r.entries.map((e) => (typeof e === "string" ? e : "")).join(" ").match(/\*\s+(\d+)\s+EXISTS/);
    return ex ? Number(ex[1]) : 0;
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const r = await this.command("UID SEARCH " + criteria);
    if (r.status !== "OK") throw new Error("IMAP: search failed: " + r.text);
    const ids: number[] = [];
    for (const rec of this.records(r.entries)) {
      const m = rec.text.match(/^\*\s+SEARCH\s*(.*)$/);
      if (m) for (const n of m[1].trim().split(/\s+/)) if (n && Number.isFinite(Number(n))) ids.push(Number(n));
    }
    return ids;
  }

  async fetchFull(uid: number): Promise<{ flags: string[]; internalDate: string; raw: Buffer } | null> {
    const r = await this.command(`UID FETCH ${uid} (FLAGS INTERNALDATE BODY.PEEK[])`);
    if (r.status !== "OK") throw new Error("IMAP: fetch failed: " + r.text);
    for (const rec of this.records(r.entries)) {
      if (rec.buffers.length && /FETCH/i.test(rec.text) && /BODY\s*\[\]|RFC822/i.test(rec.text)) {
        const fl = rec.text.match(/FLAGS\s+\(([^)]*)\)/i)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
        const idate = rec.text.match(/INTERNALDATE\s+"([^"]+)"/i)?.[1] ?? "";
        return { flags: fl, internalDate: idate, raw: rec.buffers[0] };
      }
    }
    return null;
  }

  async fetchHeaders(uids: number[]): Promise<Map<number, { flags: string[]; internalDate: string; raw: Buffer }>> {
    const out = new Map<number, { flags: string[]; internalDate: string; raw: Buffer }>();
    if (!uids.length) return out;
    const r = await this.command(`UID FETCH ${uids.join(",")} (FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REPLY-TO)])`);
    if (r.status !== "OK") throw new Error("IMAP: fetch failed: " + r.text);
    for (const rec of this.records(r.entries)) {
      const um = rec.text.match(/UID\s+(\d+)/i);
      if (!um || !rec.buffers.length) continue;
      const fl = rec.text.match(/FLAGS\s+\(([^)]*)\)/i)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
      const idate = rec.text.match(/INTERNALDATE\s+"([^"]+)"/i)?.[1] ?? "";
      out.set(Number(um[1]), { flags: fl, internalDate: idate, raw: rec.buffers[0] });
    }
    return out;
  }

  async store(uid: number, op: "+" | "-", flag: string): Promise<void> {
    const r = await this.command(`UID STORE ${uid} ${op}FLAGS.SILENT (${flag})`);
    if (r.status !== "OK") throw new Error("IMAP: store failed: " + r.text);
  }

  async expunge(): Promise<void> {
    await this.command("EXPUNGE");
  }

  async moveTo(uid: number, dest: string): Promise<void> {
    const r = await this.command(`UID MOVE ${uid} ` + this.quoteMailbox(dest));
    if (r.status === "OK") return;
    const c = await this.command(`UID COPY ${uid} ` + this.quoteMailbox(dest));
    if (c.status !== "OK") throw new Error("IMAP: move failed: " + r.text + " / " + c.text);
    await this.store(uid, "+", "\\Deleted");
    await this.expunge();
  }

  async close(): Promise<void> {
    try { await this.command("LOGOUT"); } catch { /* ignore */ }
    this.sock.destroy();
  }
}

function imapDateToIso(s: string): string {
  const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})/);
  if (!m) return s;
  const months: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const iso = `${m[3]}-${months[m[2].toLowerCase()] ?? "01"}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}${m[7]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

// ---------- SMTP client ----------

class Smtp {
  sock: tls.TLSSocket | net.Socket;
  private rbuf = Buffer.alloc(0);
  private sockErr: Error | null = null;
  private closed = false;
  private pending: { res: () => void; rej: (e: Error) => void } | null = null;

  private constructor(sock: tls.TLSSocket | net.Socket) {
    this.sock = sock;
    this.attach(sock);
  }

  private attach(sock: tls.TLSSocket | net.Socket) {
    sock.on("data", (d: Buffer) => {
      this.rbuf = Buffer.concat([this.rbuf, d]);
      const p = this.pending; this.pending = null; p?.res();
    });
    sock.on("error", (e) => {
      this.sockErr = e;
      const p = this.pending; this.pending = null; p?.rej(e);
    });
    sock.on("close", () => {
      this.closed = true;
      const p = this.pending; this.pending = null;
      p?.rej(new Error("SMTP connection closed" + (this.sockErr ? ": " + this.sockErr.message : "")));
    });
  }

  static async connect(host: string, port: number, mode: "ssl" | "starttls", insecure = false): Promise<Smtp> {
    if (mode === "ssl") {
      const s = await new Promise<tls.TLSSocket>((res, rej) => {
        const t = tls.connect({ ...tlsOptions(host, insecure), port }, () => res(t));
        t.once("error", rej);
        t.setTimeout(30000, () => t.destroy(new Error("SMTP timeout after 30s")));
      });
      const c = new Smtp(s); await c.reply(); return c;
    }
    const plain = await new Promise<net.Socket>((res, rej) => {
      const s = net.connect({ host, port }, () => res(s));
      s.once("error", rej);
      s.setTimeout(30000, () => s.destroy(new Error("SMTP timeout after 30s")));
    });
    const c0 = new Smtp(plain); await c0.reply();
    await c0.command("EHLO openbot.local");
    const r = await c0.command("STARTTLS");
    if (!r.code.startsWith("2")) throw new Error("SMTP: STARTTLS refused: " + r.code + " " + r.text);
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    const upgraded = await new Promise<tls.TLSSocket>((res, rej) => {
      const t = tls.connect({ ...tlsOptions(host, insecure), socket: plain }, () => res(t));
      t.once("error", rej);
    });
    c0.sock = upgraded;
    c0.attach(upgraded);
    await c0.reply();
    return c0;
  }

  private fill(): Promise<void> {
    if (this.sockErr) return Promise.reject(this.sockErr);
    if (this.closed) return Promise.reject(new Error("SMTP connection closed"));
    return new Promise((res, rej) => { this.pending = { res, rej }; });
  }

  private async reply(): Promise<{ code: string; text: string }> {
    for (;;) {
      const i = this.rbuf.indexOf("\r\n");
      if (i >= 0) {
        const line = this.rbuf.subarray(0, i).toString("utf8");
        this.rbuf = this.rbuf.subarray(i + 2);
        if (line.length >= 4 && line[3] === "-") continue; // multiline continuation
        return { code: line.slice(0, 3), text: line.slice(4) };
      }
      await this.fill();
    }
  }

  async command(line: string): Promise<{ code: string; text: string }> {
    this.sock.write(line + "\r\n");
    return this.reply();
  }

  async close(): Promise<void> {
    try { await this.command("QUIT"); } catch { /* ignore */ }
    this.sock.destroy();
  }
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mp3: "audio/mpeg", mp4: "video/mp4",
};

function guessType(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

function buildMessage(from: { name: string; address: string }, to: string[], cc: string[], subject: string, text: string, attachments: { filename: string; content: Buffer; contentType: string }[], extraHeaders: Record<string, string> = {}): string {
  const lines: string[] = [];
  lines.push("From: " + (from.name ? encodeHeaderWord(from.name) + " " : "") + "<" + from.address + ">");
  if (to.length) lines.push("To: " + to.map((a) => { const p = splitAddresses(a)[0]; return (p.name ? encodeHeaderWord(p.name) + " " : "") + "<" + p.address + ">"; }).join(", "));
  if (cc.length) lines.push("Cc: " + cc.map((a) => { const p = splitAddresses(a)[0]; return (p.name ? encodeHeaderWord(p.name) + " " : "") + "<" + p.address + ">"; }).join(", "));
  lines.push("Subject: " + encodeHeaderWord(subject));
  lines.push("Date: " + new Date().toUTCString().replace("GMT", "+0000"));
  const domain = from.address.split("@")[1] || "localhost";
  lines.push("Message-ID: <" + Date.now() + "." + Math.random().toString(36).slice(2) + "@" + domain + ">");
  for (const [k, v] of Object.entries(extraHeaders)) if (v) lines.push(k + ": " + encodeHeaderWord(v));
  lines.push("MIME-Version: 1.0");

  const textPart =
    "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64Wrap(Buffer.from(text, "utf8").toString("base64"));

  let body: string;
  if (attachments.length) {
    const boundary = "=_eb_" + Math.random().toString(36).slice(2, 12);
    lines.push("Content-Type: multipart/mixed; boundary=\"" + boundary + "\"");
    const parts = ["--" + boundary, textPart];
    for (const a of attachments) {
      parts.push(
        "--" + boundary,
        "Content-Type: " + a.contentType + "; name=\"" + a.filename.replace(/"/g, "'") + "\"",
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment; filename=\"" + a.filename.replace(/"/g, "'") + "\"",
        "",
        b64Wrap(a.content.toString("base64"))
      );
    }
    parts.push("--" + boundary + "--", "");
    body = parts.join("\r\n");
  } else {
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    body = "\r\n" + b64Wrap(Buffer.from(text, "utf8").toString("base64"));
  }
  return lines.join("\r\n") + "\r\n\r\n" + body;
}

async function smtpSend(acct: ReturnType<typeof resolveAccount>, msg: string, from: string, rcpts: string[]): Promise<void> {
  const s = await Smtp.connect(acct.smtp.host, acct.smtp.port, acct.smtp.mode, acct.insecure);
  try {
    let r = await s.command("EHLO openbot.local");
    if (!r.code.startsWith("2")) throw new Error("SMTP: EHLO failed: " + r.code + " " + r.text);
    r = await s.command("AUTH LOGIN");
    if (!r.code.startsWith("3")) throw new Error("SMTP: server does not offer AUTH LOGIN: " + r.code + " " + r.text);
    r = await s.command(Buffer.from(acct.address).toString("base64"));
    if (!r.code.startsWith("3")) throw new Error("SMTP: auth failed at username: " + r.code + " " + r.text);
    r = await s.command(Buffer.from(acct.password).toString("base64"));
    if (!r.code.startsWith("2")) throw new Error("SMTP: auth failed (check app password): " + r.code + " " + r.text);
    r = await s.command("MAIL FROM:<" + from + ">");
    if (!r.code.startsWith("2")) throw new Error("SMTP: MAIL FROM rejected: " + r.code + " " + r.text);
    for (const rc of rcpts) {
      r = await s.command("RCPT TO:<" + rc + ">");
      if (!r.code.startsWith("2")) throw new Error("SMTP: recipient rejected " + rc + ": " + r.code + " " + r.text);
    }
    r = await s.command("DATA");
    if (!r.code.startsWith("3")) throw new Error("SMTP: DATA refused: " + r.code + " " + r.text);
    const stuffed = msg.replace(/(^|\r\n)\./g, "$1..");
    await new Promise<void>((res, rej) => {
      s.sock.write(stuffed.endsWith("\r\n") ? stuffed + ".\r\n" : stuffed + "\r\n.\r\n", (e) => (e ? rej(e) : res()));
    });
    r = await s.reply();
    if (!r.code.startsWith("2")) throw new Error("SMTP: message rejected: " + r.code + " " + r.text);
  } finally {
    await s.close();
  }
}

// ---------- CLI helpers ----------

function bareAddresses(list: string[]): string[] {
  return list.map((a) => splitAddresses(a)[0]?.address ?? a).filter((a) => /.+@.+/.test(a));
}

function checkAddresses(list: string[], label: string): void {
  for (const a of list) {
    if (!/^[^\s@]+@[^\s@]+$/.test(splitAddresses(a)[0]?.address ?? a.trim())) {
      console.error(`error: invalid ${label} address: '${a}'. Use name@example.com or "Name" <name@example.com>.`);
      process.exit(1);
    }
  }
}

function parseArgs(argv: string[]): { opts: Record<string, string | boolean | string[]>; pos: string[] } {
  const opts: Record<string, string | boolean | string[]> = {};
  const pos: string[] = [];
  const multi = new Set(["attach", "cc", "bcc", "to"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      const name = eq >= 0 ? key.slice(0, eq) : key;
      let val: string | boolean;
      if (eq >= 0) val = key.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { val = argv[++i]; }
      else val = true;
      if (multi.has(name)) {
        const arr = Array.isArray(opts[name]) ? (opts[name] as string[]) : [];
        if (val !== true) arr.push(String(val));
        else if (eq < 0 && val === true) { /* flag without value on multi key: ignore */ }
        opts[name] = arr;
      } else opts[name] = val;
    } else pos.push(a);
  }
  return { opts, pos };
}

function readBodyInput(opts: Record<string, string | boolean | string[]>): string {
  if (typeof opts.body === "string") return opts.body;
  if (typeof opts["body-file"] === "string") return fs.readFileSync(String(opts["body-file"]), "utf8");
  try {
    if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8");
  } catch { /* no stdin */ }
  return "";
}

function optStrings(v: string | boolean | string[] | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

function tlsOptions(host: string, insecure: boolean): tls.ConnectionOptions {
  const opts: tls.ConnectionOptions = { host, rejectUnauthorized: !insecure };
  if (!net.isIP(host)) opts.servername = host; // SNI is not allowed for IP literals
  return opts;
}

async function withImap<T>(acct: ReturnType<typeof resolveAccount>, fn: (c: Imap) => Promise<T>): Promise<T> {
  const c = await Imap.connect(acct.imap.host, acct.imap.port, acct.insecure, acct.imap.mode);
  try {
    let r = await c.command("LOGIN " + c.quoteMailbox(acct.address) + " " + c.quoteMailbox(acct.password));
    if (r.status !== "OK") throw new Error("IMAP: login failed (check address and app password): " + r.text);
    try { await c.command("ENABLE UTF8=ACCEPT"); } catch { /* optional */ }
    const out = await fn(c);
    return out;
  } finally {
    await c.close();
  }
}

function buildSearchCriteria(opts: Record<string, string | boolean | string[]>): string {
  const parts: string[] = [];
  if (typeof opts.from === "string") parts.push("FROM " + JSON.stringify(opts.from));
  if (typeof opts.to === "string") parts.push("TO " + JSON.stringify(opts.to));
  if (typeof opts.subject === "string") parts.push("SUBJECT " + JSON.stringify(opts.subject));
  if (typeof opts.text === "string") parts.push("TEXT " + JSON.stringify(opts.text));
  const since = typeof opts.since === "string" ? opts.since : "";
  const before = typeof opts.before === "string" ? opts.before : "";
  const toImapDate = (v: string): string => {
    if (/^\d{1,3}(d|days?)$/i.test(v)) {
      const d = new Date(Date.now() - Number(v.match(/^\d+/)?.[0]) * 86400000);
      return d.toLocaleDateString("en-CA");
    }
    return v;
  };
  const fmt = (v: string): string => {
    const iso = toImapDate(v);
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error("bad date '" + v + "', use YYYY-MM-DD or Nd (days ago)");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${m[3]}-${months[Number(m[2]) - 1]}-${m[1]}`;
  };
  if (since) parts.push("SINCE " + fmt(since));
  if (before) parts.push("BEFORE " + fmt(before));
  return parts.join(" ");
}

// ---------- commands ----------

async function cmdCheck(opts: Record<string, string | boolean | string[]>, pos: string[]): Promise<void> {
  const acct = resolveAccount();
  await withImap(acct, async (c) => {
    const folder = await c.resolveFolder(typeof opts.folder === "string" ? opts.folder : pos[0] || "INBOX");
    const total = await c.select(folder);
    const unread = await c.uidSearch("UNSEEN");
    let uids: number[];
    if (opts.all === true) {
      const all = await c.uidSearch("ALL");
      uids = all.slice(-Number(opts.limit ?? 20));
    } else {
      uids = unread.slice(-Number(opts.limit ?? 20));
    }
    const hdrs = await c.fetchHeaders(uids);
    const rows = uids
      .slice()
      .reverse()
      .map((uid) => {
        const h = hdrs.get(uid);
        if (!h) return null;
        const { headers } = parseMessage(h.raw);
        const from = splitAddresses(decodeRfc2047(headers.get("from") ?? ""))[0];
        const fromStr = from ? (from.name ? from.name + " <" + from.address + ">" : from.address) : "(unknown)";
        return {
          uid,
          unread: !h.flags.includes("\\Seen"),
          from: fromStr,
          subject: decodeRfc2047(headers.get("subject") ?? "(no subject)"),
          date: imapDateToIso(h.internalDate),
          messageId: headers.get("message-id") ?? "",
        };
      })
      .filter(Boolean) as any[];
    if (opts.json === true) {
      console.log(JSON.stringify({ folder, total, unread: unread.length, messages: rows }, null, 2));
    } else {
      console.log(`folder=${folder} total=${total} unread=${unread.length}`);
      for (const r of rows) console.log(`${r.unread ? "*" : " "} #${r.uid} | ${r.date} | ${r.from} | ${r.subject}`);
      if (!rows.length) console.log(opts.all === true ? "(empty folder)" : "(no unread messages)");
    }
  });
}

async function cmdRead(opts: Record<string, string | boolean | string[]>, pos: string[]): Promise<void> {
  const uid = Number(pos[0]);
  if (!Number.isFinite(uid)) { console.error("error: read needs a message id (see: ob-plugin-email-bridge-email check)"); process.exit(1); }
  const acct = resolveAccount();
  await withImap(acct, async (c) => {
    const folder = await c.resolveFolder(typeof opts.folder === "string" ? opts.folder : "INBOX");
    await c.select(folder);
    const msg = await c.fetchFull(uid);
    if (!msg) { console.error("error: no message with id " + uid + " in " + folder); process.exit(1); }
    const { headers, root } = parseMessage(msg.raw);
    const { text, attachments, htmlOnly } = pickText(root);
    const from = splitAddresses(decodeRfc2047(headers.get("from") ?? ""))[0];
    const replyTo = splitAddresses(decodeRfc2047(headers.get("reply-to") ?? ""))[0];
    if (opts.json === true) {
      console.log(JSON.stringify({
        uid, folder, flags: msg.flags, date: imapDateToIso(msg.internalDate),
        messageId: headers.get("message-id") ?? "",
        from, replyTo: replyTo ?? null,
        to: splitAddresses(decodeRfc2047(headers.get("to") ?? "")).map((a) => a.address),
        cc: splitAddresses(decodeRfc2047(headers.get("cc") ?? "")).map((a) => a.address),
        subject: decodeRfc2047(headers.get("subject") ?? ""),
        text, htmlOnly,
        attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.buf?.length ?? 0 })),
      }, null, 2));
    } else {
      console.log("Uid: " + uid);
      console.log("From: " + (from ? (from.name ? from.name + " <" + from.address + ">" : from.address) : "(unknown)"));
      console.log("To: " + decodeRfc2047(headers.get("to") ?? ""));
      if (headers.get("cc")) console.log("Cc: " + decodeRfc2047(headers.get("cc")));
      console.log("Date: " + imapDateToIso(msg.internalDate));
      console.log("Subject: " + decodeRfc2047(headers.get("subject") ?? "(no subject)"));
      console.log("");
      console.log(text || "(no text body)");
      if (htmlOnly) console.log("(body was HTML; shown as plain text)");
      if (attachments.length) {
        console.log("");
        console.log("Attachments:");
        for (const a of attachments) console.log("  - " + a.filename + " (" + (a.buf?.length ?? 0) + " bytes, " + a.contentType + ")");
      }
    }
    if (typeof opts.atts === "string" && attachments.length) {
      const dir = opts.atts;
      fs.mkdirSync(dir, { recursive: true });
      for (const a of attachments) {
        const safe = a.filename.replace(/[\/\\\x00]/g, "_");
        fs.writeFileSync(path.join(dir, safe), a.buf ?? Buffer.alloc(0));
      }
      console.log("Attachments saved to: " + dir);
    }
    if (opts.peek !== true && !msg.flags.includes("\\Seen")) {
      await c.store(uid, "+", "\\Seen");
      if (opts.json !== true) console.log("(marked as read; use --peek to keep unread)");
    }
  });
}

async function cmdSend(opts: Record<string, string | boolean | string[]>): Promise<void> {
  const acct = resolveAccount();
  const to = optStrings(opts.to).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const cc = optStrings(opts.cc).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const bcc = optStrings(opts.bcc).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  if (!to.length) { console.error("error: send needs --to recipient@example.com"); process.exit(1); }
  checkAddresses(to, "to"); checkAddresses(cc, "cc"); checkAddresses(bcc, "bcc");
  const subject = typeof opts.subject === "string" ? opts.subject : "(no subject)";
  const body = readBodyInput(opts);
  if (!body.trim()) { console.error("error: empty body. Use --body \"text\", --body-file path, or pipe text via stdin."); process.exit(1); }
  const attachments = optStrings(opts.attach).map((p) => ({ filename: path.basename(p), content: fs.readFileSync(p), contentType: guessType(p) }));
  const msg = buildMessage({ name: typeof opts.name === "string" ? opts.name : "", address: acct.address }, to, cc, subject, body, attachments);
  await smtpSend(acct, msg, acct.address, [...bareAddresses(to), ...bareAddresses(cc), ...bareAddresses(bcc)]);
  console.log(`sent: to=${to.join(", ")}${cc.length ? " cc=" + cc.join(",") : ""} subject="${subject}"${attachments.length ? " attachments=" + attachments.length : ""}`);
}

async function cmdReply(opts: Record<string, string | boolean | string[]>, pos: string[]): Promise<void> {
  const uid = Number(pos[0]);
  if (!Number.isFinite(uid)) { console.error("error: reply needs a message id (see: check)"); process.exit(1); }
  const acct = resolveAccount();
  const body = readBodyInput(opts);
  if (!body.trim()) { console.error("error: empty body. Use --body \"text\", --body-file path, or pipe text via stdin."); process.exit(1); }
  await withImap(acct, async (c) => {
    const folder = await c.resolveFolder(typeof opts.folder === "string" ? opts.folder : "INBOX");
    await c.select(folder);
    const msg = await c.fetchFull(uid);
    if (!msg) { console.error("error: no message with id " + uid); process.exit(1); }
    const { headers } = parseMessage(msg.raw);
    const replyTo = splitAddresses(decodeRfc2047(headers.get("reply-to") ?? headers.get("from") ?? ""))[0];
    const toOverride = optStrings(opts.to).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    const to = toOverride.length ? toOverride : replyTo ? [replyTo.address] : [];
    if (!to.length) { console.error("error: no reply address found; pass --to"); process.exit(1); }
    const origSubj = decodeRfc2047(headers.get("subject") ?? "");
    const subject = typeof opts.subject === "string" ? opts.subject : (/^\s*(re|aw)\s*:/i.test(origSubj) ? origSubj : "Re: " + origSubj);
    const mid = headers.get("message-id") ?? "";
    const refs = ((headers.get("references") ?? "") + " " + mid).trim();
    const attachments = optStrings(opts.attach).map((p) => ({ filename: path.basename(p), content: fs.readFileSync(p), contentType: guessType(p) }));
    const m = buildMessage({ name: typeof opts.name === "string" ? opts.name : "", address: acct.address }, to, [], subject, body, attachments, {
      "In-Reply-To": mid, References: refs,
    });
    await smtpSend(acct, m, acct.address, bareAddresses(to));
    await c.store(uid, "+", "\\Answered");
    await c.store(uid, "+", "\\Seen");
    console.log(`replied to #${uid}: to=${to.join(", ")} subject="${subject}"`);
  });
}

async function cmdForward(opts: Record<string, string | boolean | string[]>, pos: string[]): Promise<void> {
  const uid = Number(pos[0]);
  if (!Number.isFinite(uid)) { console.error("error: forward needs a message id"); process.exit(1); }
  const acct = resolveAccount();
  const to = optStrings(opts.to).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  if (!to.length) { console.error("error: forward needs --to recipient@example.com"); process.exit(1); }
  await withImap(acct, async (c) => {
    const folder = await c.resolveFolder(typeof opts.folder === "string" ? opts.folder : "INBOX");
    await c.select(folder);
    const msg = await c.fetchFull(uid);
    if (!msg) { console.error("error: no message with id " + uid); process.exit(1); }
    const { headers, root } = parseMessage(msg.raw);
    const { text, attachments: origAtts } = pickText(root);
    const origFrom = decodeRfc2047(headers.get("from") ?? "");
    const origDate = headers.get("date") ?? imapDateToIso(msg.internalDate);
    const origSubj = decodeRfc2047(headers.get("subject") ?? "");
    const note = readBodyInput(opts);
    const fwdBlock = "---------- Forwarded message ----------\nFrom: " + origFrom + "\nDate: " + origDate + "\nSubject: " + origSubj + "\n\n" + text;
    const body = (note.trim() ? note.trim() + "\n\n" : "") + fwdBlock;
    const subject = (/^\s*(fwd|fw|tr)\s*:/i.test(origSubj) ? origSubj : "Fwd: " + origSubj);
    const attachments = origAtts.map((a) => ({ filename: a.filename, content: a.buf ?? Buffer.alloc(0), contentType: a.contentType }));
    const m = buildMessage({ name: typeof opts.name === "string" ? opts.name : "", address: acct.address }, to, [], subject, body, attachments);
    await smtpSend(acct, m, acct.address, bareAddresses(to));
    await c.store(uid, "+", "\\Seen");
    console.log(`forwarded #${uid}: to=${to.join(", ")} subject="${subject}"${attachments.length ? " attachments=" + attachments.length : ""}`);
  });
}

async function cmdSearch(opts: Record<string, string | boolean | string[]>, pos: string[]): Promise<void> {
  const acct = resolveAccount();
  const criteria = buildSearchCriteria(opts);
  if (!criteria) { console.error("error: search needs at least one of --from --to --subject --text --since --before"); process.exit(1); }
  await withImap(acct, async (c) => {
    const folder = await c.resolveFolder(typeof opts.folder === "string" ? opts.folder : "INBOX");
    await c.select(folder);
    const uids = (await c.uidSearch(criteria)).slice(-Number(opts.limit ?? 20));
    const hdrs = await c.fetchHeaders(uids);
    const rows = uids.slice().reverse().map((uid) => {
      const h = hdrs.get(uid);
      if (!h) return null;
      const { headers } = parseMessage(h.raw);
      const from = splitAddresses(decodeRfc2047(headers.get("from") ?? ""))[0];
      return {
        uid, unread: !h.flags.includes("\\Seen"),
        from: from ? (from.name ? from.name + " <" + from.address + ">" : from.address) : "(unknown)",
        subject: decodeRfc2047(headers.get("subject") ?? "(no subject)"),
        date: imapDateToIso(h.internalDate),
      };
    }).filter(Boolean);
    if (opts.json === true) console.log(JSON.stringify({ folder, criteria, count: rows.length, messages: rows }, null, 2));
    else {
      console.log(`folder=${folder} matches=${rows.length}`);
      for (const r of rows as any[]) console.log(`${r.unread ? "*" : " "} #${r.uid} | ${r.date} | ${r.from} | ${r.subject}`);
      if (!(rows as any[]).length) console.log("(no matches)");
    }
  });
}

async function cmdMark(opts: Record<string, string | boolean | string[]>, pos: string[]): Promise<void> {
  const action = pos[1];
  const acct = resolveAccount();
  await withImap(acct, async (c) => {
    const folder = await c.resolveFolder(typeof opts.folder === "string" ? opts.folder : "INBOX");
    await c.select(folder);
    const rangeParts = String(pos[0] ?? "").split(",");
    const uids: number[] = [];
    for (const p of rangeParts) {
      const m = p.match(/^(\d+)-(\d+)$/);
      if (m) { for (let i = Number(m[1]); i <= Number(m[2]); i++) uids.push(i); }
      else if (Number.isFinite(Number(p))) uids.push(Number(p));
    }
    if (!uids.length || !action) { console.error("error: mark needs <id|from-to> and an action: read | unread | star | unstar | delete | archive"); process.exit(1); }
    const flags: Record<string, [string, "+" | "-"]> = {
      read: ["\\Seen", "+"], unread: ["\\Seen", "-"], star: ["\\Flagged", "+"], unstar: ["\\Flagged", "-"],
      delete: ["\\Deleted", "+"], archive: ["", "+"],
    };
    const act = flags[action];
    if (!act) { console.error("error: unknown action '" + action + "'. Use: read | unread | star | unstar | delete | archive"); process.exit(1); }
    if (action === "archive") {
      const folders = await c.listFolders();
      const target =
        folders.find((f) => f.attrs.some((a) => a === "\\Archive")) ??
        folders.find((f) => /(^|\/)(archive|all mail)$/i.test(f.name) && f.name.toUpperCase() !== "INBOX");
      if (!target) { console.error("error: no Archive folder found on this account; use folders to list, then move manually is not supported yet."); process.exit(1); }
      for (const uid of uids) await c.moveTo(uid, target.name);
      console.log(`archived ${uids.length} message(s) from ${folder} to ${target.name}`);
      return;
    }
    for (const uid of uids) await c.store(uid, act[1], act[0]);
    if (action === "delete") await c.expunge();
    console.log(`${action}: ${uids.length} message(s) in ${folder} (ids ${uids[0]}${uids.length > 1 ? ".." + uids[uids.length - 1] : ""})`);
  });
}

async function cmdFolders(opts: Record<string, string | boolean | string[]>): Promise<void> {
  const acct = resolveAccount();
  await withImap(acct, async (c) => {
    const folders = await c.listFolders();
    if (opts.json === true) console.log(JSON.stringify({ folders }, null, 2));
    else for (const f of folders) console.log((f.attrs.find((a) => a.startsWith("\\")) ?? "").padEnd(12) + " " + f.name);
  });
}

async function cmdAccounts(opts: Record<string, string | boolean | string[]>): Promise<void> {
  const stored = loadAccounts();
  const legacy = (() => {
    const cfg = loadConfig();
    const addr = vaultGet(cfg, "email-address") || cfgGet(cfg, "email-address");
    return addr ? { provider: cfgGet(cfg, "provider") || "gmail", email: addr } : null;
  })();
  if (opts.json === true) {
    console.log(JSON.stringify({ accounts: stored.accounts.map(({ password, ...rest }) => ({ ...rest, hasPassword: !!password })), defaultId: stored.defaultId, legacy }, null, 2));
    return;
  }
  for (const a of stored.accounts) {
    console.log(`${a.id === stored.defaultId ? "*" : " "} ${a.id} | ${a.label} | ${a.provider} | ${a.email}`);
  }
  if (legacy) console.log(`  (settings) | single-account mode from plugin settings | ${legacy.provider} | ${legacy.email}`);
  if (!stored.accounts.length && !legacy) console.log("(no accounts configured — add one on the Email dashboard tab)");
}

// ---------- main ----------

const USAGE = `email-bridge CLI — IMAP/SMTP for the connected accounts

Usage: ob-plugin-email-bridge-email [--account ID|label|email] <command> [options]

Commands:
  accounts [--json]                                    list configured accounts (Email dashboard tab manages them)
  check [--folder F] [--limit N] [--all] [--json]      list unread messages (summary)
  read <id> [--folder F] [--peek] [--atts DIR] [--json]   full message; marks read unless --peek; --atts saves attachments
  send --to A[,B] [--cc X] [--bcc Y] [--subject S] [--body T | --body-file F] [--attach P]... [--name N]
  reply <id> [--body T | --body-file F] [--attach P]... [--to override]
  forward <id> --to A[,B] [--note T]
  search --from X | --to X | --subject X | --text X | --since 7d | --before 2026-01-01 [--folder F] [--limit N]
  mark <id|from-to> read|unread|star|unstar|delete|archive [--folder F]
  folders [--json]

--account picks an account when several are configured (default account otherwise).
Body can also be piped: echo "hello" | ... send --to a@b.c --subject Hi
Dates accept YYYY-MM-DD or Nd (days ago). Ids are the message ids shown by check/read.
`;

async function main() {
  const rawArgv = process.argv.slice(2);
  const argv2: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    const a = rawArgv[i];
    if (a === "--account" && i + 1 < rawArgv.length) { ACCT_FLAG = rawArgv[++i]; continue; }
    if (a.startsWith("--account=")) { ACCT_FLAG = a.slice(10); continue; }
    argv2.push(a);
  }
  const [cmd, ...rest] = argv2;
  const { opts, pos } = parseArgs(rest);
  if (!cmd || cmd.startsWith("-") || opts.help === true) { console.log(USAGE); return; }
  switch (cmd) {
    case "accounts": return cmdAccounts(opts);
    case "check": return cmdCheck(opts, pos);
    case "read": return cmdRead(opts, pos);
    case "send": return cmdSend(opts);
    case "reply": return cmdReply(opts, pos);
    case "forward": return cmdForward(opts, pos);
    case "search": return cmdSearch(opts, pos);
    case "mark": return cmdMark(opts, pos);
    case "folders": return cmdFolders(opts);
    default:
      console.error("error: unknown command '" + cmd + "'\n" + USAGE);
      process.exit(1);
  }
}

main().catch((e: any) => {
  console.error("error: " + (e?.message ?? String(e)));
  process.exit(1);
});
