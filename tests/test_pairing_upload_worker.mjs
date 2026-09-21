import assert from "node:assert/strict";
import { copyFile, unlink } from "node:fs/promises";

const source = new URL("../worker/worker.js", import.meta.url);
const temp = "/tmp/catet-pairing-upload-worker-test.mjs";
await copyFile(source, temp);
const { default: worker } = await import("file://" + temp + "?v=" + Date.now());

const sprint = { id: 77, state: "active", name: "Sprint 77" };
const existingDoc = {
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Existing QA notes" }] }],
};
let linked = false;
let mentioned = false;
let linkPosts = 0;
let descriptionPuts = 0;
let postedPayload = null;
let descriptionPayload = null;
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/rest/api/3/field")) {
    return new Response(JSON.stringify([
      { id: "customfield_10020", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
    ]), { status: 200 });
  }
  if (u.includes("/rest/api/3/issue/QA-101") && (init.method || "GET") === "PUT") {
    descriptionPuts++;
    descriptionPayload = JSON.parse(init.body);
    mentioned = true;
    return new Response(null, { status: 204 });
  }
  if (u.includes("/rest/api/3/issue/QA-101?")) {
    return new Response(JSON.stringify({
      key: "QA-101",
      fields: {
        customfield_10020: [sprint],
        issuelinks: linked ? [{ outwardIssue: { key: "DEV-201" } }] : [],
        description: mentioned
          ? {
            type: "doc",
            version: 1,
            content: [
              ...existingDoc.content,
              {
                type: "paragraph",
                content: [{
                  type: "inlineCard",
                  attrs: { url: "https://jira.test/browse/DEV-201" },
                }],
              },
            ],
          }
          : existingDoc,
      },
    }), { status: 200 });
  }
  if (u.includes("/rest/api/3/issue/DEV-201?")) {
    return new Response(JSON.stringify({
      key: "DEV-201",
      fields: { customfield_10020: [sprint], issuelinks: [], description: null },
    }), { status: 200 });
  }
  if (u.endsWith("/rest/api/3/issueLinkType")) {
    return new Response(JSON.stringify({
      issueLinkTypes: [
        { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
        { id: "10003", name: "Relates", inward: "relates to", outward: "relates to" },
      ],
    }), { status: 200 });
  }
  if (u.endsWith("/rest/api/3/issueLink") && init.method === "POST") {
    linkPosts++;
    postedPayload = JSON.parse(init.body);
    linked = true;
    return new Response(null, { status: 201 });
  }
  throw new Error("unexpected Jira call: " + u + " " + JSON.stringify(init));
};

const env = {
  JIRA_SITE: "https://jira.test",
  JIRA_EMAIL: "qa@example.test",
  JIRA_API_TOKEN: "secret",
};
const req = (body) => new Request("https://worker.test/pairing-link", {
  method: "POST",
  headers: { Origin: "https://zackyantoleo.github.io", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

try {
  const invalid = await worker.fetch(req({ qaKey: "qa-101", devKey: "DEV-201" }), env);
  assert.equal(invalid.status, 400, "malformed Jira keys must be rejected before any Jira mutation");

  const first = await worker.fetch(req({ qaKey: "QA-101", devKey: "DEV-201" }), env);
  assert.equal(first.status, 200);
  assert.deepStrictEqual(await first.json(), {
    ok: true,
    linked: true,
    alreadyLinked: false,
    mentioned: true,
    alreadyMentioned: false,
    verified: true,
    qaKey: "QA-101",
    devKey: "DEV-201",
    linkType: "Relates",
  });
  assert.equal(linkPosts, 1, "explicit click must produce exactly one Jira write");
  assert.deepStrictEqual(postedPayload, {
    type: { id: "10003" },
    outwardIssue: { key: "QA-101" },
    inwardIssue: { key: "DEV-201" },
  }, "Jira payload must use the safe symmetric Relates link type");
  assert.equal(descriptionPuts, 1, "explicit click must also write the QA description once");
  const putDesc = descriptionPayload && descriptionPayload.fields && descriptionPayload.fields.description;
  assert.equal(putDesc && putDesc.type, "doc");
  const putRaw = JSON.stringify(putDesc);
  assert.match(putRaw, /Existing QA notes/, "existing description content must be preserved");
  assert.match(putRaw, /"type":"inlineCard"/, "paired dev ticket must be a Jira issue chip/button");
  assert.match(putRaw, /https:\/\/jira\.test\/browse\/DEV-201/, "chip must point at the paired dev ticket");

  const second = await worker.fetch(req({ qaKey: "QA-101", devKey: "DEV-201" }), env);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.alreadyLinked, true, "repeated upload must be idempotent");
  assert.equal(secondBody.alreadyMentioned, true, "existing description chip must not be rewritten");
  assert.equal(secondBody.verified, true);
  assert.equal(linkPosts, 1, "idempotent retry must not create a duplicate Jira link");
  assert.equal(descriptionPuts, 1, "idempotent retry must not rewrite the description");

  mentioned = false;
  const describeOnly = await worker.fetch(req({ qaKey: "QA-101", devKey: "DEV-201" }), env);
  assert.equal(describeOnly.status, 200);
  const describeBody = await describeOnly.json();
  assert.equal(describeBody.alreadyLinked, true);
  assert.equal(describeBody.alreadyMentioned, false);
  assert.equal(describeBody.mentioned, true);
  assert.equal(linkPosts, 1, "description backfill must not create another Relates link");
  assert.equal(descriptionPuts, 2, "already-linked pair still posts the missing description chip");

  linked = false;
  mentioned = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/rest/api/3/issue/DEV-201?")) {
      return new Response(JSON.stringify({
        key: "DEV-201",
        fields: { customfield_10020: [{ id: 88, state: "active" }], issuelinks: [] },
      }), { status: 200 });
    }
    return originalFetch(url, init);
  };
  const crossSprint = await worker.fetch(req({ qaKey: "QA-101", devKey: "DEV-201" }), env);
  assert.equal(crossSprint.status, 409, "tickets from different active sprints must not be linked");
  assert.equal(linkPosts, 1);
  assert.equal(descriptionPuts, 2, "cross-sprint pairs must not write the description");

  console.log(JSON.stringify({ ok: true, linkPosts, descriptionPuts }));
} finally {
  globalThis.fetch = realFetch;
  await unlink(temp).catch(() => {});
}
