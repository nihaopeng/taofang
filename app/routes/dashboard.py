from starlette.responses import RedirectResponse
from starlette.requests import Request
from ..database import get_connection, get_user_streak, get_longest_streak, get_checkin_stats
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
    
    # Get check-in status for today
    cursor.execute("""
    SELECT COUNT(*) FROM daily_checkin 
    WHERE user_id = ? AND DATE(checkin_time) = DATE('now')
    """, (user_id,))
    checked_in_today = cursor.fetchone()[0] > 0
    
    # Get both users' check-in status for today
    cursor.execute("""
    SELECT user_id FROM daily_checkin 
    WHERE DATE(checkin_time) = DATE('now')
    """)
    today_checkins = [row[0] for row in cursor.fetchall()]
    both_checked_in = len(today_checkins) >= 2
    
    # Get achievements
    cursor.execute("""
    SELECT ach_name, unlock_date FROM achievements 
    WHERE user_id = ? ORDER BY unlock_date DESC
    """, (user_id,))
    achievements = cursor.fetchall()
    
    conn.close()
    
    # Get streak information
    current_streak = get_user_streak(user_id)
    longest_streak = get_longest_streak(user_id)
    checkin_stats = get_checkin_stats(user_id)
    
    # Get notifications
    notifications = get_all_notifications(user_id)
    notifications_html = create_notification_display(notifications)
    
    # Prepare context
    context = {
        "request": request,
        "user_name": user_name,
        "days_together": days_together,
        "anniversary_date": anniversary_date.strftime("%Y-%m-%d"),
        "checked_in_today": checked_in_today,
        "both_checked_in": both_checked_in,
        "achievements": achievements,
        "today": today.strftime("%Y-%m-%d"),
        "current_streak": current_streak,
        "longest_streak": longest_streak,
        "total_checkins": checkin_stats["total_checkins"],
        "total_both_checkins": checkin_stats["total_both_checkins"],
        "monthly_stats": checkin_stats["monthly_stats"],
        "notifications_html": notifications_html,
        "has_notifications": len(notifications) > 0,
    }
    
    return request.app.templates.TemplateResponse("dashboard.html", context)