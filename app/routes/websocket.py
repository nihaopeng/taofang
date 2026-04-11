from starlette.websockets import WebSocket, WebSocketDisconnect
import json
import uuid
from datetime import datetime

# Store active connections with user info
active_connections = {}  # websocket: {"user_id": id, "user_name": name}
game_handlers = {}

class GameWebSocketHandler:
    """Enhanced WebSocket handler for interactive games"""
    
    def __init__(self):
        self.canvas_sessions = {}
        self.user_sockets = {}  # user_id: websocket
    
    async def handle_message(self, websocket, message, user_info):
        """Handle all game messages"""
        message_type = message.get("type")
        user_id = user_info.get("user_id")
        
        if message_type.startswith("canvas_"):
            await self.handle_canvas_message(websocket, message, user_id, user_info)
        elif message_type == "mood_update":
            await self.handle_mood_message(websocket, message, user_info)
        elif message_type == "ping":
            await websocket.send_json({"type": "pong", "timestamp": datetime.now().isoformat()})
    
    async def handle_canvas_message(self, websocket, message, user_id, user_info):
        """Handle canvas drawing messages"""
        message_type = message.get("type")
        
        if message_type == "canvas_join":
            # Join or create canvas session
            session_id = message.get("session_id", "default_canvas")
            if session_id not in self.canvas_sessions:
                self.canvas_sessions[session_id] = {
                    "users": {},
                    "drawings": [],
                    "created_at": datetime.now().isoformat()
                }
            
            self.canvas_sessions[session_id]["users"][user_id] = {
                "name": user_info.get("user_name", "User"),
                "joined_at": datetime.now().isoformat(),
                "color": message.get("color", "#ff6b6b")
            }
            
            # Store user's socket for this session
            self.user_sockets[user_id] = websocket
            
            # Send join confirmation with existing drawings
            await websocket.send_json({
                "type": "canvas_joined",
                "session_id": session_id,
                "user_count": len(self.canvas_sessions[session_id]["users"]),
                "users": list(self.canvas_sessions[session_id]["users"].values()),
                "existing_drawings": self.canvas_sessions[session_id]["drawings"][-100:],  # Last 100 drawings
                "your_color": self.canvas_sessions[session_id]["users"][user_id]["color"]
            })
            
            # Notify other users in the session
            for uid, user_data in self.canvas_sessions[session_id]["users"].items():
                if uid != user_id and uid in self.user_sockets:
                    try:
                        await self.user_sockets[uid].send_json({
                            "type": "canvas_user_joined",
                            "session_id": session_id,
                            "user": self.canvas_sessions[session_id]["users"][user_id],
                            "user_count": len(self.canvas_sessions[session_id]["users"])
                        })
                    except:
                        pass
        
        elif message_type == "canvas_draw":
            session_id = message.get("session_id")
            if session_id in self.canvas_sessions:
                # 简单粗暴：直接把收到的整个 message 转发给所有人
                for uid, ws_conn in self.user_sockets.items():
                    if uid != user_id:
                        try:
                            await ws_conn.send_json(message)
                        except:
                            pass
        
        elif message_type == "canvas_clear":
            # Clear canvas
            session_id = message.get("session_id")
            if session_id in self.canvas_sessions:
                self.canvas_sessions[session_id]["drawings"] = []
                
                # Notify all users in session
                for uid in self.canvas_sessions[session_id]["users"]:
                    if uid in self.user_sockets:
                        try:
                            await self.user_sockets[uid].send_json({
                                "type": "canvas_cleared",
                                "session_id": session_id,
                                "by_user": user_info.get("user_name", "User")
                            })
                        except:
                            pass
        
        elif message_type == "canvas_leave":
            # Leave canvas session
            session_id = message.get("session_id")
            if session_id in self.canvas_sessions and user_id in self.canvas_sessions[session_id]["users"]:
                del self.canvas_sessions[session_id]["users"][user_id]
                
                # Notify other users
                for uid in self.canvas_sessions[session_id]["users"]:
                    if uid in self.user_sockets:
                        try:
                            await self.user_sockets[uid].send_json({
                                "type": "canvas_user_left",
                                "session_id": session_id,
                                "user_name": user_info.get("user_name", "User"),
                                "user_count": len(self.canvas_sessions[session_id]["users"])
                            })
                        except:
                            pass

    
    async def handle_mood_message(self, websocket, message, user_info):
        """Handle mood sync messages"""
        mood = message.get("mood")
        user_name = user_info.get("user_name", "User")
        
        # Broadcast mood to all other connected users
        for uid, ws in list(self.user_sockets.items()):
            if ws != websocket:
                try:
                    await ws.send_json({
                        "type": "mood_sync",
                        "mood": mood,
                        "user": user_name,
                        "timestamp": datetime.now().isoformat()
                    })
                except:
                    pass

game_handler = GameWebSocketHandler()

async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print(f"connected info")
    user_info = None
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # Handle authentication
            if message.get("type") == "auth":
                user_info = {
                    "user_id": message.get("user_id"),
                    "user_name": message.get("user_name")
                }
                active_connections[websocket] = user_info
                await websocket.send_json({
                    "type": "auth_success",
                    "message": "WebSocket认证成功"
                })
                continue
            
            # Require authentication for other messages
            if not user_info:
                await websocket.send_json({
                    "type": "error",
                    "message": "请先认证"
                })
                continue
            
            # Handle game messages
            await game_handler.handle_message(websocket, message, user_info)
    
    except WebSocketDisconnect:
        print(f"WebSocketDisconnect:{str(WebSocketDisconnect)}")
        # Clean up
        if websocket in active_connections:
            del active_connections[websocket]
        
        # Remove from game_handler's user sockets
        if user_info and user_info.get("user_id") in game_handler.user_sockets:
            uid = user_info.get("user_id")
            # 从全局实例中移除
            if uid in game_handler.user_sockets:
                del game_handler.user_sockets[uid]

    
    except Exception as e:
        print(f"WebSocket error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": f"服务器错误: {str(e)}"
            })
        except:
            pass