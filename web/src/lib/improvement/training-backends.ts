import { startTrain } from "../lab.ts";

export type ManagedTrainingRequest=Parameters<typeof startTrain>[0];
export type ManagedTrainingCapability={id:"amd-hqq"|"peft"|"cuda-qlora"|"legacy-raw";modes:("raw"|"sft"|"hqq")[];objectives:("sft"|"sft_replay"|"sft_kl")[];availability:"available"|"probe_required"};
export const MANAGED_TRAINING_CAPABILITIES:ManagedTrainingCapability[]=[
  {id:"amd-hqq",modes:["hqq"],objectives:["sft","sft_replay","sft_kl"],availability:"available"},
  {id:"peft",modes:["sft"],objectives:["sft"],availability:"available"},
  {id:"cuda-qlora",modes:[],objectives:["sft","sft_replay","sft_kl"],availability:"probe_required"},
  {id:"legacy-raw",modes:["raw"],objectives:["sft"],availability:"available"},
];
export function trainingBackendFor(request:ManagedTrainingRequest):ManagedTrainingCapability{
  const mode=request.mode??"raw";
  const backend=MANAGED_TRAINING_CAPABILITIES.find((candidate)=>candidate.modes.includes(mode));
  if(!backend)throw new Error(`no measured training backend for mode ${mode}`);
  const objective=request.objective??"sft";
  if(!backend.objectives.includes(objective))throw new Error(`${backend.id} reports ${objective} as incompatible; no objective substitution was made`);
  return backend;
}
/** Shared entry point for manual Train and improvement-campaign workers. */
export async function startManagedTraining(request:ManagedTrainingRequest){const backend=trainingBackendFor(request);const result=await startTrain(request);return {...result,backend:backend.id};}
