"""Small OpenAI-compatible server for OpenVINO GenAI on Intel NPU."""

from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(item.get("text", ""))
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        )
    return str(content or "")


def normalize_messages(messages: Any, disable_thinking: bool, response_language: str) -> list[dict[str, str]]:
    normalized = [
        {"role": str(item.get("role", "user")), "content": text_content(item.get("content"))}
        for item in messages or []
        if isinstance(item, dict)
    ]
    if disable_thinking:
        for item in reversed(normalized):
            if item["role"] == "user":
                item["content"] = f"{item['content'].rstrip()} /no_think"
                break
    if response_language == "en":
        normalized.append({"role": "system", "content": "Reply in English unless the user explicitly asks for another language."})
    elif response_language == "es":
        normalized.append({"role": "system", "content": "Respond in Spanish unless the user explicitly asks for another language."})
    return normalized


class NpuRuntime:
    def __init__(self, model_path: Path, model_id: str, cache_dir: Path, max_prompt_len: int):
        import openvino_genai as ov_genai

        self.ov_genai = ov_genai
        self.model_id = model_id
        self.lock = threading.Lock()
        cache_dir.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        self.pipe = ov_genai.LLMPipeline(
            str(model_path),
            "NPU",
            MAX_PROMPT_LEN=max_prompt_len,
            # NPU uses static prompt/response shapes. The 128-token default
            # makes a coding-agent request spend time compiling unused output
            # capacity before its first visible token.
            MIN_RESPONSE_LEN=16,
            CACHE_DIR=str(cache_dir),
        )
        self.load_seconds = time.perf_counter() - started

    @staticmethod
    def history(messages: list[dict[str, str]], disable_thinking: bool = False) -> str:
        """Render Qwen3 ChatML explicitly instead of using ChatHistory.

        The NPU pipeline completed direct string generation but stalled when
        handed ChatHistory, so keep the OpenAI HTTP interface stateless while
        passing the model the format its exported chat template expects.
        """
        turns = [
            f"<|im_start|>{message['role']}\n{message['content']}<|im_end|>"
            for message in messages
        ]
        suffix = "<|im_start|>assistant\n"
        if disable_thinking:
            suffix += "<think>\n\n</think>\n\n"
        return "\n".join([*turns, suffix])

    @staticmethod
    def generation_options(body: dict[str, Any]) -> dict[str, Any]:
        temperature = float(body.get("temperature", 0) or 0)
        options: dict[str, Any] = {
            "max_new_tokens": max(1, int(body.get("max_tokens", 512) or 512)),
            "do_sample": temperature > 0,
        }
        if temperature > 0:
            options["temperature"] = temperature
        if body.get("top_p") is not None:
            options["top_p"] = float(body["top_p"])
        if body.get("top_k") is not None:
            options["top_k"] = int(body["top_k"])
        repeat = body.get("repeat_penalty", body.get("repetition_penalty"))
        if repeat is not None:
            options["repetition_penalty"] = float(repeat)
        return options


class Handler(BaseHTTPRequestHandler):
    runtime: NpuRuntime

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[openvino-npu] {self.address_string()} {fmt % args}", flush=True)

    def json_response(self, status: int, value: Any) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path in {"/health", "/v1/health"}:
            self.json_response(
                200,
                {
                    "status": "ok",
                    "device": "NPU",
                    "model": self.runtime.model_id,
                    "load_seconds": round(self.runtime.load_seconds, 2),
                },
            )
            return
        if self.path == "/v1/models":
            self.json_response(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": self.runtime.model_id,
                            "object": "model",
                            "owned_by": "openvino-npu",
                        }
                    ],
                },
            )
            return
        self.json_response(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.json_response(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            if body.get("model") not in {None, "", self.runtime.model_id}:
                self.json_response(404, {"error": {"message": "unknown model"}})
                return
            # Coding clients often hide Qwen's reasoning channel, which looks
            # like a hung request on a small NPU model. Keep it off unless a
            # caller explicitly requests it.
            disable_thinking = body.get("chat_template_kwargs", {}).get("enable_thinking") is not True
            response_language = str(body.get("response_language", "model"))
            messages = normalize_messages(body.get("messages"), disable_thinking, response_language)
            if not messages:
                self.json_response(400, {"error": {"message": "messages are required"}})
                return
            if body.get("stream"):
                self.stream_completion(body, messages, disable_thinking)
            else:
                self.complete(body, messages, disable_thinking)
        except Exception as error:
            if not self.wfile.closed:
                self.json_response(500, {"error": {"message": str(error)}})

    def complete(self, body: dict[str, Any], messages: list[dict[str, str]], disable_thinking: bool) -> None:
        started = time.perf_counter()
        with self.runtime.lock:
            result = self.runtime.pipe.generate(
                self.runtime.history(messages, disable_thinking),
                **self.runtime.generation_options(body),
            )
        text = result.texts[0] if hasattr(result, "texts") else str(result)
        self.json_response(
            200,
            {
                "id": f"chatcmpl-{uuid.uuid4().hex}",
                "object": "chat.completion",
                "model": self.runtime.model_id,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "timings": {"elapsed_seconds": round(time.perf_counter() - started, 3)},
            },
        )

    def stream_completion(self, body: dict[str, Any], messages: list[dict[str, str]], disable_thinking: bool) -> None:
        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def send(value: Any) -> bool:
            try:
                line = f"data: {json.dumps(value, ensure_ascii=False)}\n\n".encode("utf-8")
                self.wfile.write(line)
                self.wfile.flush()
                return False
            except (BrokenPipeError, ConnectionResetError):
                return True

        send(
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "model": self.runtime.model_id,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
        )

        def streamer(piece: str) -> bool:
            return send(
                {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "model": self.runtime.model_id,
                    "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}],
                }
            )

        with self.runtime.lock:
            self.runtime.pipe.generate(
                self.runtime.history(messages, disable_thinking),
                streamer=streamer,
                **self.runtime.generation_options(body),
            )
        send(
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "model": self.runtime.model_id,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
        )
        try:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--model-id", default="openvino/qwen3-8b-npu")
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--max-prompt-len", type=int, default=1024)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8100)
    args = parser.parse_args()
    if not args.model_path.exists():
        raise SystemExit(f"model path does not exist: {args.model_path}")
    runtime = NpuRuntime(args.model_path.resolve(), args.model_id, args.cache_dir.resolve(), args.max_prompt_len)
    Handler.runtime = runtime
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"[openvino-npu] ready model={args.model_id} device=NPU "
        f"load={runtime.load_seconds:.2f}s url=http://{args.host}:{args.port}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
