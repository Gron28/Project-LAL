import type { CampaignBudget, CandidateRecipeInput, TrialResult } from "./contracts.ts";
import { validateResearchProposal, type ExperimentProposal } from "./compatibility.ts";

const objectives = ["sft","sft_replay","sft_kl"] as const;
export function canonicalRecipes(campaignId:string,roleId:string,trainerRevision:string,seed=17):CandidateRecipeInput[]{
  return objectives.map((objective,index)=>({campaignId,roleId,objective,rank:16,alpha:32,dropout:.05,targets:objective==="sft"?"attention":"attention_mlp",learningRate:.0001,warmupRatio:.05,schedule:"cosine",retentionPercent:objective==="sft"?10:20,...(objective==="sft_kl"?{klCoefficient:.05 as const}:{}),seed:seed+index,budgetFraction:.25,hypothesis:`Canonical ${objective} baseline`,trainerRevision}));
}
export function continuationIds(results:TrialResult[],fraction:.5|1):string[]{
  const eligible=results.filter((result)=>result.status==="succeeded"&&result.telemetry.finiteGradients).sort((a,b)=>developmentScore(b)-developmentScore(a)||a.candidateId.localeCompare(b.candidateId));
  const divisor=fraction===.5?2:4;
  return eligible.slice(0,Math.max(1,Math.ceil(eligible.length/divisor))).map((result)=>result.candidateId);
}
export function developmentScore(result:TrialResult):number{
  const values=Object.values(result.development); if(!values.length)return -Infinity;
  const regression=Math.max(0,...Object.values(result.regressions));
  return values.reduce((a,b)=>a+b,0)/values.length-regression;
}
export function budgetStop(budget:CampaignBudget,results:TrialResult[]):{stop:boolean;reason?:string}{
  if(results.length>=budget.maxTrials)return {stop:true,reason:"trial_budget"};
  if(results.reduce((sum,result)=>sum+result.resources.gpuSeconds,0)>=budget.maxGpuHours*3600)return {stop:true,reason:"gpu_hour_budget"};
  if(results.some((result)=>result.resources.scratchBytes>budget.scratchBytes))return {stop:true,reason:"scratch_budget"};
  if(budget.plateauTrials&&results.length>=budget.plateauTrials){const scores=results.map(developmentScore);const prior=Math.max(...scores.slice(0,-budget.plateauTrials));const recent=Math.max(...scores.slice(-budget.plateauTrials));if(Number.isFinite(prior)&&recent<prior+.01)return {stop:true,reason:"development_plateau"};}
  return {stop:false};
}
export function acceptResearchVariation(trialNumber:number,proposal:ExperimentProposal):ExperimentProposal{
  if(trialNumber%4!==0)throw new Error("researcher proposals are allowed only on every fourth trial");
  return validateResearchProposal(proposal);
}
export function researcherView(results:TrialResult[]):{candidateId:string;development:Record<string,number>;failureCategories:string[]}[]{return results.map((result)=>({candidateId:result.candidateId,development:result.development,failureCategories:result.failure?[result.failure.code]:[]}));}
