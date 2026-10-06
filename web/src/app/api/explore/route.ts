import { NextRequest } from "next/server";
import fs from "node:fs";
import { runDiscovery } from "@/lib/core/scan";
import { annotateKnown, loadKnownIndex } from "@/lib/core/known-jobs";
import { rootScript } from "@/lib/career-ops";
import { parseExplorePatch, DEFAULT_FILTERS, type DiscoveredOffer, type ScanEvent } from "@/lib/explore";
import { scannerMissingBody, SCANNER_MISSING_STATUS } from "@/lib/explore-error.mjs";

// Discovery is HTTP-bound across many ATS boards; give it room. It is FREE —
// zero LLM tokens (the scanner only does HTTP + JSON, and --dry-run writes nothing).
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty body → defaults */
  }

  const filters = parseExplorePatch(body, DEFAULT_FILTERS);

  // Guard: a data-only checkout (or pre-onboarding) has no scanner. Fail soft.
  // The body carries an explicit code because 400 is a shared channel: the
  // client cannot tell this apart from a malformed request by status alone.
  if (!fs.existsSync(rootScript("scan-ats-full"))) {
    return Response.json(scannerMissingBody(), { status: SCANNER_MISSING_STATUS });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* stream closed */
        }
      };
      send({ kind: "start", ats: filters.ats, sinceDays: filters.sinceDays, limit: filters.limitPerAts, free: true } satisfies ScanEvent);
      let offers: DiscoveredOffer[] = [];
      try {
        // Snapshot what we already have ONCE, then tag every offer as it streams out.
        // A failure here must never cost the user their scan — fall back to untagged.
        const known = await loadKnownIndex().catch(() => null);
        offers = await runDiscovery(filters, (e: ScanEvent) =>
          send(known && e.kind === "offer" ? { ...e, offer: annotateKnown(known, [e.offer])[0] } : e),
        );
        if (known) offers = annotateKnown(known, offers);
      } catch (err) {
        send({ kind: "error", message: err instanceof Error ? err.message : "discovery failed" } satisfies ScanEvent);
      }
      send({ kind: "done", count: offers.length, offers, cost: { tokens: 0, usd: 0 } } satisfies ScanEvent);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
