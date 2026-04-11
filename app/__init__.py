from starlette.applications import Starlette
from starlette.routing import Route, Mount, WebSocketRoute
from starlette.responses import RedirectResponse
from starlette.staticfiles import StaticFiles
from starlette.middleware import Middleware
from starlette.middleware.sessions import SessionMiddleware
from jinja2 import Environment, FileSystemLoader
from starlette.templating import Jinja2Templates
from starlette.routing import Route, Mount
from starlette.responses import JSONResponse, RedirectResponse
from starlette.exceptions import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware
import os

from .database import init_db
from .routes import auth, dashboard, api, websocket, games

async def not_found(request, exc):
    """Custom 404 handler that redirects to gate"""
    return RedirectResponse(url="/gate")

async def server_error(request, exc):
    """Custom 500 handler"""
    return JSONResponse(
        {"error": "服务器内部错误", "success": False},
        status_code=500
    )

class AuthenticationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        # 跳过不需要校验的路径
        if request.url.path in ["/gate", "/login", "/logout"] or \
           request.url.path.startswith("/static") or \
           request.url.path.startswith("/api/") or \
           request.url.path == "/ws":
            return await call_next(request)
        
        # 此时 SessionMiddleware 已经在它外层运行过了，这里可以安全访问
        if not request.session.get("authenticated"):
            return RedirectResponse(url="/gate", status_code=303)
        
        return await call_next(request)

def create_app():
    # Initialize database
    init_db()
    
    # Configure middleware
    middleware = [
        Middleware(SessionMiddleware, secret_key=os.getenv("SECRET_KEY", "hello fang fang"),same_site="lax",https_only=False, max_age=30*24*60*60),
        Middleware(AuthenticationMiddleware),
    ]
    
    # Create app with error handlers
    app = Starlette(
        debug=os.getenv("DEBUG", "False").lower() == "true",
        routes=[
            Route("/", dashboard.home, name="home"),
            Route("/gate", auth.gate, name="gate"),
            Route("/login", auth.login, methods=["POST"], name="login"),
            Route("/logout", auth.logout, name="logout"),
            Route("/api/love-counter", api.get_love_counter, name="love_counter"),
            Route("/api/checkin", api.checkin, methods=["POST"], name="checkin"),
            Route("/api/achievements", api.get_achievements, name="achievements"),
            Route("/api/streak", api.get_streak_info, name="streak_info"),
            Route("/api/checkin-stats", api.get_checkin_statistics, name="checkin_stats"),
            Route("/api/checkin-calendar", api.get_checkin_calendar_data, name="checkin_calendar"),
            Route("/api/checkin-insights", api.get_checkin_insights, name="checkin_insights"),
            Route("/games", games.games_dashboard, name="games_dashboard"),
            Route("/game/canvas", games.canvas_game, name="canvas_game"),
            Route("/game/mobile-test", games.mobile_test, name="mobile_test"),
            Route("/game/canvas-simple", games.canvas_simple, name="canvas_simple"),

            WebSocketRoute("/ws", websocket.websocket_endpoint, name="websocket"),
            Mount("/static", app=StaticFiles(directory="app/static"), name="static"),
        ],
        middleware=middleware,
        exception_handlers={
            404: not_found,
            500: server_error,
        }
    )
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # 生产环境请替换为具体的域名
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # app.add_middleware(
    #     TrustedHostMiddleware, 
    #     allowed_hosts=["127.0.0.1", "localhost", "202.199.13.66"]
    # )

    # Add templates to app state
    app.templates = Jinja2Templates(directory="app/templates")

    # Add security headers middleware
    @app.middleware("http")
    async def security_headers_middleware(request, call_next):
        response = await call_next(request)
        
        # Add security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        
        # Only add CSP in production
        if not app.debug:
            response.headers["Content-Security-Policy"] = \
                "default-src 'self'; " \
                "script-src 'self' 'unsafe-inline'; " \
                "style-src 'self' 'unsafe-inline'; " \
                "img-src 'self' data:; " \
                "connect-src 'self' ws: wss:;"
        
        return response
    
    return app