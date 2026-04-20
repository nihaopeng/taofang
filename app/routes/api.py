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
    """Get check-in stats for dashboard display"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    from ..database import get_checkin_stats
    stats = get_checkin_stats(user_id)
    
    return JSONResponse({
        "total_checkins": stats["total_checkins"],
        "current_streak": stats["current_streak"],
        "longest_streak": stats["longest_streak"],
        "recent_checkins": stats["recent_checkins"],
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
    
    # Get check-in patterns by hour
    cursor.execute("""
    SELECT 
        strftime('%H', checkin_time) as hour,
        COUNT(*) as count
    FROM daily_checkin
    WHERE user_id = ?
    GROUP BY hour
    ORDER BY hour
    """, (user_id,))
    
    hour_stats = cursor.fetchall()
    hour_data = []
    
    for hour in range(24):
        count = 0
        for row in hour_stats:
            if int(row[0]) == hour:
                count = row[1]
                break
        
        hour_str = f"{hour:02d}:00"
        hour_data.append({
            "hour": hour_str,
            "count": count
        })
    
    # Get monthly consistency
    cursor.execute("""
    SELECT 
        strftime('%Y-%m', checkin_time) as month,
        COUNT(DISTINCT DATE(checkin_time)) as days
    FROM daily_checkin
    WHERE user_id = ?
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
    """, (user_id,))
    
    monthly_consistency = []
    for row in cursor.fetchall():
        month_str, days = row
        year, month = map(int, month_str.split('-'))
        
        # Get days in month
        if month == 12:
            next_month = datetime(year + 1, 1, 1)
        else:
            next_month = datetime(year, month + 1, 1)
        
        days_in_month = (next_month - datetime(year, month, 1)).days
        consistency = (days / days_in_month * 100)
        
        monthly_consistency.append({
            "month": month_str,
            "days": days,
            "total_days": days_in_month,
            "consistency": round(consistency, 1)
        })
    
    # Get best streak period
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id = ?
    ORDER BY checkin_date
    """, (user_id,))
    
    all_dates = [datetime.strptime(row[0], "%Y-%m-%d").date() for row in cursor.fetchall()]
    
    best_streak = 0
    best_streak_start = None
    best_streak_end = None
    
    if all_dates:
        current_streak = 1
        streak_start = all_dates[0]
        
        for i in range(1, len(all_dates)):
            days_diff = (all_dates[i] - all_dates[i-1]).days
            
            if days_diff == 1:
                current_streak += 1
            else:
                if current_streak > best_streak:
                    best_streak = current_streak
                    best_streak_start = streak_start
                    best_streak_end = all_dates[i-1]
                
                current_streak = 1
                streak_start = all_dates[i]
        
        # Check last streak
        if current_streak > best_streak:
            best_streak = current_streak
            best_streak_start = streak_start
            best_streak_end = all_dates[-1]
    
    conn.close()
    
    # Generate insights
    insights = []
    
    # Weekday insight
    most_common_day = max(weekday_data, key=lambda x: x["count"])
    if most_common_day["count"] > 0:
        insights.append({
            "type": "pattern",
            "title": "最爱签到日",
            "content": f"你最喜欢在{most_common_day['day']}签到，共{most_common_day['count']}次",
            "icon": "📅"
        })
    
    # Hour insight
    most_common_hour = max(hour_data, key=lambda x: x["count"])
    if most_common_hour["count"] > 0:
        hour_name = "早晨" if 5 <= int(most_common_hour["hour"][:2]) < 12 else \
                   "下午" if 12 <= int(most_common_hour["hour"][:2]) < 18 else \
                   "晚上" if 18 <= int(most_common_hour["hour"][:2]) < 22 else "深夜"
        
        insights.append({
            "type": "pattern",
            "title": "最佳签到时间",
            "content": f"你通常在{hour_name}{most_common_hour['hour']}签到",
            "icon": "⏰"
        })
    
    # Consistency insight
    if monthly_consistency:
        best_month = max(monthly_consistency, key=lambda x: x["consistency"])
        if best_month["consistency"] > 70:
            insights.append({
                "type": "achievement",
                "title": "月度全勤王",
                "content": f"{best_month['month']}你签到了{best_month['days']}天，出勤率{best_month['consistency']}%！",
                "icon": "🏆"
            })
    
    # Streak insight
    if best_streak >= 30:
        insights.append({
            "type": "achievement",
            "title": "超长连胜",
            "content": f"你的最长连续签到记录是{best_streak}天！从{best_streak_start}到{best_streak_end}",
            "icon": "🔥"
        })
    
    return JSONResponse({
        "weekday_patterns": weekday_data,
        "hour_patterns": hour_data,
        "monthly_consistency": monthly_consistency,
        "best_streak": {
            "length": best_streak,
            "start": best_streak_start.isoformat() if best_streak_start else None,
            "end": best_streak_end.isoformat() if best_streak_end else None
        },
        "insights": insights
    })