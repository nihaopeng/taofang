"""
Interactive games module for HeartSync - Canvas Sync only
"""

from starlette.responses import JSONResponse, HTMLResponse
from starlette.requests import Request

async def games_dashboard(request: Request):
    """Games dashboard page - Canvas Sync only"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    context = {
        "request": request,
        "user_name": user_name,
        "games": [
            {"id": "canvas", "name": "同步画板", "description": "一起涂鸦创作", "icon": "🎨"},
            {"id": "tank", "name": "双人坦克大战", "description": "实时对战游戏", "icon": "🎮"},
        ]
    }
    
    return request.app.templates.TemplateResponse("games.html", context)

async def canvas_game(request: Request):
    """Canvas Sync game page - NEW VERSION based on mobile_test"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    context = {
        "request": request,
        "user_name": user_name,
        "user_id": user_id,
    }
    
    return request.app.templates.TemplateResponse("canvas_new.html", context)

async def mobile_test(request: Request):
    """Mobile touch test page"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    context = {
        "request": request,
    }
    
    return request.app.templates.TemplateResponse("mobile_test.html", context)

async def canvas_simple(request: Request):
    """Simplified canvas test page"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    context = {
        "request": request,
    }
    
    return request.app.templates.TemplateResponse("canvas_simple.html", context)

async def tank_battle(request: Request):
    """Tank Battle game page"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    context = {
        "request": request,
        "user_name": user_name,
        "user_id": user_id,
    }
    
    return request.app.templates.TemplateResponse("tank_battle.html", context)