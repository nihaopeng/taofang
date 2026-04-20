from starlette.responses import RedirectResponse
from starlette.requests import Request
from ..database import get_connection, get_recent_achievements
from ..utils.notifications import get_all_notifications, create_notification_display
from datetime import datetime

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
    context = {
        "request": request,
        "user_name": user_name,
        "days_together": days_together,
        "anniversary_date": anniversary_date.strftime("%Y-%m-%d"),
        "recent_achievements": recent_achievements,
        "notifications_html": notifications_html,
        "has_notifications": len(notifications) > 0,
    }
    
    return request.app.templates.TemplateResponse("dashboard.html", context)