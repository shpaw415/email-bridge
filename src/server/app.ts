const PRESETS = {
  "gmail": {
    "imap": [
      "imap.gmail.com",
      993
    ],
    "smtp": [
      "smtp.gmail.com",
      465
    ],
    "smtpMode": "ssl"
  },
  "yahoo": {
    "imap": [
      "imap.mail.yahoo.com",
      993
    ],
    "smtp": [
      "smtp.mail.yahoo.com",
      465
    ],
    "smtpMode": "ssl"
  },
  "outlook": {
    "imap": [
      "outlook.office365.com",
      993
    ],
    "smtp": [
      "smtp-mail.outlook.com",
      587
    ],
    "smtpMode": "starttls"
  },
  "custom": {
    "imap": [
      "",
      993
    ],
    "smtp": [
      "",
      465
    ],
    "smtpMode": "ssl"
  }
};
const I18N = {
  fr: {
    sub: "Comptes connectés pour l'agent — lis, envoie, réponds, archive. Les commandes CLI acceptent --account.",
    addTitle: "Ajouter un compte", toggle: "＋ Ajouter", edit: "Modifier", cancel: "Annuler", save: "Enregistrer",
    label: "Nom du compte", provider: "Fournisseur", email: "Adresse courriel", password: "Mot de passe d'application (pas le mot de passe du compte)",
    keepPassword: "Laisser vide pour conserver le mot de passe actuel", passwordNew: "Mot de passe d'application",
    custom: "Serveurs personnalisés (fournisseur custom seulement)", insecure: "Accepter les certificats TLS auto-signés",
    makeDefault: "sera le compte par défaut", test: "Tester", def: "Défaut", setDef: "Rendre par défaut", del: "Supprimer", editBtn: "Modifier",
    confirmDel: "Supprimer ce compte ?", errorApi: "API en échec :", legacyTitle: "Compte des réglages (mono-compte, lecture seule)",
    legacyHint: "Défini dans les réglages du plugin. Ajoute des comptes ici pour passer en multi-comptes.",
    testing: "test…", noAccounts: "Aucun compte. Ajoute ton premier compte pour commencer.",
  },
  en: {
    sub: "Accounts connected for the agent — read, send, reply, archive. CLI commands accept --account.",
    addTitle: "Add an account", toggle: "＋ Add", edit: "Edit", cancel: "Cancel", save: "Save",
    label: "Account name", provider: "Provider", email: "Email address", password: "App password (not the account password)",
    keepPassword: "Leave empty to keep the current password", passwordNew: "App password",
    custom: "Custom servers (custom provider only)", insecure: "Accept self-signed TLS certificates",
    makeDefault: "will be the default account", test: "Test", def: "Default", setDef: "Make default", del: "Delete", editBtn: "Edit",
    confirmDel: "Delete this account?", errorApi: "API failure:", legacyTitle: "Settings account (single-account, read-only)",
    legacyHint: "Defined in the plugin settings. Add accounts here to switch to multi-account.",
    testing: "testing…", noAccounts: "No accounts yet. Add your first account to start.",
  }
};
const t = I18N[(navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en"];
const $ = (id) => document.getElementById(id);
let editing = null;
let hadAccounts = false;

$("sub").textContent = t.sub;
$("addTitle").textContent = t.addTitle;
$("toggleForm").textContent = t.toggle;
$("cancelBtn").textContent = t.cancel;
$("saveBtn").textContent = t.save;
$("l-label").textContent = t.label;
$("l-provider").textContent = t.provider;
$("l-email").textContent = t.email;
$("l-password").textContent = t.passwordNew;
$("l-custom").textContent = t.custom;
$("l-insecure").textContent = t.insecure;
$("hintDefault").textContent = t.makeDefault;
for (const p of Object.keys(PRESETS)) $("f-provider").appendChild(new Option(p, p));
$("f-provider").value = "gmail";
$("customBox").style.display = "none";
$("f-provider").onchange = () => { $("customBox").style.display = $("f-provider").value === "custom" ? "block" : "none"; };

function banner(msg, kind) { const b = $("banner"); b.textContent = msg; b.className = "banner " + kind; b.style.display = "block"; }
function clearBanner() { $("banner").style.display = "none"; }

async function api(path, opts) {
  const r = await fetch("api/" + path, opts && { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({ error: "invalid API response" }));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}

async function refresh() {
  clearBanner();
  let data;
  try { data = await api("accounts"); }
  catch (e) { banner(t.errorApi + " " + e.message, "error"); $("list").innerHTML = ""; return; }
  const list = $("list");
  list.innerHTML = "";
  if (!data.accounts.length && !data.legacy) {
    const d = document.createElement("div"); d.className = "card muted"; d.textContent = t.noAccounts; list.appendChild(d);
  }
  hadAccounts = data.accounts.length > 0;
  if (data.legacy && !data.accounts.length) {
    const d = document.createElement("div"); d.className = "card legacy";
    d.innerHTML = '<div class="row"><div class="grow"><span class="label"></span> <span class="mail"></span></div><span class="badge"></span></div><div class="muted" style="margin-top:6px"></div>';
    d.querySelector(".label").textContent = t.legacyTitle;
    d.querySelector(".mail").textContent = data.legacy.email;
    d.querySelector(".badge").textContent = data.legacy.provider;
    d.querySelector(".muted").textContent = t.legacyHint;
    list.appendChild(d);
  }
  for (const a of data.accounts) {
    const card = document.createElement("div"); card.className = "card";
    card.innerHTML = '<div class="row"><div class="grow"><span class="label"></span> <span class="mail"></span></div>' +
      '<span class="badge prov"></span><span class="badge dflt"></span></div>' +
      '<div class="actions"><button class="small btest"></button><button class="small bdef"></button><button class="small bedit"></button><button class="small danger bdel"></button></div>' +
      '<div class="testout"></div>';
    card.querySelector(".label").textContent = a.label;
    card.querySelector(".mail").textContent = a.email;
    card.querySelector(".prov").textContent = a.provider;
    const dflt = card.querySelector(".dflt");
    if (a.id === data.defaultId) { dflt.textContent = "★ " + t.def; dflt.className = "badge default"; }
    else dflt.remove();
    const bt = card.querySelector(".btest"); bt.textContent = t.test;
    bt.onclick = async () => {
      const out = card.querySelector(".testout");
      out.style.display = "block"; out.textContent = t.testing;
      try { const r = await api("accounts/" + a.id + "/test", { method: "POST" });
        out.textContent = r.output || (r.ok ? "ok" : "failed");
        out.style.borderColor = r.ok ? "var(--ok-text)" : "var(--err-text)";
      } catch (e) { out.textContent = e.message; out.style.borderColor = "var(--err-text)"; }
    };
    const bd = card.querySelector(".bdef");
    if (a.id !== data.defaultId) {
      bd.textContent = t.setDef;
      bd.onclick = async () => { try { await api("accounts/" + a.id + "/default", { method: "POST" }); refresh(); } catch (e) { banner(e.message, "error"); } };
    } else bd.remove();
    card.querySelector(".bedit").textContent = t.editBtn;
    card.querySelector(".bedit").onclick = () => openForm(a);
    const bx = card.querySelector(".bdel"); bx.textContent = t.del;
    bx.onclick = async () => {
      if (!confirm(t.confirmDel + " (" + a.email + ")")) return;
      try { await api("accounts/" + a.id, { method: "DELETE" }); refresh(); } catch (e) { banner(e.message, "error"); }
    };
    list.appendChild(card);
  }
}

function openForm(a) {
  editing = a ? a.id : null;
  $("form").classList.add("open");
  $("addTitle").textContent = a ? t.edit : t.addTitle;
  $("l-password").textContent = a ? t.keepPassword : t.passwordNew;
  $("f-label").value = a ? a.label : "";
  $("f-provider").value = a ? a.provider : "gmail";
  $("f-email").value = a ? a.email : "";
  $("f-password").value = "";
  $("f-provider").onchange();
  $("f-imapHost").value = a ? a.imapHost : PRESETS["gmail"].imap[0];
  $("f-imapPort").value = a ? a.imapPort : PRESETS["gmail"].imap[1];
  $("f-smtpHost").value = a ? a.smtpHost : PRESETS["gmail"].smtp[0];
  $("f-smtpPort").value = a ? a.smtpPort : PRESETS["gmail"].smtp[1];
  $("f-imapMode").value = a ? a.imapMode : "auto";
  $("f-smtpMode").value = a ? a.smtpMode : "auto";
  $("f-insecure").checked = a ? !!a.insecure : false;
  $("f-provider").onchange = () => {
    const p = $("f-provider").value;
    $("customBox").style.display = p === "custom" ? "block" : "none";
    if (!editing && p !== "custom") {
      $("f-imapHost").value = PRESETS[p].imap[0]; $("f-imapPort").value = PRESETS[p].imap[1];
      $("f-smtpHost").value = PRESETS[p].smtp[0]; $("f-smtpPort").value = PRESETS[p].smtp[1];
      $("f-smtpMode").value = p === "outlook" ? "starttls" : "ssl";
    }
  };
  $("f-email").focus();
}

$("toggleForm").onclick = () => { if ($("form").classList.contains("open")) { $("form").classList.remove("open"); editing = null; } else openForm(null); };
$("cancelBtn").onclick = () => { $("form").classList.remove("open"); editing = null; };
$("saveBtn").onclick = async () => {
  const body = {
    label: $("f-label").value, provider: $("f-provider").value, email: $("f-email").value,
    password: $("f-password").value,
    imapHost: $("f-imapHost").value, imapPort: Number($("f-imapPort").value) || 0,
    smtpHost: $("f-smtpHost").value, smtpPort: Number($("f-smtpPort").value) || 0,
    imapMode: $("f-imapMode").value, smtpMode: $("f-smtpMode").value,
    insecure: $("f-insecure").checked,
    makeDefault: !editing && !hadAccounts,
  };
  try {
    if (editing) await api("accounts/" + editing, { method: "PUT", body: JSON.stringify(body) });
    else await api("accounts", { method: "POST", body: JSON.stringify(body) });
    $("form").classList.remove("open"); editing = null; refresh();
  } catch (e) { banner(e.message, "error"); }
};

refresh();
