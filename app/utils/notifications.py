"""
Notification utilities for streak milestones and achievements
"""

from datetime import datetime
from ..database import get_connection

def check_streak_milestones(user_id: int, current_streak: int):
    """Check and return streak milestone notifications"""
    milestones = {
        3: "🎉 连续签到3天！获得【签到新星】称号！",
        7: "🔥 连续签到7天！获得【签到达人】称号！",
        14: "🌟 连续签到14天！保持这个势头！",
        30: "👑 连续签到30天！获得【签到王者】称号！",
        60: "💫 连续签到60天！你们太棒了！",
        90: "🌈 连续签到90天！接近百日大关！",
        100: "🎊 连续签到100天！百日签到成就达成！",
        180: "✨ 连续签到180天！半年的坚持！",
        365: "🏆 连续签到365天！周年纪念！"
    }
    
    notifications = []
    for milestone, message in milestones.items():
        if current_streak == milestone:
            notifications.append({
                "type": "streak_milestone",
                "message": message,
                "milestone": milestone,
                "timestamp": datetime.now().isoformat()
            })
    
    return notifications

def check_checkin_count_milestones(user_id: int, total_checkins: int):
    """Check and return total check-in count milestones"""
    milestones = {
        10: "📝 累计签到10次！良好的开始！",
        30: "📅 累计签到30次！一个月啦！",
        50: "💖 累计签到50次！爱在积累！",
        100: "🎯 累计签到100次！获得【百日签到】成就！",
        200: "🌟 累计签到200次！爱意满满！",
        300: "✨ 累计签到300次！接近一年！",
        365: "🏆 累计签到365次！获得【周年签到】成就！"
    }
    
    notifications = []
    for milestone, message in milestones.items():
        if total_checkins == milestone:
            notifications.append({
                "type": "checkin_count_milestone",
                "message": message,
                "milestone": milestone,
                "timestamp": datetime.now().isoformat()
            })
    
    return notifications

def check_both_checkin_milestones(user_id: int, total_both_checkins: int):
    """Check and return both users check-in milestones"""
    milestones = {
        7: "👥 双人连续签到7天！获得【默契初现】成就！",
        30: "💑 双人连续签到30天！默契十足！",
        100: "❤️ 双人连续签到100天！心有灵犀！",
        365: "💞 双人连续签到365天！天生一对！"
    }
    
    notifications = []
    for milestone, message in milestones.items():
        if total_both_checkins == milestone:
            notifications.append({
                "type": "both_checkin_milestone",
                "message": message,
                "milestone": milestone,
                "timestamp": datetime.now().isoformat()
            })
    
    return notifications

def get_all_notifications(user_id: int):
    """Get all pending notifications for a user"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get user stats
    cursor.execute("SELECT COUNT(*) FROM daily_checkin WHERE user_id = ?", (user_id,))
    total_checkins = cursor.fetchone()[0]
    
    # Get current streak (simplified calculation)
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id = ?
    ORDER BY checkin_date DESC
    LIMIT 1
    """, (user_id,))
    
    last_checkin = cursor.fetchone()
    current_streak = 0
    
    if last_checkin:
        last_date = datetime.strptime(last_checkin[0], "%Y-%m-%d").date()
        today = datetime.now().date()
        
        if last_date == today:
            current_streak = 1
            # Check previous days (simplified)
            cursor.execute("""
            SELECT DATE(checkin_time) as checkin_date
            FROM daily_checkin
            WHERE user_id = ?
            ORDER BY checkin_date DESC
            LIMIT 7
            """, (user_id,))
            
            dates = [datetime.strptime(row[0], "%Y-%m-%d").date() for row in cursor.fetchall()]
            for i in range(1, len(dates)):
                if (dates[i-1] - dates[i]).days == 1:
                    current_streak += 1
                else:
                    break
    
    # Get both check-ins count
    cursor.execute("""
    SELECT COUNT(DISTINCT DATE(checkin_time)) as both_days
    FROM daily_checkin
    WHERE user_id IN (1, 2)
    GROUP BY DATE(checkin_time)
    HAVING COUNT(DISTINCT user_id) = 2
    """)
    
    result = cursor.fetchone()
    total_both_checkins = result[0] if result else 0
    
    conn.close()
    
    # Check all milestone types
    notifications = []
    notifications.extend(check_streak_milestones(user_id, current_streak))
    notifications.extend(check_checkin_count_milestones(user_id, total_checkins))
    notifications.extend(check_both_checkin_milestones(user_id, total_both_checkins))
    
    return notifications

def create_notification_display(notifications):
    """Create HTML for notification display"""
    if not notifications:
        return ""
    
    html = '<div class="notifications-container">'
    html += '<h3>🎉 最新通知</h3>'
    html += '<div class="notifications-list">'
    
    for notification in notifications[:5]:  # Show only latest 5
        html += f'''
        <div class="notification-item">
            <div class="notification-icon">🎯</div>
            <div class="notification-content">
                <div class="notification-message">{notification["message"]}</div>
                <div class="notification-time">{notification["timestamp"][:10]}</div>
            </div>
        </div>
        '''
    
    html += '</div></div>'
    
    return html