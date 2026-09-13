#!/usr/bin/env node
// Reads the Worker's /poll response on stdin and decides whether the run
// succeeded.
//
// This lives in its own file rather than inline in the workflow for two
// reasons: embedding a script inside a YAML block scalar is a well-known way
// to produce an unparseable workflow through indentation alone, and a separate
// file can be tested without pushing anything.

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    console.log(`::error::Worker did not return JSON. First 200 chars: ${raw.slice(0, 200)}`);
    process.exit(1);
  }

  // A 200 carrying ok:false is still a failure. An expired token, a revoked
  // permission and a healthy poll all look identical at the HTTP layer, which
  // is exactly how a collector dies quietly for a day.
  if (!r.ok) {
    console.log(`::error::Poll failed: ${r.note || JSON.stringify(r)}`);
    process.exit(1);
  }

  console.log(`polled ${r.polled ?? "?"} reels, ${r.changed ?? 0} values changed`);
});
