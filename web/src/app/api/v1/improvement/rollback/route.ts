import { NextRequest, NextResponse } from "next/server";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { getImprovementRepository } from "@/lib/improvement/store";
export async function POST(request:NextRequest){const authorization=authorizeBrowserMutation(request);if(!authorization.ok)return NextResponse.json({error:authorization.code},{status:authorization.status});const body=await request.json().catch(()=>({}));try{return NextResponse.json({activeSet:getImprovementRepository().rollback(String(body.reason??""))});}catch(error){return NextResponse.json({error:(error as Error).message},{status:409});}}
