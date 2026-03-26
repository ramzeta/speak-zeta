from fastapi import FastAPI, WebSocket, WebSocketDisconnect, WebSocketException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from datetime import datetime
import json
import uuid
import re
import time

app = FastAPI(title="Speak Zeta", docs_url=None, redoc_url=None)

ALLOWED_ORIGINS = [
    "https://speak-zeta.algorito.io",
    "http://localhost:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# ── Constants / Limits ─────────────────────────────────────

MAX_USERNAME_LEN = 20
MAX_ROOM_NAME_LEN = 30
MAX_MSG_LEN = 2000
MAX_ROOMS = 50
MAX_VOICE_ROOMS = 20
MAX_CONNECTIONS_PER_ROOM = 50
MAX_WS_MSG_SIZE = 16_384  # 16KB for signaling
MSG_RATE_LIMIT = 5  # max messages per second per user
ROOM_NAME_RE = re.compile(r'^[a-z0-9][a-z0-9\-]{0,28}[a-z0-9]$')
USERNAME_RE = re.compile(r'^[a-zA-Z0-9_\-]{1,20}$')


def validate_username(username: str) -> str:
    username = username.strip()[:MAX_USERNAME_LEN]
    if not username or not USERNAME_RE.match(username):
        raise ValueError("Username invalido")
    return username


def sanitize_room_name(name: str) -> str:
    name = name.lower().strip().replace(" ", "-")[:MAX_ROOM_NAME_LEN]
    name = re.sub(r'[^a-z0-9\-]', '', name)
    name = re.sub(r'-+', '-', name).strip('-')
    if not name or len(name) < 2:
        raise ValueError("Nombre de sala invalido")
    return name


# ── Rate Limiter ───────────────────────────────────────────

class RateLimiter:
    def __init__(self, max_per_second: int = MSG_RATE_LIMIT):
        self.max_per_second = max_per_second
        self.buckets: dict[str, list[float]] = {}

    def check(self, key: str) -> bool:
        now = time.monotonic()
        bucket = self.buckets.setdefault(key, [])
        # Remove old entries
        bucket[:] = [t for t in bucket if now - t < 1.0]
        if len(bucket) >= self.max_per_second:
            return False
        bucket.append(now)
        return True


rate_limiter = RateLimiter()


# ── Text Room ──────────────────────────────────────────────

class Room:
    def __init__(self, name: str, description: str = ""):
        self.name = name
        self.description = description
        self.connections: dict[str, WebSocket] = {}
        self.messages: list[dict] = []
        self.users: dict[str, str] = {}

    def to_dict(self):
        return {
            "name": self.name,
            "description": self.description,
            "type": "text",
            "users": list(self.users.values()),
            "user_count": len(self.users),
        }


# ── Voice Room ─────────────────────────────────────────────

class VoiceRoom:
    def __init__(self, name: str, description: str = "", user_limit: int = 0):
        self.name = name
        self.description = description
        self.user_limit = user_limit
        self.connections: dict[str, WebSocket] = {}
        self.users: dict[str, str] = {}
        self.muted: dict[str, bool] = {}
        self.deafened: dict[str, bool] = {}
        self.speaking: dict[str, bool] = {}
        self.streaming: dict[str, bool] = {}

    def to_dict(self):
        users_info = []
        for ws_id, uname in self.users.items():
            users_info.append({
                "ws_id": ws_id,
                "username": uname,
                "muted": self.muted.get(ws_id, False),
                "deafened": self.deafened.get(ws_id, False),
                "speaking": self.speaking.get(ws_id, False),
                "streaming": self.streaming.get(ws_id, False),
            })
        return {
            "name": self.name,
            "description": self.description,
            "type": "voice",
            "users": users_info,
            "user_count": len(self.users),
            "user_limit": self.user_limit,
        }


# ── State ──────────────────────────────────────────────────

rooms: dict[str, Room] = {
    "general": Room("general", "Chat general para todos"),
    "random": Room("random", "Conversaciones random"),
    "tech": Room("tech", "Tecnologia y desarrollo"),
}

voice_rooms: dict[str, VoiceRoom] = {
    "voz-general": VoiceRoom("voz-general", "Canal de voz principal"),
    "gaming": VoiceRoom("gaming", "Para gaming y chill"),
}


# ── Helpers ────────────────────────────────────────────────

def all_rooms_list():
    return [r.to_dict() for r in rooms.values()] + [r.to_dict() for r in voice_rooms.values()]


async def broadcast_all_rooms():
    data = json.dumps({"type": "rooms_update", "rooms": all_rooms_list()})
    for room in rooms.values():
        dead = []
        for ws_id, ws_ in room.connections.items():
            try:
                await ws_.send_text(data)
            except Exception:
                dead.append(ws_id)
        for ws_id in dead:
            room.connections.pop(ws_id, None)
            room.users.pop(ws_id, None)
    for vr in voice_rooms.values():
        dead = []
        for ws_id, ws_ in vr.connections.items():
            try:
                await ws_.send_text(data)
            except Exception:
                dead.append(ws_id)
        for ws_id in dead:
            _cleanup_voice_user(vr, ws_id)


def _cleanup_voice_user(vr: VoiceRoom, ws_id: str):
    vr.connections.pop(ws_id, None)
    vr.users.pop(ws_id, None)
    vr.muted.pop(ws_id, None)
    vr.deafened.pop(ws_id, None)
    vr.speaking.pop(ws_id, None)
    vr.streaming.pop(ws_id, None)


async def voice_broadcast(vr: VoiceRoom, message: dict, exclude: str | None = None):
    data = json.dumps(message)
    dead = []
    for pid, pws in vr.connections.items():
        if pid == exclude:
            continue
        try:
            await pws.send_text(data)
        except Exception:
            dead.append(pid)
    for ws_id in dead:
        _cleanup_voice_user(vr, ws_id)


def check_ws_origin(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin", "")
    if not origin:
        return True  # non-browser clients
    return any(origin == o for o in ALLOWED_ORIGINS)


# ── Text Chat Manager ─────────────────────────────────────

class ConnectionManager:
    async def connect(self, websocket: WebSocket, room_name: str, username: str) -> str:
        await websocket.accept()
        ws_id = str(uuid.uuid4())
        if room_name not in rooms:
            rooms[room_name] = Room(room_name)
        room = rooms[room_name]
        if len(room.connections) >= MAX_CONNECTIONS_PER_ROOM:
            await websocket.close(code=1008, reason="Sala llena")
            raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)
        room.connections[ws_id] = websocket
        room.users[ws_id] = username
        await self.broadcast(room_name, {
            "type": "system",
            "content": f"{username} se ha unido a #{room_name}",
            "timestamp": datetime.now().isoformat(),
        })
        await broadcast_all_rooms()
        return ws_id

    async def disconnect(self, ws_id: str, room_name: str):
        room = rooms.get(room_name)
        if not room:
            return
        username = room.users.pop(ws_id, "Unknown")
        room.connections.pop(ws_id, None)
        await self.broadcast(room_name, {
            "type": "system",
            "content": f"{username} ha salido de #{room_name}",
            "timestamp": datetime.now().isoformat(),
        })
        await broadcast_all_rooms()

    async def broadcast(self, room_name: str, message: dict):
        room = rooms.get(room_name)
        if not room:
            return
        room.messages.append(message)
        if len(room.messages) > 100:
            room.messages = room.messages[-100:]
        data = json.dumps(message)
        dead = []
        for ws_id, ws_ in room.connections.items():
            try:
                await ws_.send_text(data)
            except Exception:
                dead.append(ws_id)
        for ws_id in dead:
            room.connections.pop(ws_id, None)
            room.users.pop(ws_id, None)


manager = ConnectionManager()


# ── REST API ───────────────────────────────────────────────

@app.get("/api/rooms")
async def get_rooms():
    return all_rooms_list()


@app.get("/api/rooms/{room_name}/messages")
async def get_messages(room_name: str):
    room = rooms.get(room_name)
    if not room:
        return []
    return room.messages


class RoomCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=MAX_ROOM_NAME_LEN)
    description: str = Field("", max_length=100)
    type: str = Field("text", pattern="^(text|voice)$")


@app.post("/api/rooms")
async def create_room(data: RoomCreate):
    try:
        name = sanitize_room_name(data.name)
    except ValueError as e:
        return {"error": str(e)}

    if data.type == "voice":
        if len(voice_rooms) >= MAX_VOICE_ROOMS:
            return {"error": "Limite de salas de voz alcanzado"}
        if name not in voice_rooms:
            voice_rooms[name] = VoiceRoom(name, data.description[:100])
        return voice_rooms[name].to_dict()
    else:
        if len(rooms) >= MAX_ROOMS:
            return {"error": "Limite de salas de texto alcanzado"}
        if name not in rooms:
            rooms[name] = Room(name, data.description[:100])
        return rooms[name].to_dict()


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Text WebSocket ─────────────────────────────────────────

@app.websocket("/ws/{room_name}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_name: str, username: str):
    if not check_ws_origin(websocket):
        await websocket.close(code=1008)
        return

    try:
        username = validate_username(username)
    except ValueError:
        await websocket.close(code=1008, reason="Username invalido")
        return

    if room_name not in rooms:
        try:
            room_name = sanitize_room_name(room_name)
        except ValueError:
            await websocket.close(code=1008, reason="Nombre de sala invalido")
            return
        if len(rooms) >= MAX_ROOMS:
            await websocket.close(code=1008, reason="Limite de salas alcanzado")
            return
        rooms[room_name] = Room(room_name)

    ws_id = await manager.connect(websocket, room_name, username)
    try:
        while True:
            data = await websocket.receive_text()
            # Rate limit
            if not rate_limiter.check(ws_id):
                continue
            # Size limit
            if len(data) > MAX_MSG_LEN:
                data = data[:MAX_MSG_LEN]
            data = data.strip()
            if not data:
                continue
            message = {
                "type": "message",
                "username": username,
                "content": data,
                "timestamp": datetime.now().isoformat(),
            }
            await manager.broadcast(room_name, message)
    except WebSocketDisconnect:
        await manager.disconnect(ws_id, room_name)


# ── Voice Signaling WebSocket ──────────────────────────────

@app.websocket("/ws/voice/{room_name}/{username}")
async def voice_websocket(websocket: WebSocket, room_name: str, username: str):
    if not check_ws_origin(websocket):
        await websocket.close(code=1008)
        return

    try:
        username = validate_username(username)
    except ValueError:
        await websocket.close(code=1008, reason="Username invalido")
        return

    await websocket.accept()
    ws_id = str(uuid.uuid4())

    if room_name not in voice_rooms:
        try:
            room_name = sanitize_room_name(room_name)
        except ValueError:
            await websocket.send_text(json.dumps({"type": "error", "message": "Nombre invalido"}))
            await websocket.close()
            return
        if len(voice_rooms) >= MAX_VOICE_ROOMS:
            await websocket.send_text(json.dumps({"type": "error", "message": "Limite de salas alcanzado"}))
            await websocket.close()
            return
        voice_rooms[room_name] = VoiceRoom(room_name)

    vr = voice_rooms[room_name]

    if vr.user_limit > 0 and len(vr.users) >= vr.user_limit:
        await websocket.send_text(json.dumps({"type": "error", "message": "Canal lleno"}))
        await websocket.close()
        return

    if len(vr.connections) >= MAX_CONNECTIONS_PER_ROOM:
        await websocket.send_text(json.dumps({"type": "error", "message": "Canal lleno"}))
        await websocket.close()
        return

    # Send existing peers
    existing_peers = []
    for pid, puname in vr.users.items():
        existing_peers.append({
            "ws_id": pid,
            "username": puname,
            "muted": vr.muted.get(pid, False),
            "deafened": vr.deafened.get(pid, False),
            "speaking": vr.speaking.get(pid, False),
            "streaming": vr.streaming.get(pid, False),
        })

    await websocket.send_text(json.dumps({
        "type": "voice_peers",
        "peers": existing_peers,
        "your_id": ws_id,
    }))

    vr.connections[ws_id] = websocket
    vr.users[ws_id] = username
    vr.muted[ws_id] = False
    vr.deafened[ws_id] = False
    vr.speaking[ws_id] = False
    vr.streaming[ws_id] = False

    await voice_broadcast(vr, {
        "type": "voice_peer_joined",
        "ws_id": ws_id,
        "username": username,
    }, exclude=ws_id)

    await broadcast_all_rooms()

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_WS_MSG_SIZE:
                continue
            if not rate_limiter.check(ws_id):
                continue

            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "offer":
                target = data.get("target")
                if target in vr.connections and "offer" in data:
                    await vr.connections[target].send_text(json.dumps({
                        "type": "offer",
                        "offer": data["offer"],
                        "from_id": ws_id,
                        "from_username": username,
                    }))

            elif msg_type == "answer":
                target = data.get("target")
                if target in vr.connections and "answer" in data:
                    await vr.connections[target].send_text(json.dumps({
                        "type": "answer",
                        "answer": data["answer"],
                        "from_id": ws_id,
                    }))

            elif msg_type == "ice_candidate":
                target = data.get("target")
                if target in vr.connections and "candidate" in data:
                    await vr.connections[target].send_text(json.dumps({
                        "type": "ice_candidate",
                        "candidate": data["candidate"],
                        "from_id": ws_id,
                    }))

            elif msg_type == "mute_toggle":
                vr.muted[ws_id] = bool(data.get("muted", False))
                await voice_broadcast(vr, {
                    "type": "peer_state_changed",
                    "ws_id": ws_id,
                    "username": username,
                    "muted": vr.muted[ws_id],
                    "deafened": vr.deafened.get(ws_id, False),
                    "speaking": vr.speaking.get(ws_id, False),
                    "streaming": vr.streaming.get(ws_id, False),
                })
                await broadcast_all_rooms()

            elif msg_type == "deafen_toggle":
                vr.deafened[ws_id] = bool(data.get("deafened", False))
                if vr.deafened[ws_id]:
                    vr.muted[ws_id] = True
                await voice_broadcast(vr, {
                    "type": "peer_state_changed",
                    "ws_id": ws_id,
                    "username": username,
                    "muted": vr.muted[ws_id],
                    "deafened": vr.deafened[ws_id],
                    "speaking": False,
                    "streaming": vr.streaming.get(ws_id, False),
                })
                await broadcast_all_rooms()

            elif msg_type == "speaking":
                vr.speaking[ws_id] = bool(data.get("speaking", False))
                await voice_broadcast(vr, {
                    "type": "peer_speaking",
                    "ws_id": ws_id,
                    "speaking": vr.speaking[ws_id],
                }, exclude=ws_id)

            elif msg_type == "screen_share_start":
                vr.streaming[ws_id] = True
                await voice_broadcast(vr, {
                    "type": "peer_screen_share",
                    "ws_id": ws_id,
                    "username": username,
                    "streaming": True,
                })
                await broadcast_all_rooms()

            elif msg_type == "screen_share_stop":
                vr.streaming[ws_id] = False
                await voice_broadcast(vr, {
                    "type": "peer_screen_share",
                    "ws_id": ws_id,
                    "username": username,
                    "streaming": False,
                })
                await broadcast_all_rooms()

            elif msg_type == "screen_offer":
                target = data.get("target")
                if target in vr.connections and "offer" in data:
                    await vr.connections[target].send_text(json.dumps({
                        "type": "screen_offer",
                        "offer": data["offer"],
                        "from_id": ws_id,
                        "from_username": username,
                    }))

            elif msg_type == "screen_answer":
                target = data.get("target")
                if target in vr.connections and "answer" in data:
                    await vr.connections[target].send_text(json.dumps({
                        "type": "screen_answer",
                        "answer": data["answer"],
                        "from_id": ws_id,
                    }))

            elif msg_type == "screen_ice_candidate":
                target = data.get("target")
                if target in vr.connections and "candidate" in data:
                    await vr.connections[target].send_text(json.dumps({
                        "type": "screen_ice_candidate",
                        "candidate": data["candidate"],
                        "from_id": ws_id,
                    }))

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({
                    "type": "pong",
                    "timestamp": data.get("timestamp", 0),
                }))

    except (WebSocketDisconnect, Exception):
        _cleanup_voice_user(vr, ws_id)

        await voice_broadcast(vr, {
            "type": "voice_peer_left",
            "ws_id": ws_id,
            "username": username,
        })

        await broadcast_all_rooms()
