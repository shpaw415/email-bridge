#!/usr/bin/env bun
// email-bridge test mock: IMAP (implicit TLS + STARTTLS) and SMTP (implicit TLS + STARTTLS).
// Usage: bun tests/mock.ts --store PATH [--imap PORT] [--imap-starttls PORT] [--smtp PORT] [--smtp-starttls PORT]
//        [--user U] [--pass P] [--capture DIR] [--no-move] [--bad-pass]
import * as fs from "node:fs";
import * as path from "node:path";
import * as tls from "node:tls";
import * as net from "node:net";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
const flag = (name: string) => process.argv.includes("--" + name);

const STORE = arg("store")!;
const USER = arg("user", "test@localhost")!;
const PASS = arg("pass", "testpass")!;
const CAPTURE = arg("capture");
const NO_MOVE = flag("no-move");
const BAD_PASS = flag("bad-pass");

const IMAP_TLS_PORT = Number(arg("imap", "10993"));
const IMAP_STARTTLS_PORT = Number(arg("imap-starttls", "10143"));
const SMTP_TLS_PORT = Number(arg("smtp", "10465"));
const SMTP_STARTTLS_PORT = Number(arg("smtp-starttls", "10587"));

// self-signed context (client runs with insecure=true)
const { privateKey, certificate } = (() => {
  if (fs.existsSync("/tmp/opencode/email-bridge-test/key.pem")) {
    return { privateKey: fs.readFileSync("/tmp/opencode/email-bridge-test/key.pem", "utf8"), certificate: fs.readFileSync("/tmp/opencode/email-bridge-test/cert.pem", "utf8") };
  }
  throw new Error("missing /tmp/opencode/email-bridge-test/key.pem — run tests/gen-cert.sh first");
})();
const ctx = tls.createSecureContext({ key: privateKey, cert: certificate });

type Msg = { uid: number; flags: string[]; internalDate: string; raw: string };
type Store = { folders: Record<string, Msg[]>; nextUid: number };
let store: Store = JSON.parse(fs.readFileSync(STORE, "utf8"));
const save = () => fs.writeFileSync(STORE, JSON.stringify(store, null, 1));

// ---------- IMAP session ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function folderNames(): string[] {
  return Object.keys(store.folders);
}

class ImapSession {
  sock: net.Socket | tls.TLSSocket;
  buf = "";
  current: string | null = null;
  tagN = 0;

  constructor(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => this.onData(d));
    sock.on("error", () => {});
    this.write("* OK email-bridge mock IMAP ready\r\n");
  }

  write(s: string) { try { this.sock.write(s); } catch { /* closed */ } }

  onData(d: Buffer) {
    this.buf += d.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\r\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.handle(line);
    }
  }

  starttls() {
    const plain = this.sock as net.Socket;
    plain.removeAllListeners("data");
    const upgraded = new tls.TLSSocket(plain, { isServer: true, secureContext: ctx });
    this.sock = upgraded;
    upgraded.on("data", (d: Buffer) => this.onData(d));
    upgraded.on("error", () => {});
    upgraded.setEncoding(undefined as any);
  }

  handle(line: string) {
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m) { this.write("* BAD empty\r\n"); return; }
    const [, tag, rest] = m;
    const cmd = rest.split(" ")[0].toUpperCase();
    const args = rest.slice(cmd.length).trim();
    const ok = (s: string) => this.write(`${tag} OK ${s}\r\n`);
    const no = (s: string) => this.write(`${tag} NO ${s}\r\n`);

    switch (cmd) {
      case "STARTTLS":
        this.write(`${tag} OK Begin TLS\r\n`);
        setTimeout(() => this.starttls(), 30);
        return;
      case "LOGIN": {
        const mm = args.match(/^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/) ?? args.match(/^(\S+)\s+(\S+)$/);
        const u = mm ? unquote(mm[1]) : "";
        const p = mm ? unquote(mm[2]) : "";
        if (u === USER && (BAD_PASS ? p !== PASS : p === PASS)) ok("LOGIN completed");
        else { no("[AUTHENTICATIONFAILED] Invalid credentials"); try { this.sock.end(); } catch { /* */ } }
        return;
      }
      case "ENABLE":
        this.write("* ENABLED UTF8=ACCEPT\r\n"); ok("ENABLE completed"); return;
      case "LIST": {
        for (const f of folderNames()) this.write(`* LIST (\\HasNoChildren) "/" ${quote(f)}\r\n`);
        // archive marker on Archive folder
        ok("LIST completed"); return;
      }
      case "SELECT": {
        const name = unquote(args.trim());
        const folder = store.folders[name];
        if (!folder) { no("No such folder"); return; }
        this.current = name;
        this.write(`* ${folder.length} EXISTS\r\n`);
        this.write("* OK [UIDVALIDITY 1] UIDs valid\r\n");
        this.write(`* OK [UIDNEXT ${store.nextUid}] Predicted next UID\r\n`);
        ok("[READ-WRITE] SELECT completed");
        return;
      }
      case "UID": {
        const sub = args.split(" ")[0].toUpperCase();
        const rest2 = args.slice(sub.length).trim();
        if (sub === "SEARCH") return this.uidSearch(tag, rest2, ok);
        if (sub === "FETCH") return this.uidFetch(tag, rest2, ok, no);
        if (sub === "STORE") return this.uidStore(tag, rest2, ok, no);
        if (sub === "COPY") return this.uidCopy(tag, rest2, ok, no);
        if (sub === "MOVE") return this.uidMove(tag, rest2, ok, no);
        no("Unknown UID command"); return;
      }
      case "EXPUNGE": {
        const f = store.folders[this.current ?? ""] ?? [];
        store.folders[this.current!] = f.filter((x) => !x.flags.includes("\\Deleted"));
        save();
        ok("EXPUNGE completed"); return;
      }
      case "CAPABILITY":
        this.write("* CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN MOVE\r\n"); ok("CAPABILITY completed"); return;
      case "NOOP": ok("NOOP completed"); return;
      case "LOGOUT":
        this.write("* BYE mock closing\r\n"); ok("LOGOUT completed"); setTimeout(() => { try { this.sock.end(); } catch { /* */ } }, 30); return;
      default:
        no(`Unknown command ${cmd}`); return;
    }
  }

  uidSearch(tag: string, crit: string, ok: (s: string) => void) {
    const f = store.folders[this.current ?? ""] ?? [];
    const toks = tokenize(crit);
    let uids = f.filter((x) => !x.flags.includes("\\Deleted"));
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i].toUpperCase();
      if (t === "ALL") continue;
      if (t === "UNSEEN") { uids = uids.filter((x) => !x.flags.includes("\\Seen")); continue; }
      if (t === "ANSWERED") { uids = uids.filter((x) => x.flags.includes("\\Answered")); continue; }
      if (t === "FROM" || t === "TO" || t === "SUBJECT" || t === "TEXT") {
        const val = toks[++i] ?? "";
        uids = uids.filter((x) => {
          const hay = t === "TEXT" ? x.raw.toLowerCase() : headerOf(x.raw, t).toLowerCase();
          return hay.includes(val.toLowerCase());
        });
        continue;
      }
      if (t === "SINCE" || t === "BEFORE") {
        const dv = toks[++i] ?? "";
        uids = uids.filter((x) => cmpDate(x.internalDate, dv, t === "SINCE"));
        continue;
      }
    }
    const list = uids.map((x) => x.uid).join(" ");
    this.write(`* SEARCH ${list}\r\n`);
    ok("SEARCH completed");
  }

  uidFetch(tag: string, rest: string, ok: (s: string) => void, no: (s: string) => void) {
    const f = store.folders[this.current ?? ""] ?? [];
    const setTok = rest.split(/\s+/)[0];
    const want = parseSet(setTok, f.map((x) => x.uid));
    for (const uid of want) {
      const msg = f.find((x) => x.uid === uid);
      if (!msg) continue;
      const rawBuf = Buffer.from(msg.raw, "utf8");
      this.write(
        `* ${f.indexOf(msg) + 1} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(" ")}) INTERNALDATE "${msg.internalDate}" BODY[] {${rawBuf.length}}\r\n`
      );
      this.write(rawBuf.toString("latin1"));
      this.write(")\r\n");
    }
    ok("FETCH completed");
  }

  uidStore(tag: string, rest: string, ok: (s: string) => void, no: (s: string) => void) {
    const f = store.folders[this.current ?? ""] ?? [];
    const [setTok, opTok, flagsTok] = rest.split(/\s+/);
    const op = opTok.startsWith("+") ? "+" : opTok.startsWith("-") ? "-" : "=";
    const flags = (flagsTok ?? "").replace(/[()]/g, "").split(/\s+/).filter(Boolean);
    for (const uid of parseSet(setTok, f.map((x) => x.uid))) {
      const msg = f.find((x) => x.uid === uid);
      if (!msg) continue;
      if (op === "+") for (const fl of flags) if (!msg.flags.includes(fl)) msg.flags.push(fl);
      if (op === "-") msg.flags = msg.flags.filter((x) => !flags.includes(x));
      if (op === "=") msg.flags = [...flags];
    }
    save();
    ok("Store completed");
  }

  uidCopy(tag: string, rest: string, ok: (s: string) => void, no: (s: string) => void) {
    const [setTok, dest] = [rest.split(/\s+/)[0], unquote(rest.split(/\s+/).slice(1).join(" "))];
    const f = store.folders[this.current ?? ""] ?? [];
    const d = store.folders[dest];
    if (!d) { no("[TRYCREATE] No such folder"); return; }
    for (const uid of parseSet(setTok, f.map((x) => x.uid))) {
      const msg = f.find((x) => x.uid === uid);
      if (!msg) continue;
      d.push({ ...msg, uid: store.nextUid++, flags: msg.flags.filter((x) => x !== "\\Deleted") });
    }
    save();
    ok("Copy completed");
  }

  uidMove(tag: string, rest: string, ok: (s: string) => void, no: (s: string) => void) {
    if (NO_MOVE) { no("MOVE not supported"); return; }
    const [setTok, dest] = [rest.split(/\s+/)[0], unquote(rest.split(/\s+/).slice(1).join(" "))];
    const f = store.folders[this.current ?? ""] ?? [];
    const d = store.folders[dest];
    if (!d) { no("[TRYCREATE] No such folder"); return; }
    for (const uid of parseSet(setTok, f.map((x) => x.uid))) {
      const idx = f.findIndex((x) => x.uid === uid);
      if (idx < 0) continue;
      const [msg] = f.splice(idx, 1);
      d.push({ ...msg, uid: store.nextUid++ });
    }
    save();
    ok("Move completed");
  }
}

function tokenize(crit: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (const ch of crit) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === " " && !inQ) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, "$1");
  return t;
}

function quote(s: string): string {
  return s.includes(" ") || /[\\"]/.test(s) ? '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : s;
}

function headerOf(raw: string, field: string): string {
  const idx = raw.search(/\r?\n\r?\n/);
  const headers = idx >= 0 ? raw.slice(0, idx) : raw;
  const lines = headers.split(/\r?\n(?=[^\s])/);
  const fld = field.toLowerCase();
  for (const l of lines) {
    const c = l.indexOf(":");
    if (c > 0 && l.slice(0, c).trim().toLowerCase() === fld) return l.slice(c + 1).replace(/\r?\n\s+/g, " ");
  }
  return "";
}

function cmpDate(internalDate: string, imapDate: string, since: boolean): boolean {
  const m = internalDate.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  const d2 = imapDate.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m || !d2) return false;
  const a = new Date(`${m[2]} ${m[1]} ${m[3]}`).getTime();
  const b = new Date(`${d2[2]} ${d2[1]} ${d2[3]}`).getTime();
  return since ? a >= b : a < b;
}

function parseSet(tok: string, all: number[]): number[] {
  const out: number[] = [];
  for (const part of tok.split(",")) {
    const m = part.match(/^(\d+):(\d+)$/);
    if (m) { for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i); }
    else if (part === "*") out.push(Math.max(...all, 0));
    else if (Number.isFinite(Number(part))) out.push(Number(part));
  }
  return out;
}

// ---------- SMTP session ----------

let captured = 0;
class SmtpSession {
  sock: net.Socket | tls.TLSSocket;
  buf = "";
  from = "";
  rcpts: string[] = [];
  inData = false;
  dataBuf = "";
  authStage: "" | "user" | "pass" = "";

  constructor(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => this.onData(d));
    sock.on("error", () => {});
    this.write("220 email-bridge mock SMTP ready\r\n");
  }

  write(s: string) { try { this.sock.write(s); } catch { /* closed */ } }

  onData(d: Buffer) {
    this.buf += d.toString("utf8");
    this.drain();
  }

  drain() {
    let i: number;
    while ((i = this.buf.indexOf("\r\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (this.inData) {
        if (line === ".") {
          this.inData = false;
          const body = this.dataBuf.replace(/(^|\r\n)\.\./g, "$1.");
          this.capture(body);
          this.write("250 OK message accepted\r\n");
        } else this.dataBuf += line + "\r\n";
        continue;
      }
      this.handle(line);
    }
  }

  starttls() {
    const plain = this.sock as net.Socket;
    plain.removeAllListeners("data");
    const upgraded = new tls.TLSSocket(plain, { isServer: true, secureContext: ctx });
    this.sock = upgraded;
    upgraded.on("data", (d: Buffer) => this.onData(d));
    upgraded.on("error", () => {});
  }

  handle(line: string) {
    if (this.authStage) {
      const stage = this.authStage;
      this.authStage = "";
      const val = Buffer.from(line.trim(), "base64").toString("utf8");
      const good = stage === "user" ? val === USER : BAD_PASS ? val !== PASS : val === PASS;
      if (!good) { this.write("535 Authentication failed\r\n"); return; }
      if (stage === "user") { this.authStage = "pass"; this.write("334 UGFzc3dvcmQ6\r\n"); }
      else this.write("235 2.7.0 Authentication successful\r\n");
      return;
    }
    const cmd = line.split(" ")[0].toUpperCase();
    if (cmd === "EHLO" || cmd === "HELO") {
      this.write("250-mock greets you\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n"); return;
    }
    if (cmd === "STARTTLS") { this.write("220 Ready to start TLS\r\n"); setTimeout(() => this.starttls(), 30); return; }
    if (cmd === "AUTH") {
      if (!/AUTH LOGIN/i.test(line)) { this.write("504 Unrecognized auth\r\n"); return; }
      this.authStage = "user";
      this.write("334 VXNlcm5hbWU6\r\n"); return;
    }
    if (cmd === "MAIL") { this.from = (line.match(/<([^>]*)>/) ?? [, ""])[1]; this.write("250 OK\r\n"); return; }
    if (cmd === "RCPT") { this.rcpts.push((line.match(/<([^>]*)>/) ?? [, ""])[1]); this.write("250 OK\r\n"); return; }
    if (cmd === "DATA") { this.inData = true; this.dataBuf = ""; this.write("354 End data with <CR><LF>.<CR><LF>\r\n"); return; }
    if (cmd === "QUIT") { this.write("221 Bye\r\n"); setTimeout(() => { try { this.sock.end(); } catch { /* */ } }, 30); return; }
    if (cmd === "NOOP") { this.write("250 OK\r\n"); return; }
    this.write("500 Unknown command\r\n");
  }

  capture(body: string) {
    captured++;
    if (!CAPTURE) return;
    fs.mkdirSync(CAPTURE, { recursive: true });
    fs.writeFileSync(path.join(CAPTURE, `msg-${captured}.eml`), body);
    fs.writeFileSync(path.join(CAPTURE, `msg-${captured}.json`), JSON.stringify({ from: this.from, rcpts: this.rcpts }, null, 1));
    this.rcpts = []; this.from = "";
  }
}

// ---------- listeners ----------

tls.createServer({ key: privateKey, cert: certificate }, (s) => new ImapSession(s)).listen(IMAP_TLS_PORT, "127.0.0.1");
net.createServer((s) => new ImapSession(s)).listen(IMAP_STARTTLS_PORT, "127.0.0.1");
tls.createServer({ key: privateKey, cert: certificate }, (s) => new SmtpSession(s)).listen(SMTP_TLS_PORT, "127.0.0.1");
net.createServer((s) => new SmtpSession(s)).listen(SMTP_STARTTLS_PORT, "127.0.0.1");
console.log(`mock up: imap-tls :${IMAP_TLS_PORT} imap-starttls :${IMAP_STARTTLS_PORT} smtp-tls :${SMTP_TLS_PORT} smtp-starttls :${SMTP_STARTTLS_PORT}`);
