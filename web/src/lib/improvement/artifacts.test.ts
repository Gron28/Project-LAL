import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeCampaignAdapterManifest } from "./artifacts.ts";
const h=(char:string)=>char.repeat(64);
test("campaign adapter manifests pin full lineage and are immutable",(t)=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"lal-adapter-manifest-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,"candidate.hive-adapter.json"),adapterPath=path.join(root,"adapter.gguf");fs.writeFileSync(adapterPath,"adapter");const adapterHash=crypto.createHash("sha256").update("adapter").digest("hex"),base={id:"adapter:one",campaignId:"campaign:one",rolePack:{id:"core-tool-use-v1",version:"1.0.0"},roleId:"core.verifier",base:{checkpointId:"Qwen/Qwen3.5-4B",checkpointSha256:h("a"),runtimeId:"qwen3.5-4b-stock",runtimeSha256:h("b"),tokenizerSha256:h("c"),chatTemplateSha256:h("d")},adapter:{path:adapterPath,sha256:adapterHash,bytes:7},candidateId:"candidate:one",trialId:"trial:one",datasetManifestIds:["dataset:one"],trainerRevision:"trainer-1"};const first=writeCampaignAdapterManifest(file,base);assert.equal(first.schemaVersion,2);assert.equal(writeCampaignAdapterManifest(file,base).manifestSha256,first.manifestSha256);assert.throws(()=>writeCampaignAdapterManifest(file,{...base,trialId:"trial:two"}),/overwrite/);fs.writeFileSync(adapterPath,"drift");assert.throws(()=>writeCampaignAdapterManifest(path.join(root,"drift.json"),base),/bytes/);});
