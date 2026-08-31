import crypto from "node:crypto";
import type { JobRepository } from "../jobs.ts";
import { CAMPAIGN_BUDGETS, type CampaignEvaluationInput, type CandidateRecipe, type CandidateRecipeInput, type ImprovementCampaign, type TrialResultInput } from "./contracts.ts";
import type { ImprovementRepository } from "./store.ts";
import { budgetStop, canonicalRecipes, continuationIds, developmentScore } from "./search.ts";
import { getRolePack } from "./role-packs.ts";

export interface CampaignTrialDriver { run(campaign:ImprovementCampaign,recipe:CandidateRecipe):Promise<Omit<TrialResultInput,"campaignId"|"candidateId">>; }
export interface CampaignHiddenDriver { run(campaign:ImprovementCampaign,finalists:CandidateRecipe[]):Promise<Omit<CampaignEvaluationInput,"campaignId">>; }
export type CampaignRunOutcome={state:ImprovementCampaign["state"];trials:number;reason?:string;evaluationId?:string};
const hash=(value:string)=>crypto.createHash("sha256").update(value).digest("hex");

function continuation(parent:CandidateRecipe,fraction:.5|1):CandidateRecipeInput{return {campaignId:parent.campaignId,roleId:parent.roleId,objective:parent.objective,rank:parent.rank,alpha:parent.alpha,dropout:parent.dropout,targets:parent.targets,learningRate:parent.learningRate,warmupRatio:parent.warmupRatio,schedule:parent.schedule,retentionPercent:parent.retentionPercent,...(parent.klCoefficient?{klCoefficient:parent.klCoefficient}:{}),seed:parent.seed,budgetFraction:fraction,hypothesis:`Continue ${parent.id} after its development-only rank survived successive halving.`,parentCandidateId:parent.id,trainerRevision:parent.trainerRevision,researcherProposed:parent.researcherProposed};}

export class ImprovementCampaignRunner {
  private readonly campaigns: ImprovementRepository;
  private readonly jobs: JobRepository;
  private readonly trials: CampaignTrialDriver;
  private readonly hidden?: CampaignHiddenDriver;

  constructor(campaigns: ImprovementRepository, jobs: JobRepository, trials: CampaignTrialDriver, hidden?: CampaignHiddenDriver) {
    this.campaigns = campaigns;
    this.jobs = jobs;
    this.trials = trials;
    this.hidden = hidden;
  }
  recover():{queued:string[];interrupted:string[]}{const result=this.jobs.recover("improvement.campaign");for(const jobId of result.queued)this.campaigns.requeueRecoveredJob(jobId);return result;}
  async run(campaignId:string):Promise<CampaignRunOutcome>{let campaign=this.campaigns.getCampaign(campaignId);if(!campaign?.jobId)throw new Error("campaign must be explicitly started before execution");const jobId=campaign.jobId;if(campaign.state==="paused")return {state:"paused",trials:campaign.budgetConsumed.trials,reason:"owner paused"};if(campaign.state==="queued"){const started=this.jobs.start(jobId);if(!started.started)return {state:"queued",trials:campaign.budgetConsumed.trials,reason:started.reason};campaign=this.campaigns.markRunning(campaignId);}if(campaign.state!=="running")throw new Error(`campaign is not runnable from ${campaign.state}`);
    try{
      const pack=getRolePack(campaign.rolePack.id,campaign.rolePack.version);if(!pack)throw new Error("frozen role pack revision is unavailable");
      const existingTrials=this.campaigns.listTrials(campaignId),completed=new Set(existingTrials.map((trial)=>trial.candidateId));
      const initial=pack.roles.flatMap((role,index)=>canonicalRecipes(campaignId,role.id,"campaign-runner-v1",17+index*10));
      const queue:CandidateRecipeInput[]=[...initial];let phase:.25|.5|1=.25;
      while(queue.length){const stop=budgetStop(CAMPAIGN_BUDGETS[campaign.budget],this.campaigns.listTrials(campaignId));if(stop.stop)break;const candidate=this.campaigns.createCandidate(queue.shift()!);if(completed.has(candidate.id))continue;const result=await this.trials.run(campaign,candidate);const job=this.jobs.get(jobId)!;if(job.cancelRequestedAt){this.jobs.cancelSettled(jobId);return {state:this.campaigns.cancel(campaignId).state,trials:this.campaigns.listTrials(campaignId).length,reason:"cancelled at trial checkpoint"};}this.campaigns.recordTrial({campaignId,candidateId:candidate.id,...result});completed.add(candidate.id);const checkpoint=this.jobs.checkpoint(jobId,{campaignId,currentCandidateId:candidate.id,phase,candidateSha256:candidate.sha256},{phase:`development_${phase}`,completed:this.campaigns.listTrials(campaignId).length,total:CAMPAIGN_BUDGETS[campaign.budget].maxTrials});if(checkpoint.state==="paused")return {state:this.campaigns.reconcileJob(campaignId).state,trials:this.campaigns.listTrials(campaignId).length,reason:"paused at safe optimizer checkpoint"};}
      let results=this.campaigns.listTrials(campaignId);for(const nextFraction of [.5,1] as const){phase=nextFraction;const ids=continuationIds(results,nextFraction),parents=this.campaigns.listCandidates(campaignId).filter((candidate)=>ids.includes(candidate.id));for(const parent of parents){const stop=budgetStop(CAMPAIGN_BUDGETS[campaign.budget],this.campaigns.listTrials(campaignId));if(stop.stop)break;const candidate=this.campaigns.createCandidate(continuation(parent,nextFraction));if(completed.has(candidate.id))continue;const result=await this.trials.run(campaign,candidate);this.campaigns.recordTrial({campaignId,candidateId:candidate.id,...result});completed.add(candidate.id);const checkpoint=this.jobs.checkpoint(jobId,{campaignId,currentCandidateId:candidate.id,phase,candidateSha256:candidate.sha256},{phase:`development_${phase}`,completed:this.campaigns.listTrials(campaignId).length,total:CAMPAIGN_BUDGETS[campaign.budget].maxTrials});if(checkpoint.state==="paused")return {state:this.campaigns.reconcileJob(campaignId).state,trials:this.campaigns.listTrials(campaignId).length,reason:"paused at safe optimizer checkpoint"};}results=this.campaigns.listTrials(campaignId);}
      const budget=CAMPAIGN_BUDGETS[campaign.budget],ranked=results.filter((result)=>result.status==="succeeded").sort((a,b)=>developmentScore(b)-developmentScore(a)),finalistIds=new Set(ranked.slice(0,budget.finalists).map((result)=>result.candidateId)),finalists=this.campaigns.listCandidates(campaignId).filter((candidate)=>finalistIds.has(candidate.id));
      this.campaigns.freeze(campaignId,{protocolVersion:1,optimizer:"successive-halving",finalistRecipeIds:finalists.map((candidate)=>candidate.id),trialBudget:budget.maxTrials,gpuHourBudget:budget.maxGpuHours});
      if(campaign.budget==="smoke"||!this.hidden){const finished=this.campaigns.finishDiagnostic(campaignId,campaign.budget==="smoke"?undefined:"hidden evaluator is not configured");this.jobs.succeed(jobId,[{id:`diagnostic:${campaignId}`,digest:hash(`${campaignId}:${finished.state}`)}]);return {state:finished.state,trials:results.length,reason:finished.reason};}
      this.campaigns.beginHiddenEvaluation(campaignId);const evaluation=this.campaigns.recordEvaluation({campaignId,...await this.hidden.run(campaign,finalists)});this.jobs.succeed(jobId,[{id:evaluation.id,digest:evaluation.sha256}]);return {state:"awaiting_approval",trials:results.length,evaluationId:evaluation.id};
    }catch(error){const message=(error as Error).message;const job=this.jobs.get(jobId);if(job&&!["failed","cancelled","succeeded","interrupted"].includes(job.state))this.jobs.fail(jobId,{code:"campaign_failed",message,retryable:true});const current=this.campaigns.getCampaign(campaignId);if(current&&!["failed","cancelled","rejected","promoted"].includes(current.state))this.campaigns.failCampaign(campaignId,message);return {state:"failed",trials:this.campaigns.listTrials(campaignId).length,reason:message};}
  }
}
