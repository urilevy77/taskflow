import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderResolver, hostLabel, portalLabel } from "../../src/lib/core/job-source.mjs";

test("portalLabel maps scan portals to display names", () => {
  assert.equal(portalLabel("greenhouse-api"), "Greenhouse");
  assert.equal(portalLabel("gsheet-csv-api"), "Google Sheet");
  assert.equal(portalLabel("ashby-full"), "Ashby");
  assert.equal(portalLabel("newthing-api"), "Newthing");
  assert.equal(portalLabel(""), "");
});

test("hostLabel recognises ATS hosts, else the bare domain", () => {
  assert.equal(hostLabel("https://job-boards.greenhouse.io/x/jobs/1"), "Greenhouse");
  assert.equal(hostLabel("https://www.acme.com/careers/1"), "acme.com");
  assert.equal(hostLabel("not a url"), "");
});

test("provider precedence: WhatsApp > scan portal > host; matches despite tracking params", () => {
  const pipelineMd = "- [x] https://jobs.lever.co/acme/1?utm_source=wa |  | Job lead (WhatsApp) | lane: il-source\n";
  const historyTsv =
    "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n" +
    "https://job-boards.greenhouse.io/x/jobs/1\t2026-09-18\tgreenhouse-api\tEng\tX\tadded\n";
  const of = buildProviderResolver({ pipelineMd, historyTsv });
  assert.equal(of("https://jobs.lever.co/acme/1"), "WhatsApp");
  assert.equal(of("https://job-boards.greenhouse.io/x/jobs/1/"), "Greenhouse");
  assert.equal(of("https://www.acme.com/careers/1"), "acme.com");
  assert.equal(of(""), "");
});
