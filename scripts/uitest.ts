// happy-dom harness: runs the FROZEN bundle (marketplace artifact) against the
// live page server. Read-only assertions + theme checks. Prints PASS/FAIL lines.
import { Window } from "happy-dom";
import * as fs from "node:fs";

const PORT = process.env.UI_PORT || "4751";
const TOKEN = process.env.UI_TOKEN || "";
const bundle = fs.readFileSync("/tmp/opencode/eb-bundle/index.html", "utf8");
let fails = 0;
const check = (ok: boolean, label: string) => { console.log((ok ? "PASS " : "FAIL ") + label); if (!ok) fails++; };

async function runWindow(theme: string) {
  const win = new Window({ url: `http://127.0.0.1:${PORT}/?theme=${theme}` });
  const realFetch = win.fetch.bind(win);
  Object.defineProperty(win.navigator, "language", { value: "fr-CA", configurable: true });
  (win as unknown as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).startsWith("api/") ? `http://127.0.0.1:${PORT}/${String(input)}` : String(input);
    const plain: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { plain[k] = v; });
    if (TOKEN) plain["x-open-bot-page-token"] = TOKEN;
    return realFetch(url, { ...init, headers: plain });
  }) as typeof fetch;
  win.document.write(bundle);
  // Execute inline scripts in document order (theme script in head, app in body).
  const scripts = [...win.document.querySelectorAll("script")].filter((s) => !s.getAttribute("src"));
  const doc = win.document;
  const OptionCtor = function (this: unknown, t?: string, v?: string) {
    const o = doc.createElement("option");
    o.text = t ?? ""; o.value = v ?? "";
    return o;
  } as unknown as new (t?: string, v?: string) => HTMLOptionElement;
  for (const s of scripts) new Function("window", "document", "navigator", "fetch", "confirm", "Option", "with(window){" + s.textContent + "}")(win, win.document, win.navigator, win.fetch, () => true, OptionCtor);
  await new Promise((r) => setTimeout(r, 1200));
  return win;
}

// Theme: ?theme=dark
const wDark = await runWindow("dark");
check(wDark.document.documentElement.getAttribute("data-theme") === "dark", "?theme=dark → html[data-theme=dark]");

// Theme: ?theme=light
const wLight = await runWindow("light");
check(wLight.document.documentElement.getAttribute("data-theme") !== "dark", "?theme=light → no dark attr");

// i18n FR applied (navigator fr-CA), no custom theme toggle control in the page
const sub = wLight.document.getElementById("sub")?.textContent || "";
check(sub.includes("Comptes connectés"), "i18n FR applied to #sub");
check(!wDark.document.querySelector("[id*=theme], .theme-toggle"), "no custom theme toggle");

// List rendered from the live API (read-only): 3 configured accounts → 3 cards + count badges
const cards = wLight.document.querySelectorAll("#list .card");
check(cards.length === 3, `account cards rendered from API (got ${cards.length}, want 3)`);
const badges = wLight.document.querySelectorAll("#list .badge.default");
check(badges.length === 1, "exactly one default badge");
const btns = wLight.document.querySelectorAll("#list .btest");
check(btns.length === 3, "test button on each card");
// Form opens with provider options from inlined PRESETS
(wLight.document.getElementById("toggleForm") as HTMLElement).click();
await new Promise((r) => setTimeout(r, 300));
const opts = wLight.document.querySelectorAll("#f-provider option");
check(opts.length === 4, `provider select populated from PRESETS (got ${opts.length}, want 4)`);
check(wLight.document.getElementById("form")?.classList.contains("open") === true, "add-account form opens");

process.exit(fails ? 1 : 0);
