from starlette.responses import RedirectResponse
from starlette.requests import Request
from ..database import get_connection, get_recent_achievements, get_farm_currency
from ..utils.notifications import get_all_notifications, create_notification_display
from datetime import datetime

async def placeholder(request: Request):
    """Placeholder page for future features"""
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/gate", status_code=303)
    user_name = request.session.get("user_name")
    html = f"""<!DOCTYPE html><html lang="zh-CN"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>建设中 - 心动坐标</title>
    <style>
        *{{margin:0;padding:0;box-sizing:border-box;}}
        body{{font-family:Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px;}}
        .card{{background:rgba(255,255,255,0.95);border-radius:20px;padding:60px 40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.1);max-width:400px;width:100%;}}
        .icon{{font-size:80px;margin-bottom:20px;animation:float 3s ease-in-out infinite;}}
        h1{{font-size:28px;color:#333;margin-bottom:15px;}}
        p{{color:#666;margin-bottom:25px;line-height:1.6;font-size:15px;}}
        .btn{{display:inline-block;padding:12px 30px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border-radius:25px;text-decoration:none;font-weight:bold;transition:all 0.3s;}}
        .btn:hover{{transform:translateY(-2px);box-shadow:0 5px 15px rgba(102,126,234,0.4);}}
        @keyframes float{{0%,100%{{transform:translateY(0);}}50%{{transform:translateY(-15px);}}}}
    </style></head><body>
    <div class="card">
        <div class="icon">🚧</div>
        <h1>🌾 心动农场</h1>
        <p>亲爱的 {user_name}，<br>农场正在建设中，敬请期待～<br>很快就可以一起种田啦！</p>
        <a href="/" class="btn">返回首页</a>
    </div></body></html>"""
    from starlette.responses import Response
    return Response(html, media_type="text/html")

async def home(request: Request):
    """Main dashboard page"""
    # Check authentication
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/gate", status_code=303)
    
    # Get user info
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    # Get love counter data
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get anniversary date
    cursor.execute("SELECT value FROM meta_config WHERE key = 'anniversary_date'")
    anniversary_row = cursor.fetchone()
    anniversary_date = datetime.strptime(anniversary_row[0], "%Y-%m-%d") if anniversary_row else datetime.now()
    
    # Calculate days together
    today = datetime.now()
    days_together = (today - anniversary_date).days
    
    # Get recent achievements with icons and descriptions
    recent_achievements = get_recent_achievements(user_id, limit=4)
    
    conn.close()
    
    # Get notifications
    notifications = get_all_notifications(user_id)
    notifications_html = create_notification_display(notifications)
    
    # Prepare context
    try:
        farm_coins, _ = get_farm_currency(user_id)
    except:
        farm_coins = 0
    
    context = {
        "request": request,
        "user_name": user_name,
        "days_together": days_together,
        "anniversary_date": anniversary_date.strftime("%Y-%m-%d"),
        "recent_achievements": recent_achievements,
        "notifications_html": notifications_html,
        "has_notifications": len(notifications) > 0,
        "farm_coins": farm_coins,
    }
    
    return request.app.templates.TemplateResponse("dashboard.html", context)