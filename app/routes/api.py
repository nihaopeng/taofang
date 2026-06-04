from starlette.responses import JSONResponse
from starlette.requests import Request
from ..database import get_connection
from datetime import datetime
import json

async def get_love_counter(request: Request):
    """API endpoint for love counter data"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get anniversary date
    cursor.execute("SELECT value FROM meta_config WHERE key = 'anniversary_date'")
    anniversary_row = cursor.fetchone()
    
    if not anniversary_row:
        conn.close()
        return JSONResponse({"error": "Anniversary date not set"}, status_code=500)
    
    anniversary_date = datetime.strptime(anniversary_row[0], "%Y-%m-%d")
    today = datetime.now()
    
    # Calculate time difference
    delta = today - anniversary_date
    
    # Calculate years, months, days
    years = delta.days // 365
    months = (delta.days % 365) // 30
    days = delta.days % 30
    
    # Calculate hours, minutes, seconds
    hours = delta.seconds // 3600
    minutes = (delta.seconds % 3600) // 60
    seconds = delta.seconds % 60
    
    conn.close()
    
    return JSONResponse({
        "days": delta.days,
        "years": years,
        "months": months,
        "days_remaining": days,
        "hours": hours,
        "minutes": minutes,
        "seconds": seconds,
        "total_seconds": int(delta.total_seconds()),
        "anniversary_date": anniversary_date.strftime("%Y-%m-%d"),
    })

async def checkin(request: Request):
    """Handle daily check-in"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    conn = get_connection()
    cursor = conn.cursor()
    
    # Check if already checked in today
    cursor.execute("""
    SELECT COUNT(*) FROM daily_checkin 
    WHERE user_id = ? AND DATE(checkin_time) = DATE('now')
    """, (user_id,))
    
    if cursor.fetchone()[0] > 0:
        conn.close()
        return JSONResponse({"error": "Already checked in today", "success": False}, status_code=400)
    
    # Record check-in
    cursor.execute("INSERT INTO daily_checkin (user_id) VALUES (?)", (user_id,))
    
    # Award points for check-in
    points = 10  # Base points for daily check-in
    
    # Bonus for streak
    from ..database import get_user_streak
    current_streak = get_user_streak(user_id)
    if current_streak >= 7:
        points += 20  # Weekly streak bonus
    elif current_streak >= 30:
        points += 50  # Monthly streak bonus
    
    # Update user points
    cursor.execute("UPDATE users SET points = points + ? WHERE id = ?", (points, user_id))
    
    # Check if both users have checked in today
    cursor.execute("""
    SELECT COUNT(DISTINCT user_id) FROM daily_checkin 
    WHERE DATE(checkin_time) = DATE('now')
    """)
    both_checked_in = cursor.fetchone()[0] >= 2
    
    conn.commit()
    conn.close()
    
    # Check for achievements after check-in
    from ..database import check_and_unlock_achievements
    check_and_unlock_achievements(user_id)
    
    return JSONResponse({
        "success": True,
        "message": "Check-in recorded",
        "both_checked_in": both_checked_in,
        "timestamp": datetime.now().isoformat(),
        "points": points
    })

async def get_achievements(request: Request):
    """Get user achievements"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get user's achievements
    cursor.execute("""
    SELECT ach_name, unlock_date FROM achievements 
    WHERE user_id = ? ORDER BY unlock_date DESC
    """, (user_id,))
    
    achievements = [
        {"name": row[0], "unlocked": row[1], "date": row[1]}
        for row in cursor.fetchall()
    ]
    
    # Get all possible achievements from config
    cursor.execute("SELECT key, value FROM meta_config WHERE key LIKE 'achievement_%'")
    all_achievements = []
    
    for key, value in cursor.fetchall():
        name, description = value.split("|", 1)
        ach_id = key.replace("achievement_", "")
        all_achievements.append({
            "id": ach_id,
            "name": name,
            "description": description,
        })
    
    conn.close()
    
    return JSONResponse({
        "unlocked": achievements,
        "all": all_achievements,
    })

async def get_streak_info(request: Request):
    """Get user's check-in streak information"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    return JSONResponse({
        "current_streak": 0,
        "longest_streak": 0,
        "success": True
    })

async def get_checkin_statistics(request: Request):
    """Get comprehensive check-in statistics"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    from ..database import get_checkin_stats
    stats = get_checkin_stats(user_id)
    
    return JSONResponse({
        "stats": {
            "total_checkins": stats["total_checkins"],
            "total_both_checkins": stats["total_both_checkins"],
            "monthly_stats": stats["monthly_stats"]
        },
        "success": True
    })

async def get_checkin_stats(request: Request):
    """Get check-in stats for dashboard display including partner status"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    from ..database import get_checkin_stats, get_partner_checkin_status
    stats = get_checkin_stats(user_id)
    partner_stats = get_partner_checkin_status(user_id)
    
    return JSONResponse({
        "user": {
            "total_checkins": stats["total_checkins"],
            "current_streak": stats["current_streak"],
            "longest_streak": stats["longest_streak"],
            "recent_checkins": stats["recent_checkins"]
        },
        "partner": partner_stats["partner"],
        "combined": partner_stats["combined"],
        "success": True
    })

async def get_checkin_calendar_data(request: Request):
    """Get check-in data for calendar display"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    today = datetime.now()
    
    return JSONResponse({
        "user_checkins": [],
        "both_checkins": [],
        "year": today.year,
        "month": today.month,
        "success": True
    })

async def get_checkin_insights(request: Request):
    """Get check-in patterns and insights (simplified)"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    # Simplified insights for the new interface
    insights = [
        {
            "type": "achievement",
            "icon": "🌟",
            "title": "欢迎回来",
            "content": "简化界面，专注重要时刻"
        }
    ]
    
    # Weekday patterns (empty for now)
    weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    weekday_data = []
    for weekday in weekdays:
        weekday_data.append({
            "day": weekday,
            "count": 0,
            "percentage": 0
        })
    
    # Hour patterns (empty for now)
    hour_data = []
    for hour in range(24):
        hour_data.append({
            "hour": f"{hour:02d}:00",
            "count": 0
        })
    
    return JSONResponse({
        "weekday_patterns": weekday_data,
        "hour_patterns": hour_data,
        "insights": insights,
        "success": True
    })