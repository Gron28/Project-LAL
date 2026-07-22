import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobRepository, runFakeCheckpointableJob } from "./jobs.ts";

function fixture(options: { diskCapacityBytes?: number; cpuSlots?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-jobs-")); let now = 0;
  return { root, repo: new JobRepository({ databasePath: path.join(root, "state", "jobs.sqlite"), now: () => ++now, ...options }) };
}
function add(repo: JobRepository, id: string, resources = {}, restartPolicy: "resume" | "none" = "resume") { return repo.create({ id, kind: "fake.checkpointable", requestedBy: "local-user", capabilityScope: ["jobs.run"], resources, restartPolicy, inputs: [], retentionClass: "test" }); }

test("ledger recovers a checkpointable job and releases stale GPU leases", (t) => {
  const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true})); add(f.repo,"resume",{gpu:"exclusive",diskBytes:8}); assert.equal(f.repo.start("resume").started,true); f.repo.checkpoint("resume",{offset:3},{phase:"download",completed:3,total:10});
  const restarted=new JobRepository({databasePath:path.join(f.root,"state","jobs.sqlite")}); assert.deepEqual(restarted.recover(),{queued:["resume"],interrupted:[]}); assert.deepEqual(restarted.get("resume")?.checkpoint,{offset:3}); assert.equal(restarted.start("resume").started,true);
});
test("nonrecoverable jobs settle interrupted", (t) => { const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true})); add(f.repo,"no-resume",{},"none"); f.repo.start("no-resume"); assert.deepEqual(f.repo.recover(),{queued:[],interrupted:["no-resume"]}); assert.equal(f.repo.get("no-resume")?.state,"interrupted"); });
test("kind-scoped recovery leaves unrelated active jobs untouched", (t) => { const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true})); add(f.repo,"unrelated",{},"none"); f.repo.create({ id:"download",kind:"model.download",requestedBy:"local-user",capabilityScope:["model.download"],resources:{},restartPolicy:"none",inputs:[],retentionClass:"test" }); f.repo.start("unrelated"); f.repo.start("download"); assert.deepEqual(f.repo.recover("model.download"),{queued:[],interrupted:["download"]}); assert.equal(f.repo.get("unrelated")?.state,"running"); });
test("GPU and disk reservations deny overlap before work starts", (t) => { const f=fixture({diskCapacityBytes:10,cpuSlots:2}); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true})); add(f.repo,"gpu-a",{gpu:"exclusive",diskBytes:7}); add(f.repo,"gpu-b",{gpu:"exclusive",diskBytes:7}); assert.equal(f.repo.start("gpu-a").started,true); assert.deepEqual(f.repo.start("gpu-b"),{started:false,reason:"gpu_busy"}); f.repo.fail("gpu-a",{code:"test",message:"release",retryable:true}); assert.equal(f.repo.start("gpu-b").started,true); add(f.repo,"disk",{diskBytes:4}); assert.deepEqual(f.repo.start("disk"),{started:false,reason:"disk_insufficient"}); });
test("checkpointable runner honors cancel and cannot claim unverified success", (t) => { const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true})); add(f.repo,"cancel",{gpu:"exclusive"}); assert.equal(runFakeCheckpointableJob(f.repo,"cancel",3,(n)=>{if(n===2)f.repo.requestCancel("cancel");}).state,"cancelled"); add(f.repo,"verify"); f.repo.start("verify"); assert.throws(()=>f.repo.succeed("verify",[]),/verified output/); assert.equal(f.repo.get("verify")?.state,"running"); });
