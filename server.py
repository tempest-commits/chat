#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
スマホ専用 匿名リアルタイムチャットサーバー (No external dependencies)
Python 3 標準ライブラリのみで動作する SSE (Server-Sent Events) チャットサーバー
"""

import http.server
import socketserver
import json
import os
import sys
import time
import uuid
import socket
import threading
import queue
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", 8000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

# チャット状態管理
class ChatState:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = {}  # client_id -> queue.Queue
        self.messages = [] # 直近100件の履歴
        self.active_users = {} # client_id -> {"nickname": str, "avatar": str, "last_seen": float}
        self.recent_msg_hashes = {} # (client_id, text) -> timestamp (二重送信防止)
        self.max_history = 100

    def add_client(self, client_id):
        q = queue.Queue(maxsize=100)
        with self.lock:
            self.clients[client_id] = q
        return q

    def remove_client(self, client_id):
        nickname = None
        with self.lock:
            if client_id in self.clients:
                del self.clients[client_id]
            if client_id in self.active_users:
                nickname = self.active_users[client_id].get("nickname")
                del self.active_users[client_id]

        if nickname:
            self.broadcast({
                "type": "system",
                "id": str(uuid.uuid4()),
                "text": f"{nickname} さんが退出しました",
                "timestamp": int(time.time() * 1000),
                "onlineCount": self.get_online_count()
            })

    def register_user(self, client_id, nickname, avatar):
        with self.lock:
            self.active_users[client_id] = {
                "nickname": nickname,
                "avatar": avatar,
                "last_seen": time.time()
            }
        
        # 入室通知ブロードキャスト
        self.broadcast({
            "type": "system",
            "id": str(uuid.uuid4()),
            "text": f"{nickname} さんが参加しました 👋",
            "timestamp": int(time.time() * 1000),
            "onlineCount": self.get_online_count()
        })

    def update_heartbeat(self, client_id):
        with self.lock:
            if client_id in self.active_users:
                self.active_users[client_id]["last_seen"] = time.time()

    def get_online_count(self):
        now = time.time()
        with self.lock:
            # 60秒以上通信がないユーザーは除外
            valid = [k for k, v in self.active_users.items() if now - v["last_seen"] < 60]
            # 最低でも接続中のクライアント数は反映
            return max(len(valid), len(self.clients), 1)

    def post_message(self, client_id, nickname, avatar, text, custom_msg_id=None):
        now = time.time()
        key = (client_id, text)

        with self.lock:
            # 1.5秒以内の同一クライアント・同一メッセージの重複送信を完全に弾く
            last_sent = self.recent_msg_hashes.get(key, 0)
            if now - last_sent < 1.5:
                # 重複したリクエストには直前のメッセージを返してブロードキャストをスキップ
                if self.messages:
                    for m in reversed(self.messages):
                        if m.get("clientId") == client_id and m.get("text") == text:
                            return m
                return None
            
            self.recent_msg_hashes[key] = now
            # 古いキャッシュの掃除
            if len(self.recent_msg_hashes) > 200:
                cutoff = now - 5.0
                self.recent_msg_hashes = {k: v for k, v in self.recent_msg_hashes.items() if v > cutoff}

            msg_id = custom_msg_id or str(uuid.uuid4())
            msg = {
                "type": "chat",
                "id": msg_id,
                "clientId": client_id,
                "nickname": nickname,
                "avatar": avatar,
                "text": text,
                "reactions": {},
                "timestamp": int(now * 1000)
            }
            self.messages.append(msg)
            if len(self.messages) > self.max_history:
                self.messages = self.messages[-self.max_history:]

        self.broadcast({
            "type": "message",
            "message": msg,
            "onlineCount": self.get_online_count()
        })
        return msg

    def add_reaction(self, message_id, emoji):
        with self.lock:
            target = None
            for m in self.messages:
                if m["id"] == message_id:
                    target = m
                    break
            if not target:
                return None
            
            reactions = target.setdefault("reactions", {})
            reactions[emoji] = reactions.get(emoji, 0) + 1
            updated_count = reactions[emoji]

        payload = {
            "type": "reaction",
            "messageId": message_id,
            "emoji": emoji,
            "count": updated_count
        }
        self.broadcast(payload)
        return payload

    def broadcast(self, data):
        dead_clients = []
        payload_str = f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
        with self.lock:
            for cid, q in list(self.clients.items()):
                try:
                    q.put_nowait(payload_str)
                except queue.Full:
                    dead_clients.append(cid)
        for cid in dead_clients:
            self.remove_client(cid)

    def get_history(self):
        with self.lock:
            return list(self.messages)

state = ChatState()

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

class ChatHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def log_message(self, format, *args):
        try:
            msg = format % args
            if "/api/ping" in msg:
                return
            sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), msg))
        except Exception:
            pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        elif path == "/api/stream":
            self.handle_sse(parsed)
            return
        elif path == "/api/history":
            self.send_json({"messages": state.get_history(), "onlineCount": state.get_online_count()})
            return
        elif path == "/api/info":
            local_ip = get_local_ip()
            self.send_json({
                "localIp": local_ip,
                "port": PORT,
                "mobileUrl": f"http://{local_ip}:{PORT}/",
                "onlineCount": state.get_online_count()
            })
            return

        # デフォルトの静的ファイル配信
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        if path == "/api/join":
            client_id = data.get("clientId")
            nickname = (data.get("nickname") or "名無し").strip()[:20]
            avatar = data.get("avatar") or "🐱"
            if client_id:
                state.register_user(client_id, nickname, avatar)
            self.send_json({"success": True, "onlineCount": state.get_online_count()})
            return

        elif path == "/api/send":
            client_id = data.get("clientId") or "unknown"
            nickname = (data.get("nickname") or "名無し").strip()[:20]
            avatar = data.get("avatar") or "🐱"
            text = (data.get("text") or "").strip()[:500]
            custom_msg_id = data.get("msgId")

            if not text:
                self.send_json({"error": "Empty message"}, status=400)
                return

            msg = state.post_message(client_id, nickname, avatar, text, custom_msg_id)
            if msg:
                self.send_json({"success": True, "message": msg})
            else:
                self.send_json({"success": True, "duplicate": True})
            return

        elif path == "/api/react":
            message_id = data.get("messageId")
            emoji = data.get("emoji")
            if message_id and emoji:
                res = state.add_reaction(message_id, emoji)
                self.send_json({"success": True, "result": res})
            else:
                self.send_json({"error": "Invalid params"}, status=400)
            return

        elif path == "/api/ping":
            client_id = data.get("clientId")
            if client_id:
                state.update_heartbeat(client_id)
            self.send_json({"ok": True, "onlineCount": state.get_online_count()})
            return

        self.send_error(404, "Not Found")

    def handle_sse(self, parsed):
        params = parse_qs(parsed.query)
        client_id = params.get("clientId", [str(uuid.uuid4())])[0]

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        q = state.add_client(client_id)

        # 接続時初期イベント
        init_event = {
            "type": "init",
            "clientId": client_id,
            "onlineCount": state.get_online_count(),
            "history": state.get_history()
        }
        try:
            self.wfile.write(f"data: {json.dumps(init_event, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()
        except Exception:
            state.remove_client(client_id)
            return

        try:
            while True:
                try:
                    payload = q.get(timeout=15.0)
                    self.wfile.write(payload.encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    # Keep-alive コメント
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, Exception):
            pass
        finally:
            state.remove_client(client_id)

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def run():
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    local_ip = get_local_ip()
    server_address = ("0.0.0.0", PORT)
    httpd = ThreadedHTTPServer(server_address, ChatHTTPRequestHandler)
    print("=" * 60)
    print(" 🚀 スマホ匿名チャットサーバーが起動しました！")
    print(f" 💻 PCからのアクセス:      http://localhost:{PORT}/")
    print(f" 📱 スマホからのアクセス:    http://{local_ip}:{PORT}/")
    print("   (スマホとPCが同じWi-Fiに接続されていれば実機で開けます)")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました。")
        httpd.server_close()

if __name__ == "__main__":
    run()
