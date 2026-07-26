import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LineageEvaluationRepository } from "./lineage-evaluations.ts";

const hash = "a".repeat(64);
function fixture() { const root=fs.mkdtempSync(path.join(os.tmpdir(),"lal-lineage-evaluation-")); let now=1_000; return { root,repo:new LineageEvaluationRepository({ databasePath:path.join(root,"state.sqlite"),now:()=>now++ }) }; }
function suite(repo: LineageEvaluationRepository) { return repo.createSuite({ name:"smoke",version:"1",datasetId:"dataset:sha256:source",datasetRevision:"r1",datasetSha256:hash,license:"MIT",scorer:{ id:"scorer:exact",revision:"r1" },split:"smoke",seeds:[7],repeats:1,warmup:{ runs:1,discard:0 },capabilityDomain:"tool-use",minimumRuntime:{ context:1024 },cases:[{ name:"first",promptTemplateSha256:hash,datasetRevision:"r1" },{ name:"second",promptTemplateSha256:"b".repeat(64),datasetRevision:"r1" }] }); }

test("lineage records stable entities, immutable dataset manifests, and queryable relationships", (t) => {
  const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  f.repo.recordEntity({ id:"artifact:sha256:base",kind:"artifact",digest:hash,metadata:{ source:"local" },retentionClass:"lineage" });
  const dataset=f.repo.createDatasetManifest({ sourceArtifactIds:["artifact:sha256:base"],rowIds:["row-1","row-2"],byteSha256:"b".repeat(64),schemaVersion:"v1",license:"CC-BY-4.0",intendedRole:"coding",transformations:[{ name:"normalize",version:"1" }] });
  assert.match(dataset.id,/^dataset:sha256:[a-f0-9]{64}$/); assert.equal(f.repo.getDatasetManifest(dataset.id)?.rowCount,2); assert.equal(f.repo.relationsFor(dataset.id)[0]?.toId,"artifact:sha256:base");
  assert.throws(()=>f.repo.recordEntity({ id:"artifact:sha256:base",kind:"model",metadata:{},retentionClass:"lineage" }),/immutable lineage entity conflict/);
});

test("suite cases are content-addressed and runs bind exact runtime evidence with raw outcomes", (t) => {
  const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true})); const created=suite(f.repo);
  const run=f.repo.startRun({ id:"eval-run:one",suiteId:created.id,artifactId:"artifact:sha256:model",runtimeId:"runtime:sha256:runtime",chatTemplateSha256:hash,hostFingerprintSha256:"c".repeat(64),softwareRevision:"git:abcd",environmentRevision:"lock:abcd",decoding:{ temperature:0 },seed:7,repeat:1 }); assert.equal(run.state,"running");
  const completed=f.repo.finishRun(run.id,created.cases.map((item,index)=>({ caseId:item.id,outcome:index ? "fail" : "pass",rawOutput:`raw-${index}`,scorerOutput:{ score:index ? 0 : 1 },metrics:{ latencyMs:10+index } })));
  assert.equal(completed.summary?.passRate,.5); assert.equal(completed.summary?.meanLatencyMs,10.5); assert.equal(completed.results[0]?.rawOutput,"raw-0"); assert.throws(()=>f.repo.finishRun(run.id,[]),/only running/);
});

test("comparison preserves separate case outcomes and rejects partial result evidence", (t) => {
  const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true})); const created=suite(f.repo); const input={ suiteId:created.id,artifactId:"artifact:sha256:model",runtimeId:"runtime:sha256:runtime",chatTemplateSha256:hash,hostFingerprintSha256:"c".repeat(64),softwareRevision:"git:abcd",environmentRevision:"lock:abcd",decoding:{},seed:7,repeat:1 };
  const incomplete=f.repo.startRun({ ...input,id:"eval-run:partial" }); assert.throws(()=>f.repo.finishRun(incomplete.id,[{ caseId:created.cases[0]!.id,outcome:"pass",rawOutput:"x",scorerOutput:{} }]),/cover every immutable suite case/);
  const full=f.repo.startRun({ ...input,id:"eval-run:full" }); f.repo.finishRun(full.id,created.cases.map((item)=>({ caseId:item.id,outcome:"pass",rawOutput:"x",scorerOutput:{} })));
  assert.equal(f.repo.compareRuns([full.id]).caseOutcomes[created.cases[0]!.id]?.[full.id],"pass");
});
