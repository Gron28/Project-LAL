"use client";
import dynamic from "next/dynamic";
import ChatModes from "./chat-modes";

const AgentChat = dynamic(() => import("./agent/agent-chat"), { ssr: false });

export default function Home() {
  return (
    <>
      <ChatModes />
      <AgentChat />
    </>
  );
}
