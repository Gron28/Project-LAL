import assert from "node:assert/strict";
import test from "node:test";
import { inspectHuggingFaceModel, searchHuggingFaceModels } from "./huggingface-catalog.ts";

test("search and inspect retain an exact commit and LFS byte digest", async () => {
  const commit="a".repeat(40), digest="b".repeat(64); let calls=0, searchUrl="";
  const fetchMock=async (url:string)=>{ calls++; if(url.includes("search=")) { searchUrl=url; return Response.json([{id:"org/demo-GGUF",sha:commit,cardData:{license:"apache-2.0"}}]); } if(url.includes("/tree/")) return Response.json([{path:"demo-q4.gguf",size:42,lfs:{oid:digest,size:42}},{path:"README.md",size:1}]); return Response.json({cardData:{license:"apache-2.0"}}); };
  assert.deepEqual(await searchHuggingFaceModels("demo",fetchMock),[{id:"org/demo-GGUF",revision:commit,licenseName:"apache-2.0"}]);
  assert.match(searchUrl, /search=demo%20gguf&limit=20&full=true$/);
  const model=await inspectHuggingFaceModel("org/demo-GGUF",commit,fetchMock); assert.equal(model.files[0]?.sha256,digest); assert.equal(model.files[0]?.sizeBytes,42); assert.equal(calls,3);
});
