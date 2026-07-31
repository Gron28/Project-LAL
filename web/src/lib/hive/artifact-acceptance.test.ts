import assert from "node:assert/strict";
import test from "node:test";
import { staticHtmlAcceptance } from "./artifact-acceptance.ts";

test("static HTML acceptance rejects a missing referenced element", () => {
  const report = staticHtmlAcceptance("index.html", "<html><body><script>document.getElementById('missing').onclick=()=>{}</script></body></html>");
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.code === "element-references")?.passed, false);
});

test("static HTML acceptance accepts a self-contained wired document", () => {
  const report = staticHtmlAcceptance("index.html", "<html><body><button id='go'>Go</button><script>document.getElementById('go').onclick=()=>{ document.body.dataset.ok='1' }</script></body></html>");
  assert.equal(report.passed, true);
});
