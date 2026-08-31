import { NextRequest, NextResponse } from "next/server";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { getImprovementRepository } from "@/lib/improvement/store";
export const dynamic="force-dynamic";
export function GET(){const repository=getImprovementRepository();return NextResponse.json({campaigns:repository.listCampaigns().map((stored)=>{const campaign=repository.reconcileJob(stored.id);return {...campaign,candidates:repository.listCandidates(campaign.id),trials:repository.listTrials(campaign.id),evaluation:campaign.evaluationId?repository.getEvaluation(campaign.evaluationId):null};}),activeSet:repository.activeSet()},{headers:{"cache-control":"no-store"}});}
export async function POST(request:NextRequest){const authorization=authorizeBrowserMutation(request);if(!authorization.ok)return NextResponse.json({error:authorization.code},{status:authorization.status});try{return NextResponse.json({campaign:getImprovementRepository().createCampaign(await request.json())},{status:201});}catch(error){return NextResponse.json({error:(error as Error).message},{status:400});}}
