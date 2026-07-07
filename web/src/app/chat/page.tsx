"use client";
import dynamic from "next/dynamic";

const AgentChat = dynamic(() => import("../agent/agent-chat"), { ssr: false });

export default function ChatPage() {
  return <AgentChat />;
}
