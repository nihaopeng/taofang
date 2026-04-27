from starlette.websockets import WebSocket, WebSocketDisconnect
import json
from datetime import datetime

active_connections = {}  # websocket: {"user_id": id, "user_name": name}

async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    user_info = None
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
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
            
            if not user_info:
                await websocket.send_json({
                    "type": "error",
                    "message": "请先认证"
                })
                continue
            
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong", "timestamp": datetime.now().isoformat()})
            elif message.get("type") == "mood_update":
                for ws, info in list(active_connections.items()):
                    if ws != websocket:
                        try:
                            await ws.send_json({
                                "type": "mood_sync",
                                "mood": message.get("mood"),
                                "user": user_info.get("user_name"),
                                "timestamp": datetime.now().isoformat()
                            })
                        except:
                            pass
    
    except WebSocketDisconnect:
        if websocket in active_connections:
            del active_connections[websocket]
    
    except Exception as e:
        print(f"WebSocket error: {e}")
