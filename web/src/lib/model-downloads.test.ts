import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobRepository } from "./jobs.ts";
import { executeModelDownload } from "./model-downloads.ts";
import { resolveModelAcquisition, VerifiedModelImportStore, type OfflineCatalog } from "./model-acquisition.ts";

test("model download job exposes a verified external GGUF to every local selector root", async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"lal-model-job-")); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); const bytes=Buffer.from("GGUFexample"), sha=crypto.createHash("sha256").update(bytes).digest("hex");
  const catalog:OfflineCatalog={ protocolVersion:1,generatedAt:"2026-07-19T00:00:00.000Z",providers:{huggingface:"available",ollama:"unconfigured"},models:[{provider:"huggingface",id:"lal/demo",revision:"abc",displayName:"Demo",license:{name:"Apache",requiresAcceptance:true,redistributable:true},files:[{path:"demo.gguf",sizeBytes:bytes.length,sha256:sha}],capabilities:[]}] };
  const resolved=resolveModelAcquisition(catalog,{provider:"huggingface",id:"lal/demo",acceptedLicense:true},{availableDiskBytes:999999,availableRamBytes:999999}); assert.equal(resolved.state,"ready"); if(resolved.state!=="ready") return;
  const jobs=new JobRepository({databasePath:path.join(root,"jobs.sqlite"),diskCapacityBytes:999999}); const job=jobs.create({id:"download-1",kind:"model.download",requestedBy:"test",capabilityScope:["model.download"],resources:{network:true,diskBytes:resolved.plan.requiredDiskBytes},restartPolicy:"resume",inputs:[],retentionClass:"test"});
  const result=await executeModelDownload({repository:jobs,jobId:job.id,request:{plan:resolved.plan,modelName:"demo",requestedBy:"test"},store:new VerifiedModelImportStore(path.join(root,"imports")),modelDirectory:path.join(root,"models"),availableDiskBytes:999999,fetchImpl:async()=>new Response(bytes),refreshRegistry:async()=>undefined});
  assert.equal(result.job.state,"succeeded"); assert.equal(fs.readFileSync(path.join(root,"models","demo-q4.gguf")).subarray(0,4).toString(),"GGUF");
});
