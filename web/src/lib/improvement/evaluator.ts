import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CampaignEvaluationInput, RolePack } from "./contracts.ts";
import { pairedScore, type PairedOutcome } from "./scoring.ts";

export type ToolUseCase = {
  id: string;
  roleId: string | "workflow" | "regression";
  taskFamily: string;
  prompt: string;
  fixtureSha256: string;
  tools: { name: string; schema: Record<string, unknown> }[];
  deterministicChecks: { code: string; expected: unknown }[];
  subjective?: boolean;
};
export type HiddenSuite = { id: string; revision: string; cases: ToolUseCase[] };
export type EvaluationVariant = { id: "base" | "candidate" | "reference"; artifactId: string; artifactSha256: string; roleAdapters?: CampaignEvaluationInput["candidateSet"] };
export type ExecutionSettings = { seed: number; temperature: number; topP: number; maxTokens: number; runtimeRevision: string; chatTemplateSha256: string };
export type ExecutionEvidence = { rawOutput: string; toolTrace: unknown[]; artifacts: { id: string; sha256: string }[]; deterministic: { code: string; passed: boolean; detail: string }[]; unauthorizedActions: number; falseCompletion: boolean; latencyMs: number; peakMemoryBytes: number; tokens: number; modelCalls: number; energyProxy: number };
export interface ModelExecutor { execute(variant:EvaluationVariant,testCase:ToolUseCase,settings:ExecutionSettings):Promise<ExecutionEvidence>; }
export interface BlindJudge { id:string; judge(input:{caseId:string;left:string;right:string;checks:ToolUseCase["deterministicChecks"]}):Promise<"left"|"right"|"tie">; }

const parse=<T>(value:unknown):T=>JSON.parse(String(value)) as T;
export class HiddenSuiteVault {
  private readonly db:DatabaseSync;
  constructor(databasePath:string){if(!path.isAbsolute(databasePath))throw new Error("hidden suite databasePath must be absolute");fs.mkdirSync(path.dirname(databasePath),{recursive:true,mode:0o700});this.db=new DatabaseSync(databasePath);this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS hidden_suites (id TEXT PRIMARY KEY,revision TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hidden_evidence (run_id TEXT NOT NULL,case_id TEXT NOT NULL,variant TEXT NOT NULL,seed INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,case_id,variant,seed));`);}
  put(suite:HiddenSuite,pack:RolePack):void{if(!suite.id||!suite.revision)throw new Error("hidden suite identity is required");const families=new Map<string,Set<string>>();for(const item of suite.cases){if(!item.id||!item.taskFamily||!item.prompt||!item.fixtureSha256.match(/^[a-f0-9]{64}$/))throw new Error("hidden case lineage is incomplete");(families.get(item.roleId)??families.set(item.roleId,new Set()).get(item.roleId)!).add(item.taskFamily);}for(const role of pack.roles)if(suite.cases.filter((item)=>item.roleId===role.id).length<30)throw new Error(`hidden suite needs at least 30 cases for ${role.id}`);if(suite.cases.filter((item)=>item.roleId==="workflow").length<30)throw new Error("hidden suite needs at least 30 workflow cases");if(new Set(suite.cases.map((item)=>item.id)).size!==suite.cases.length)throw new Error("hidden case ids must be unique");this.db.prepare("INSERT INTO hidden_suites VALUES (?,?,?) ON CONFLICT(id) DO NOTHING").run(suite.id,suite.revision,JSON.stringify(suite));const existing=this.db.prepare("SELECT revision,body FROM hidden_suites WHERE id=?").get(suite.id) as {revision:string;body:string};if(existing.revision!==suite.revision||existing.body!==JSON.stringify(suite))throw new Error("hidden suite records are immutable");}
  get(id:string):HiddenSuite|null{const row=this.db.prepare("SELECT body FROM hidden_suites WHERE id=?").get(id) as {body:string}|undefined;return row?parse(row.body):null;}
  record(runId:string,caseId:string,variant:string,seed:number,evidence:ExecutionEvidence){this.db.prepare("INSERT INTO hidden_evidence VALUES (?,?,?,?,?)").run(runId,caseId,variant,seed,JSON.stringify(evidence));}
  evidence(runId:string){return this.db.prepare("SELECT case_id,variant,seed,body FROM hidden_evidence WHERE run_id=? ORDER BY case_id,variant,seed").all(runId).map((row)=>({caseId:String(row.case_id),variant:String(row.variant),seed:Number(row.seed),evidence:parse<ExecutionEvidence>(row.body)}));}
}

function deterministicPass(evidence:ExecutionEvidence):boolean{return evidence.deterministic.length>0&&evidence.deterministic.every((check)=>check.passed);}
function blindOrder(runId:string,caseId:string,judgeId:string):boolean{return crypto.createHash("sha256").update(`${runId}:${caseId}:${judgeId}`).digest()[0]!%2===0;}
export async function runBlindCampaignEvaluation(input:{campaignId:string;pack:RolePack;suite:HiddenSuite;vault:HiddenSuiteVault;executor:ModelExecutor;variants:{base:EvaluationVariant;candidate:EvaluationVariant;reference:EvaluationVariant};judges:[BlindJudge,BlindJudge];settings:Omit<ExecutionSettings,"seed">;seeds:[number,number];coreRegressionPoints:number;schemaContractsPassed:boolean;toolContractsPassed:boolean}):Promise<CampaignEvaluationInput>{
  if(input.judges[0].id===input.judges[1].id)throw new Error("subjective evaluation requires two independent judges");
  const forbidden=new Set(Object.values(input.variants).flatMap((variant)=>[variant.id,variant.artifactId]));if(input.judges.some((judge)=>forbidden.has(judge.id)))throw new Error("candidate, base, and reference may not judge their own evaluation");
  const runId=`hidden-${crypto.createHash("sha256").update(`${input.campaignId}:${input.suite.revision}`).digest("hex").slice(0,24)}`;
  const byCase=new Map<string,Record<string,ExecutionEvidence[]>>();let disagreements=0,unresolved=0;
  for(const testCase of input.suite.cases){const variants:Record<string,ExecutionEvidence[]>={base:[],candidate:[],reference:[]};for(const seed of input.seeds){for(const variant of Object.values(input.variants)){const evidence=await input.executor.execute(variant,testCase,{...input.settings,seed});input.vault.record(runId,testCase.id,variant.id,seed,evidence);variants[variant.id]!.push(evidence);}}byCase.set(testCase.id,variants);if(testCase.subjective){const candidate=variants.candidate.map((value)=>value.rawOutput).join("\n"),reference=variants.reference.map((value)=>value.rawOutput).join("\n");const decisions=[];for(const judge of input.judges){const normal=blindOrder(runId,testCase.id,judge.id);const decision=await judge.judge({caseId:testCase.id,left:normal?candidate:reference,right:normal?reference:candidate,checks:testCase.deterministicChecks});decisions.push(decision==="tie"?"tie":normal?decision:decision==="left"?"right":"left");}if(decisions[0]!==decisions[1])disagreements++;if(decisions.includes("tie")||decisions[0]!==decisions[1])unresolved++;}}
  const outcomes=(cases:ToolUseCase[]):PairedOutcome[]=>cases.flatMap((testCase)=>{const variants=byCase.get(testCase.id)!;return input.seeds.map((_,index)=>({candidate:deterministicPass(variants.candidate![index]!),base:deterministicPass(variants.base![index]!),reference:deterministicPass(variants.reference![index]!)}));});
  const roleScores=Object.fromEntries(input.pack.roles.map((role)=>[role.id,pairedScore(outcomes(input.suite.cases.filter((item)=>item.roleId===role.id)))]));
  const workflowScore=pairedScore(outcomes(input.suite.cases.filter((item)=>item.roleId==="workflow")));
  const all=[...byCase.values()].flatMap((variants)=>Object.values(variants).flat()),candidate=[...byCase.values()].flatMap((variants)=>variants.candidate),reference=[...byCase.values()].flatMap((variants)=>variants.reference);
  const sum=(values:ExecutionEvidence[],key:"latencyMs"|"tokens"|"modelCalls"|"energyProxy")=>values.reduce((total,value)=>total+value[key],0);
  return {campaignId:input.campaignId,suiteRevision:input.suite.revision,candidateSet:input.variants.candidate.roleAdapters??{},baseSha256:input.variants.base.artifactSha256,referenceSha256:input.variants.reference.artifactSha256,roleScores,workflowScore,coreRegressionPoints:input.coreRegressionPoints,schemaContractsPassed:input.schemaContractsPassed,toolContractsPassed:input.toolContractsPassed,unauthorizedActions:candidate.reduce((sum,value)=>sum+value.unauthorizedActions,0),falseCompletions:candidate.filter((value)=>value.falseCompletion).length,peakMemoryBytes:{candidate:Math.max(0,...candidate.map((value)=>value.peakMemoryBytes)),reference:Math.max(0,...reference.map((value)=>value.peakMemoryBytes))},pareto:{latencyMs:sum(candidate,"latencyMs"),energyProxy:sum(candidate,"energyProxy"),tokens:sum(candidate,"tokens"),modelCalls:sum(candidate,"modelCalls")},judgeDisagreements:disagreements,unresolvedReviews:unresolved,evidenceIds:all.flatMap((value)=>value.artifacts.map((artifact)=>artifact.id))};
}

export function developmentReport(evidence:{candidateId:string;aggregates:Record<string,number>;failureCategories:string[];rawOutputs?:unknown;hidden?:unknown}[]){return evidence.map(({candidateId,aggregates,failureCategories})=>({candidateId,aggregates,failureCategories}));}
