import json
import os
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
HOST = os.getenv("TYPO_HOST", "127.0.0.1")
PORT = int(os.getenv("TYPO_PORT", "4173"))
MODEL_NAME = os.getenv("TYPO_MODEL", "shibing624/macbert4csc-base-chinese")
MAX_CHUNK_CHARS = int(os.getenv("TYPO_MAX_CHUNK_CHARS", "220"))
MAX_TEXT_CHARS = int(os.getenv("TYPO_MAX_TEXT_CHARS", "5000"))
MODEL_PROVIDER = "pycorrector MacBERT CSC"

_corrector = None
_corrector_lock = threading.Lock()


class ModelLoadError(RuntimeError):
    pass


def load_corrector():
    global _corrector

    if _corrector is not None:
        return _corrector

    with _corrector_lock:
        if _corrector is not None:
            return _corrector

        try:
            try:
                from pycorrector import MacBertCorrector
            except ImportError:
                from pycorrector.macbert.macbert_corrector import MacBertCorrector
        except ImportError as exc:
            raise ModelLoadError("模型依赖未安装，请先执行 pip install -r requirements-local.txt") from exc

        _corrector = MacBertCorrector(MODEL_NAME)
        return _corrector


def split_text(text, limit=MAX_CHUNK_CHARS):
    if len(text) <= limit:
        return [text]

    chunks = []
    current = ""
    pieces = re.split(r"([。！？!?；;，,\n])", text)

    def flush():
        nonlocal current
        if current:
            chunks.append(current)
            current = ""

    for piece in pieces:
        if not piece:
            continue

        if len(piece) > limit:
            flush()
            start = 0
            while start < len(piece):
                chunks.append(piece[start:start + limit])
                start += limit
            continue

        if len(current) + len(piece) > limit:
            flush()

        current += piece

    flush()
    return chunks


def extract_corrected(value):
    if isinstance(value, str):
        return value

    if isinstance(value, dict):
        for key in ("target", "corrected_text", "correctedText", "result", "text"):
            item = value.get(key)
            if isinstance(item, str):
                return item

    if isinstance(value, (list, tuple)) and value:
        first = value[0]
        if isinstance(first, str):
            return first
        return extract_corrected(first)

    return ""


def correct_text(text):
    corrector = load_corrector()
    chunks = split_text(text)

    try:
        batch_result = corrector.correct_batch(chunks)
        if isinstance(batch_result, list) and len(batch_result) == len(chunks):
            return "".join(extract_corrected(item) or origin for item, origin in zip(batch_result, chunks))
    except Exception:
        pass

    corrected = []
    for chunk in chunks:
        result = corrector.correct(chunk)
        corrected.append(extract_corrected(result) or chunk)
    return "".join(corrected)


def read_request_text(payload):
    text = payload.get("text")
    if isinstance(text, str):
        return text

    messages = payload.get("messages")
    if isinstance(messages, list):
        for item in reversed(messages):
            if isinstance(item, dict) and item.get("role") == "user" and isinstance(item.get("content"), str):
                return item["content"]

    input_text = payload.get("input")
    if isinstance(input_text, str):
        return input_text

    return ""


class DemoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/api/health":
            self.write_json(200, {
                "ok": True,
                "provider": MODEL_PROVIDER,
                "model": MODEL_NAME,
                "loaded": _corrector is not None,
                "maxTextChars": MAX_TEXT_CHARS
            })
            return

        super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != "/api/proofread":
            self.write_json(404, {"error": "NOT_FOUND", "message": "接口不存在"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw_body or "{}")
        except Exception:
            self.write_json(400, {"error": "BAD_REQUEST", "message": "请求格式错误"})
            return

        text = read_request_text(payload)
        if not text.strip():
            self.write_json(400, {"error": "EMPTY_TEXT", "message": "请输入待校对文本"})
            return

        if len(text) > MAX_TEXT_CHARS:
            self.write_json(413, {
                "error": "TEXT_TOO_LONG",
                "message": f"文本过长，请控制在 {MAX_TEXT_CHARS} 字以内"
            })
            return

        try:
            corrected = correct_text(text)
        except ModelLoadError as exc:
            self.write_json(503, {"error": "MODEL_NOT_READY", "message": str(exc)})
            return
        except Exception:
            self.write_json(500, {"error": "PROOFREAD_FAILED", "message": "校对失败，请稍后重试"})
            return

        self.write_json(200, {
            "result": corrected,
            "text": corrected,
            "correctedText": corrected,
            "model": MODEL_NAME,
            "provider": MODEL_PROVIDER
        })

    def write_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer((HOST, PORT), DemoHandler)
    print(f"Typo proofreader demo: http://{HOST}:{PORT}/tools/typo-proofreader/")
    print(f"Model: {MODEL_PROVIDER} / {MODEL_NAME}")
    print("First proofread request may download and load the model.")
    server.serve_forever()


if __name__ == "__main__":
    main()
