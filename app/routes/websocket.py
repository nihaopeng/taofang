from starlette.websockets import WebSocket, WebSocketDisconnect
import json
import uuid
from datetime import datetime
from app.database import save_canvas_drawing, get_canvas_drawings, clear_canvas_drawings, get_canvas_stats

# Store active connections with user info
active_connections = {}  # websocket: {"user_id": id, "user_name": name}
game_handlers = {}

class GameWebSocketHandler:
    """Enhanced WebSocket handler for interactive games"""
    
    def __init__(self):
        self.canvas_sessions = {}
        self.pong_sessions = {}
        self.user_sockets = {}  # user_id: websocket
    
    async def handle_message(self, websocket, message, user_info):
        """Handle all game messages"""
        message_type = message.get("type")
        user_id = user_info.get("user_id")
        
        if message_type.startswith("canvas_"):
            await self.handle_canvas_message(websocket, message, user_id, user_info)
        elif message_type.startswith("pong_"):
            await self.handle_pong_message(websocket, message, user_id, user_info)
        elif message_type == "mood_update":
            await self.handle_mood_message(websocket, message, user_info)
        elif message_type == "ping":
            await websocket.send_json({"type": "pong", "timestamp": datetime.now().isoformat()})
    
    async def handle_canvas_message(self, websocket, message, user_id, user_info):
        """Handle canvas drawing messages"""
        message_type = message.get("type")
        session_id = message.get("session_id", "default_canvas")
        user_name = user_info.get("user_name", "User")
        
        if message_type == "canvas_join":
            # Join or create canvas session
            if session_id not in self.canvas_sessions:
                self.canvas_sessions[session_id] = {
                    "users": {},
                    "created_at": datetime.now().isoformat()
                }
            
            self.canvas_sessions[session_id]["users"][user_id] = {
                "name": user_name,
                "joined_at": datetime.now().isoformat(),
                "color": message.get("color", "#ff6b6b")
            }
            
            # Store user's socket for this session
            self.user_sockets[user_id] = websocket
            
            # Get existing drawings from database
            existing_drawings = get_canvas_drawings(session_id, limit=1000)
            
            # Get canvas statistics
            canvas_stats = get_canvas_stats(session_id)
            
            # Send join confirmation with existing drawings
            await websocket.send_json({
                "type": "canvas_joined",
                "session_id": session_id,
                "user_count": len(self.canvas_sessions[session_id]["users"]),
                "users": list(self.canvas_sessions[session_id]["users"].values()),
                "existing_drawings": existing_drawings,
                "your_color": self.canvas_sessions[session_id]["users"][user_id]["color"],
                "canvas_stats": canvas_stats
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
            # Save drawing to database
            drawing_data = {
                "from_x": message.get("from_x"),
                "from_y": message.get("from_y"),
                "to_x": message.get("to_x"),
                "to_y": message.get("to_y"),
                "color": message.get("color"),
                "brush_size": message.get("brush_size")
            }
            
            # Validate drawing data
            if all(key in drawing_data for key in ["from_x", "from_y", "to_x", "to_y", "color", "brush_size"]):
                try:
                    # Save to database
                    save_canvas_drawing(
                        session_id=session_id,
                        user_id=user_id,
                        user_name=user_name,
                        from_x=drawing_data["from_x"],
                        from_y=drawing_data["from_y"],
                        to_x=drawing_data["to_x"],
                        to_y=drawing_data["to_y"],
                        color=drawing_data["color"],
                        brush_size=drawing_data["brush_size"]
                    )
                    
                    # Forward drawing to other users in the session
                    if session_id in self.canvas_sessions:
                        for uid in self.canvas_sessions[session_id]["users"]:
                            if uid != user_id and uid in self.user_sockets:
                                 try:
                                     await self.user_sockets[uid].send_json(message)
                                 except:
                                     pass
                    
                    print(f"Saved canvas drawing for session {session_id} by user {user_name}")
                except Exception as e:
                    print(f"Error saving canvas drawing: {e}")
                    await websocket.send_json({
                        "type": "error",
                        "message": f"保存绘画失败: {str(e)}"
                    })
            else:
                print(f"Invalid canvas drawing data: {drawing_data}")
        
        elif message_type == "canvas_clear":
            # Clear canvas drawings from database
            try:
                deleted_count = clear_canvas_drawings(session_id)
                
                # Notify all users in session
                if session_id in self.canvas_sessions:
                    for uid in self.canvas_sessions[session_id]["users"]:
                         if uid in self.user_sockets:
                             try:
                                 await self.user_sockets[uid].send_json({
                                     "type": "canvas_cleared",
                                     "session_id": session_id,
                                     "by_user": user_name,
                                     "deleted_count": deleted_count
                                 })
                             except:
                                 pass
                
                print(f"Cleared {deleted_count} drawings from session {session_id} by user {user_name}")
            except Exception as e:
                print(f"Error clearing canvas drawings: {e}")
                await websocket.send_json({
                    "type": "error",
                    "message": f"清空画板失败: {str(e)}"
                })
        
        elif message_type == "canvas_leave":
            # Leave canvas session
            if session_id in self.canvas_sessions and user_id in self.canvas_sessions[session_id]["users"]:
                del self.canvas_sessions[session_id]["users"][user_id]
                
                # Notify other users
                for uid in self.canvas_sessions[session_id]["users"]:
                         if uid in self.user_sockets:
                             try:
                                 await self.user_sockets[uid].send_json({
                                     "type": "canvas_user_left",
                                     "session_id": session_id,
                                     "user_name": user_name,
                                     "user_count": len(self.canvas_sessions[session_id]["users"])
                                 })
                             except:
                                 pass
    
    async def handle_pong_message(self, websocket, message, user_id, user_info):
        """Handle ping pong game messages"""
        message_type = message.get("type")
        
        if message_type == "pong_join":
            # Join or create ping pong session
            session_id = message.get("session_id", "ping_pong_default")
            is_player1 = message.get("is_player1", False)
            
            if session_id not in self.pong_sessions:
                self.pong_sessions[session_id] = {
                    "users": {},
                    "created_at": datetime.now().isoformat()
                }
            
            self.pong_sessions[session_id]["users"][user_id] = {
                "name": user_info.get("user_name", "User"),
                "joined_at": datetime.now().isoformat(),
                "color": message.get("color", "#ff6b6b"),
                "is_player1": is_player1
            }
            
            # Store user's socket for this session
            self.user_sockets[user_id] = websocket
            
            # Send join confirmation
            await websocket.send_json({
                "type": "pong_joined",
                "session_id": session_id,
                "user_count": len(self.pong_sessions[session_id]["users"]),
                "users": list(self.pong_sessions[session_id]["users"].values()),
                "your_role": "player1" if is_player1 else "player2"
            })
            
            # Notify other users in the session
            for uid, user_data in self.pong_sessions[session_id]["users"].items():
                if uid != user_id and uid in self.user_sockets:
                    try:
                        await self.user_sockets[uid].send_json({
                            "type": "pong_users_update",
                            "session_id": session_id,
                            "users": self.pong_sessions[session_id]["users"],
                            "new_user": self.pong_sessions[session_id]["users"][user_id]
                        })
                    except:
                        pass
        
        elif message_type in ["pong_key", "pong_serve", "pong_collision", "pong_score", 
                            "pong_game_start", "pong_game_pause", "pong_game_reset", "pong_game_over"]:
            # Forward game messages to other users in the session
            session_id = message.get("session_id")
            if session_id in self.pong_sessions:
                for uid in self.pong_sessions[session_id]["users"]:
                    if uid != user_id and uid in self.user_sockets:
                        try:
                            await self.user_sockets[uid].send_json(message)
                        except:
                            pass
        
        elif message_type == "pong_leave":
            # Leave ping pong session
            session_id = message.get("session_id")
            if session_id in self.pong_sessions and user_id in self.pong_sessions[session_id]["users"]:
                del self.pong_sessions[session_id]["users"][user_id]
                
                # Notify other users
                for uid in self.pong_sessions[session_id]["users"]:
                    if uid in self.user_sockets:
                        try:
                            await self.user_sockets[uid].send_json({
                                "type": "pong_user_left",
                                "session_id": session_id,
                                "user_name": user_info.get("user_name", "User"),
                                "user_count": len(self.pong_sessions[session_id]["users"])
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