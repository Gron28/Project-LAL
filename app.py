"""
Local AI Lab — web app: train your own model on your data, then chat with it.

Orchestrates the proven pipeline (LoRA fine-tune -> GGUF -> llama.cpp/Vulkan serve),
independent of the inbox app's Ollama. ONE GPU, so train and serve are mutually
exclusive (the UI enforces it).

Run:  sg render -c "bash gpu.sh python app.py"   then open http://localhost:8770
"""
import json, os, subprocess, threading, time, urllib.request
import http.server, socketserver

BASE = os.path.dirname(os.path.abspath(__file__))
VENV_PY = os.path.join(BASE, ".venv", "bin", "python")
FINETUNE = os.path.join(BASE, "scripts", "finetune.py")
CONVERT = os.path.join(BASE, "llama", "src", "convert_hf_to_gguf.py")
LLAMA_DIR = os.path.join(BASE, "llama", "llama-b9835")
LLAMA_SERVER = os.path.join(LLAMA_DIR, "llama-server")
MODELS, DATA, OUT = (os.path.join(BASE, d) for d in ("models", "data", "out"))
PORT, SERVE_PORT = 8770, 8099
BASES = ["Qwen/Qwen2.5-0.5B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct"]

for d in (MODELS, DATA, OUT):
    os.makedirs(d, exist_ok=True)

STATE = {"serving": None, "training": None, "phase": "idle"}
_server_proc = None
_lock = threading.Lock()


OLLAMA_STORE = "/usr/share/ollama/.ollama/models"


def gguf_list():
    return sorted(f[:-len("-f16.gguf")] for f in os.listdir(MODELS) if f.endswith("-f16.gguf"))


def ollama_models():
    """Map existing Ollama models -> their GGUF blob path (read-only, no re-download)."""
    out = {}
    base = os.path.join(OLLAMA_STORE, "manifests")
    if not os.path.isdir(base):
        return out
    for root, _, files in os.walk(base):
        for fn in files:
            try:
                man = json.load(open(os.path.join(root, fn)))
            except Exception:
                continue
            parts = os.path.relpath(os.path.join(root, fn), base).split(os.sep)
            if len(parts) < 2:
                continue
            name = f"{parts[-2]}:{parts[-1]}"
            for l in man.get("layers", []):
                if "model" in l.get("mediaType", ""):
                    blob = os.path.join(OLLAMA_STORE, "blobs", l["digest"].replace(":", "-"))
                    if os.path.exists(blob):
                        out[name] = {"path": blob, "size": l.get("size", 0)}
    return out


def stop_server():
    global _server_proc
    if _server_proc and _server_proc.poll() is None:
        _server_proc.terminate()
        try:
            _server_proc.wait(timeout=10)
        except Exception:
            _server_proc.kill()
    _server_proc = None
    STATE["serving"] = None


def start_server(label, gguf_path, ngl=99):
    global _server_proc
    stop_server()
    # self-heal: free the port from any orphaned llama-server (e.g. after a restart)
    subprocess.run(["pkill", "-9", "-f", f"llama-server.*--port {SERVE_PORT}"],
                   capture_output=True)
    time.sleep(0.5)
    if not os.path.exists(gguf_path):
        return False, "model file not found"
    env = dict(os.environ, LD_LIBRARY_PATH=LLAMA_DIR)
    _server_proc = subprocess.Popen(
        [LLAMA_SERVER, "-m", gguf_path, "-ngl", str(ngl), "--host", "127.0.0.1",
         "--port", str(SERVE_PORT)], env=env,
        stdout=open(os.path.join(OUT, "server.log"), "w"), stderr=subprocess.STDOUT)
    # wait for ready (big models load slower)
    for _ in range(240):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{SERVE_PORT}/health", timeout=1)
            STATE["serving"] = model
            return True, "ok"
        except Exception:
            if _server_proc.poll() is not None:
                return False, "server exited"
            time.sleep(1)
    return False, "timeout"


def train_job(name, base, steps, lr):
    """Fine-tune -> merge -> GGUF. Streams JSON-line progress to out/<name>.train.log."""
    log = os.path.join(OUT, f"{name}.train.log")
    STATE.update(training=name, phase="training")
    stop_server()  # free the GPU
    try:
        with open(log, "w") as f:
            f.write(json.dumps({"event": "phase", "phase": "finetune"}) + "\n"); f.flush()
            p = subprocess.Popen(
                [VENV_PY, FINETUNE, "--base", base, "--data", os.path.join(DATA, f"{name}.txt"),
                 "--out", os.path.join(OUT, name), "--steps", str(steps), "--lr", str(lr), "--merge"],
                cwd=BASE, env=dict(os.environ, HSA_OVERRIDE_GFX_VERSION="10.3.0"),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            for line in p.stdout:
                if line.strip().startswith("{"):
                    f.write(line); f.flush()
            p.wait()
            if p.returncode != 0:
                f.write(json.dumps({"event": "error", "msg": "finetune failed"}) + "\n"); return
            f.write(json.dumps({"event": "phase", "phase": "convert"}) + "\n"); f.flush()
            gguf = os.path.join(MODELS, f"{name}-f16.gguf")
            c = subprocess.run([VENV_PY, CONVERT, os.path.join(OUT, name),
                                "--outfile", gguf, "--outtype", "f16"],
                               cwd=BASE, capture_output=True, text=True)
            ok = c.returncode == 0 and os.path.exists(gguf)
            f.write(json.dumps({"event": "done", "ok": ok,
                                "model": name if ok else None}) + "\n")
    finally:
        STATE.update(training=None, phase="idle")


class H(http.server.BaseHTTPRequestHandler):
    def _send(self, body, code=200, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client gave up waiting (e.g. slow model load) — don't crash the thread

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            return json.loads(self.rfile.read(n) or "{}")
        except Exception:
            return {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            with open(os.path.join(BASE, "dashboard.html"), encoding="utf-8") as fp:
                return self._send(fp.read(), ctype="text/html; charset=utf-8")
        if path == "/tokens.css":
            with open(os.path.join(BASE, "tokens.css")) as fp:
                return self._send(fp.read(), ctype="text/css")
        if path == "/api/state":
            ext = [{"name": n, "gb": round(v["size"] / 1e9, 1)}
                   for n, v in sorted(ollama_models().items())]
            return self._send({**STATE, "models": gguf_list(), "external": ext, "bases": BASES})
        if path == "/api/progress":
            name = self.path.split("name=")[-1]
            log = os.path.join(OUT, f"{name}.train.log")
            rows = []
            if os.path.exists(log):
                rows = [json.loads(l) for l in open(log) if l.strip().startswith("{")]
            return self._send(rows)
        if path == "/api/download":
            name = self.path.split("model=")[-1]
            gguf = os.path.join(MODELS, f"{name}-f16.gguf")
            if not os.path.exists(gguf):
                return self._send("not found", 404, "text/plain")
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="{name}.gguf"')
            self.send_header("Content-Length", str(os.path.getsize(gguf)))
            self.end_headers()
            with open(gguf, "rb") as fp:
                while chunk := fp.read(1 << 20):
                    self.wfile.write(chunk)
            return
        return self._send("not found", 404, "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        d = self._body()
        if path == "/api/train":
            if STATE["training"]:
                return self._send({"error": "already training"}, 409)
            name = "".join(c for c in d.get("name", "model") if c.isalnum() or c in "-_") or "model"
            open(os.path.join(DATA, f"{name}.txt"), "w", encoding="utf-8").write(d.get("text", ""))
            threading.Thread(target=train_job, args=(name, d.get("base", BASES[0]),
                             int(d.get("steps", 150)), float(d.get("lr", 2e-4)),
                             ), daemon=True).start()
            return self._send({"started": True, "name": name})
        if path == "/api/serve":
            if STATE["training"]:
                return self._send({"error": "busy training"}, 409)
            model = d.get("model")
            ngl = int(d.get("ngl", 99))
            if d.get("source") == "ollama":
                om = ollama_models().get(model)
                if not om:
                    return self._send({"ok": False, "msg": "ollama model not found"}, 404)
                ok, msg = start_server(model, om["path"], ngl)
            else:
                ok, msg = start_server(model, os.path.join(MODELS, f"{model}-f16.gguf"), ngl)
            return self._send({"ok": ok, "msg": msg, "serving": STATE["serving"]})
        if path == "/api/stop_serve":
            stop_server()
            return self._send({"ok": True})
        if path == "/api/chat":
            if not STATE["serving"]:
                return self._send({"error": "no model served"}, 409)
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{SERVE_PORT}/v1/chat/completions",
                    data=json.dumps(d).encode(), headers={"Content-Type": "application/json"})
                resp = urllib.request.urlopen(req, timeout=120).read()
                return self._send(resp.decode())
            except Exception as e:
                return self._send({"error": str(e)}, 500)
        return self._send("not found", 404, "text/plain")

    def log_message(self, *a):
        pass


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), H) as httpd:
        print(f"Local AI Lab -> http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            stop_server()


if __name__ == "__main__":
    main()
