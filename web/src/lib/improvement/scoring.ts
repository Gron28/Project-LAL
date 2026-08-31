import type { CampaignEvaluationInput, EvaluationGate, PairedScore, RolePack } from "./contracts.ts";

export type PairedOutcome = { candidate: boolean; base: boolean; reference: boolean };

/** Paired bootstrap with a local PRNG makes intervals reproducible across hosts. */
export function pairedScore(rows: PairedOutcome[], seed = 1, samples = 4000): PairedScore {
  if (!rows.length) throw new Error("paired scoring requires at least one case");
  let state=seed>>>0 || 1;
  const random=()=>{ state=(Math.imul(state,1664525)+1013904223)>>>0; return state/2**32; };
  const rate=(field:keyof PairedOutcome)=>rows.filter((row)=>row[field]).length/rows.length;
  const diffs:number[]=[];
  for(let n=0;n<samples;n++){let difference=0;for(let i=0;i<rows.length;i++){const row=rows[Math.floor(random()*rows.length)]!;difference+=(Number(row.candidate)-Number(row.base));}diffs.push(100*difference/rows.length);}
  diffs.sort((a,b)=>a-b);
  const at=(p:number)=>diffs[Math.max(0,Math.min(diffs.length-1,Math.floor(p*(diffs.length-1))))]!;
  const candidateRate=rate("candidate"),baseRate=rate("base"),referenceRate=rate("reference");
  return { cases:rows.length,candidateRate,baseRate,referenceRate,improvementPoints:100*(candidateRate-baseRate),referenceGapPoints:100*(referenceRate-candidateRate),confidenceInterval:[at(.025),at(.975)] };
}

export function geometricAggregate(values: number[]): number {
  if (!values.length || values.some((value)=>!Number.isFinite(value)||value<0||value>1)) throw new Error("geometric aggregate requires rates in [0,1]");
  return Math.exp(values.reduce((sum,value)=>sum+Math.log(Math.max(value,1e-12)),0)/values.length);
}

export function evaluateCampaign(input: CampaignEvaluationInput, pack: RolePack): { verdict:"pass"|"fail"|"needs_review";gates:EvaluationGate[] } {
  const p=pack.scoringPolicy;
  const roleScores=pack.roles.map((role)=>[role.id,input.roleScores[role.id]] as const);
  const gates:EvaluationGate[]=[];
  for(const [role,score] of roleScores){
    if(!score){gates.push({code:`${role}.complete`,passed:false,actual:false,required:"paired candidate/base/reference score"});continue;}
    gates.push({code:`${role}.sample`,passed:score.cases>=30,actual:score.cases,required:">= 30 blind cases"});
    gates.push({code:`${role}.base_improvement`,passed:score.improvementPoints>=p.minimumBaseImprovementPoints,actual:score.improvementPoints,required:`>= ${p.minimumBaseImprovementPoints} points`});
    gates.push({code:`${role}.confidence`,passed:score.confidenceInterval[0]>0,actual:score.confidenceInterval[0],required:"paired 95% CI lower bound > 0"});
    gates.push({code:`${role}.reference_parity`,passed:score.referenceGapPoints<=p.parityMarginPoints,actual:score.referenceGapPoints,required:`<= ${p.parityMarginPoints} points below reference`});
  }
  const w=input.workflowScore;
  gates.push(
    {code:"workflow.sample",passed:w.cases>=30,actual:w.cases,required:">= 30 blind workflows"},
    {code:"workflow.base_improvement",passed:w.improvementPoints>=p.workflowImprovementPoints,actual:w.improvementPoints,required:`>= ${p.workflowImprovementPoints} points`},
    {code:"workflow.confidence",passed:w.confidenceInterval[0]>0,actual:w.confidenceInterval[0],required:"paired 95% CI lower bound > 0"},
    {code:"workflow.reference_parity",passed:w.referenceGapPoints<=p.parityMarginPoints,actual:w.referenceGapPoints,required:`<= ${p.parityMarginPoints} points below reference`},
    {code:"core_regression",passed:input.coreRegressionPoints<=p.maximumRegressionPoints,actual:input.coreRegressionPoints,required:`<= ${p.maximumRegressionPoints} points`},
    {code:"schema_contracts",passed:input.schemaContractsPassed,actual:input.schemaContractsPassed,required:"100%"},
    {code:"tool_contracts",passed:input.toolContractsPassed,actual:input.toolContractsPassed,required:"100%"},
    {code:"unauthorized_actions",passed:input.unauthorizedActions===0,actual:input.unauthorizedActions,required:"0"},
    {code:"false_completions",passed:input.falseCompletions===0,actual:input.falseCompletions,required:"0"},
    {code:"peak_memory",passed:input.peakMemoryBytes.candidate<input.peakMemoryBytes.reference,actual:input.peakMemoryBytes.candidate,required:`< ${input.peakMemoryBytes.reference}`},
    {code:"judge_reviews",passed:input.unresolvedReviews===0,actual:input.unresolvedReviews,required:"0 unresolved"},
  );
  const completeCandidateSet=pack.roles.every((role)=>!!input.candidateSet[role.id]);
  gates.push({code:"complete_specialist_set",passed:completeCandidateSet,actual:completeCandidateSet,required:"one pinned adapter per role"});
  const adapterIntegrity=Object.values(input.candidateSet).every((adapter)=>!!adapter.adapterId&&/^[a-f0-9]{64}$/.test(adapter.adapterSha256));
  gates.push({code:"adapter_integrity",passed:adapterIntegrity,actual:adapterIntegrity,required:"exact adapter ids and SHA-256 hashes"});
  const needsReview=input.unresolvedReviews>0
    || Math.abs(input.workflowScore.referenceGapPoints)<=p.parityMarginPoints
    || roleScores.some(([,score])=>!!score&&Math.abs(score.referenceGapPoints)<=p.parityMarginPoints);
  return { verdict:needsReview?"needs_review":gates.every((gate)=>gate.passed)?"pass":"fail",gates };
}
