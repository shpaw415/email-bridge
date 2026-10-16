#!/usr/bin/env bun
// Seeds the mock mailstore used by tests/mock.ts.
import * as fs from "node:fs";

const OUT = process.argv[2] ?? "/tmp/opencode/email-bridge-test/mailstore.json";

const b64w = (s: string) => (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
const encB = (s: string) => "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";

const pdfContent = b64w("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

const m1 = [
  "From: Bob Tremblay <bob@example.com>",
  "To: test@localhost",
  "Subject: Old seen message",
  "Date: Tue, 13 Oct 2026 09:15:00 +0000",
  "Message-ID: <old-1@example.com>",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64w("Message vu la semaine passée. Rien à faire."),
].join("\r\n");

const m2 = [
  `From: ${encB("Alicia Café")} <alice@exemple.fr>`,
  "To: test@localhost",
  `Subject: ${encB("Réunion projet — compte-rendu")}`,
  "Date: Thu, 15 Oct 2026 08:30:00 +0000",
  "Message-ID: <reunion-2@exemple.fr>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="alt-42"',
  "",
  "--alt-42",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64w("Bonjour,\n\nVoici le compte-rendu de la réunion de ce matin.\n\nAlicia"),
  "--alt-42",
  "Content-Type: text/html; charset=UTF-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64w("<html><body><p>Bonjour,</p><p>Voici le <b>compte-rendu</b> de la réunion.</p></body></html>"),
  "--alt-42--",
  "",
].join("\r\n");

const m3 = [
  "From: Comptabilite Exemple <compta@exemple.example>",
  "To: test@localhost",
  "Subject: Facture octobre",
  "Date: Thu, 15 Oct 2026 11:00:00 +0000",
  "Message-ID: <facture-3@exemple.example>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="mix-7"',
  "",
  "--mix-7",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Bonjour,\r\n\r\nCi-joint la facture du mois. Caf=C3=A9 offert par la direction.\r\n\r\nCompta",
  "--mix-7",
  'Content-Type: application/pdf; name="facture-octobre.pdf"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="facture-octobre.pdf"',
  "",
  pdfContent,
  "--mix-7--",
  "",
].join("\r\n");

const m4 = [
  "From: newsletter@shop.example",
  "To: test@localhost",
  "Subject: Soldes d'automne",
  "Date: Mon, 06 Oct 2026 16:45:00 +0000",
  "Message-ID: <solde-4@shop.example>",
  "Content-Type: text/html; charset=UTF-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64w("<html><body><p>Soldes <b>50%</b> cette semaine.</p><script>track()</script><p>&Agrave; tr&Agrave;s bient&Atilde;&acute;t</p></body></html>"),
].join("\r\n");

const store = {
  nextUid: 5,
  folders: {
    INBOX: [
      { uid: 1, flags: ["\\Seen"], internalDate: "13-Oct-2026 09:15:00 +0000", raw: m1 },
      { uid: 2, flags: [], internalDate: "15-Oct-2026 08:30:00 +0000", raw: m2 },
      { uid: 3, flags: [], internalDate: "15-Oct-2026 11:00:00 +0000", raw: m3 },
      { uid: 4, flags: [], internalDate: "06-Oct-2026 16:45:00 +0000", raw: m4 },
    ],
    Archive: [],
    "Sent Messages": [],
  },
};

fs.mkdirSync(OUT.split("/").slice(0, -1).join("/"), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
console.log("seeded " + OUT);
