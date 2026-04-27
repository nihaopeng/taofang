import sqlite3
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

def get_connection():
    return sqlite3.connect(os.getenv("DATABASE_PATH", "app/database.db"), check_same_thread=False)

def init_db():
    if not os.path.exists("app/database"):
        os.makedirs("app/database")
    
    conn = get_connection()
    cursor = conn.cursor()
    
    # Check if users table exists and has points column
    cursor.execute("PRAGMA table_info(users)")
    columns = cursor.fetchall()
    column_names = [col[1] for col in columns]
    
    # Create tables based on PRD schema
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        secret_key TEXT NOT NULL,
        points INTEGER DEFAULT 0
    )
    """)
    
    # If table exists but missing points column, add it
    if columns and 'points' not in column_names:
        print("Adding points column to users table...")
        cursor.execute("ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0")
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ach_id TEXT NOT NULL,
        ach_name TEXT NOT NULL,
        ach_description TEXT,
        ach_icon TEXT,
        ach_category TEXT,
        ach_points INTEGER DEFAULT 0,
        unlock_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS daily_checkin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        checkin_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS meta_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS login_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
    """)
    
    # Create canvas drawings table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        content TEXT NOT NULL,
        is_private BOOLEAN DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
    """)
    
    # Insert initial data if tables are empty
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] == 0:
        # Create the two users as specified in PRD
        cursor.execute("INSERT INTO users (id, name, secret_key) VALUES (1, ?, ?)", (os.getenv("USER_A_NAME"), os.getenv("USER_A_PASSPHRASE")))
        cursor.execute("INSERT INTO users (id, name, secret_key) VALUES (2, ?, ?)", (os.getenv("USER_B_NAME"), os.getenv("USER_B_PASSPHRASE")))
        
        # Set anniversary date (default to today for demo)
        anniversary_date = datetime.now().strftime("%Y-%m-%d")
        cursor.execute("INSERT OR REPLACE INTO meta_config (key, value) VALUES ('anniversary_date', ?)", (anniversary_date,))
        
        # Initialize achievement definitions
        achievement_definitions = [
            # 恋爱时间成就
            ("time_7days", "一周之约", "恋爱7天", "❤️", "time", 10),
            ("time_30days", "满月之喜", "恋爱30天", "🌕", "time", 30),
            ("time_100days", "百日纪念", "恋爱100天", "💯", "time", 50),
            ("time_365days", "周年庆典", "恋爱1周年", "🎂", "time", 100),
            ("time_1000days", "千日之恋", "恋爱1000天", "🌟", "time", 200),
            
            # 互动成就
            ("interact_first", "初次互动", "第一次互动", "👋", "interaction", 10),
            ("interact_10", "活跃伙伴", "完成10次互动", "💬", "interaction", 30),
            ("interact_50", "亲密无间", "完成50次互动", "💕", "interaction", 60),
            ("interact_100", "心有灵犀", "完成100次互动", "✨", "interaction", 100),
            
            # 特殊时刻成就
            ("special_first_month", "第一个月", "度过第一个月", "📅", "special", 20),
            ("special_first_year", "第一年", "度过第一年", "🎉", "special", 80),
            ("special_valentine", "情人节", "一起过情人节", "💘", "special", 50),
            ("special_birthday", "生日祝福", "为对方庆生", "🎁", "special", 40),
            
            # 里程碑成就
            ("milestone_first_photo", "第一张照片", "上传第一张照片", "📸", "milestone", 30),
            ("milestone_first_note", "第一篇日记", "写下第一篇日记", "📝", "milestone", 20),
            ("milestone_10_photos", "回忆满满", "上传10张照片", "📷", "milestone", 50),
            ("milestone_10_notes", "日记达人", "写下10篇日记", "📚", "milestone", 40),
        ]
        
        for ach_id, name, description, icon, category, points in achievement_definitions:
            cursor.execute("""
            INSERT OR IGNORE INTO meta_config (key, value)
            VALUES (?, ?)
            """, (f"achievement_def_{ach_id}", f"{name}|{description}|{icon}|{category}|{points}"))
    
    conn.commit()
    conn.close()

def unlock_achievement(user_id: int, achievement_id: str, achievement_data: dict = None):
    """Unlock a specific achievement for a user"""
    conn = get_connection()
    cursor = conn.cursor()
    today = datetime.now()
    
    # Check if achievement already unlocked
    cursor.execute("""
    SELECT COUNT(*) FROM achievements 
    WHERE user_id = ? AND ach_id = ?
    """, (user_id, achievement_id))
    
    if cursor.fetchone()[0] > 0:
        conn.close()
        return False
    
    # Get achievement definition
    cursor.execute("""
    SELECT value FROM meta_config 
    WHERE key = ?
    """, (f"achievement_def_{achievement_id}",))
    
    row = cursor.fetchone()
    if not row:
        # If no definition found, use provided data or default
        if achievement_data:
            name = achievement_data.get("name", "成就")
            description = achievement_data.get("description", "")
            icon = achievement_data.get("icon", "🏆")
            category = achievement_data.get("category", "general")
            points = achievement_data.get("points", 0)
        else:
            name = "成就"
            description = ""
            icon = "🏆"
            category = "general"
            points = 0
    else:
        # Parse definition
        parts = row[0].split('|')
        name = parts[0] if len(parts) > 0 else "成就"
        description = parts[1] if len(parts) > 1 else ""
        icon = parts[2] if len(parts) > 2 else "🏆"
        category = parts[3] if len(parts) > 3 else "general"
        points = int(parts[4]) if len(parts) > 4 else 0
    
    # Insert achievement
    cursor.execute("""
    INSERT INTO achievements 
    (user_id, ach_id, ach_name, ach_description, ach_icon, ach_category, ach_points, unlock_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (user_id, achievement_id, name, description, icon, category, points, today.strftime("%Y-%m-%d")))
    
    conn.commit()
    conn.close()
    return True

def check_and_unlock_time_achievements(user_id: int):
    """Check and unlock time-based achievements"""
    conn = get_connection()
    cursor = conn.cursor()
    today = datetime.now()
    
    # Get user's anniversary date
    cursor.execute("SELECT value FROM meta_config WHERE key = 'anniversary_date'")
    anniversary_row = cursor.fetchone()
    
    if not anniversary_row:
        conn.close()
        return
    
    anniversary_date = datetime.strptime(anniversary_row[0], "%Y-%m-%d")
    days_together = (today - anniversary_date).days
    
    # Time-based achievements
    time_achievements = {
        7: "time_7days",
        30: "time_30days",
        100: "time_100days",
        365: "time_365days",
        1000: "time_1000days"
    }
    
    for days_required, achievement_id in time_achievements.items():
        if days_together >= days_required:
            unlock_achievement(user_id, achievement_id)
    
    conn.close()

def check_and_unlock_interaction_achievements(user_id: int, interaction_count: int):
    """Check and unlock interaction-based achievements"""
    if interaction_count >= 1:
        unlock_achievement(user_id, "interact_first")
    if interaction_count >= 10:
        unlock_achievement(user_id, "interact_10")
    if interaction_count >= 50:
        unlock_achievement(user_id, "interact_50")
    if interaction_count >= 100:
        unlock_achievement(user_id, "interact_100")

def check_and_unlock_achievements(user_id: int):
    """Check and unlock all types of achievements for a user"""
    # Check time-based achievements
    check_and_unlock_time_achievements(user_id)
    
    # Check check-in based achievements
    check_and_unlock_checkin_achievements(user_id)
    
    # Note: Other achievement types (game, canvas, interaction, special) 
    # are checked in their respective contexts

def check_and_unlock_special_achievements(user_id: int, event_type: str):
    """Check and unlock special event achievements"""
    if event_type == "valentine":
        unlock_achievement(user_id, "special_valentine")
    elif event_type == "birthday":
        unlock_achievement(user_id, "special_birthday")
    
    # Check month/year milestones
    today = datetime.now()
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT value FROM meta_config WHERE key = 'anniversary_date'")
    anniversary_row = cursor.fetchone()
    
    if anniversary_row:
        anniversary_date = datetime.strptime(anniversary_row[0], "%Y-%m-%d")
        months_together = (today.year - anniversary_date.year) * 12 + today.month - anniversary_date.month
        years_together = today.year - anniversary_date.year
        
        if months_together >= 1:
            unlock_achievement(user_id, "special_first_month")
        if years_together >= 1:
            unlock_achievement(user_id, "special_first_year")
    
    conn.close()

def check_and_unlock_checkin_achievements(user_id: int):
    """Check and unlock check-in based achievements"""
    today = datetime.now()
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get days together from anniversary date
    days_together = 0
    cursor.execute("SELECT value FROM meta_config WHERE key = 'anniversary_date'")
    anniversary_row = cursor.fetchone()
    
    if anniversary_row:
        anniversary_date = datetime.strptime(anniversary_row[0], "%Y-%m-%d")
        days_together = (today - anniversary_date).days
    
    # Check for check-in based achievements
    if days_together >= 7:
        # Check for 7 consecutive days of both users checking in
        cursor.execute("""
        SELECT DATE(checkin_time) as checkin_date
        FROM daily_checkin
        WHERE user_id IN (1, 2)
        GROUP BY DATE(checkin_time)
        HAVING COUNT(DISTINCT user_id) = 2
        ORDER BY checkin_date DESC
        LIMIT 7
        """)
        
        consecutive_days = cursor.fetchall()
        if len(consecutive_days) >= 7:
            # Check if "默契初现" is already unlocked
            cursor.execute("""
            SELECT COUNT(*) FROM achievements 
            WHERE user_id = ? AND ach_name = '默契初现'
            """, (user_id,))
            
            if cursor.fetchone()[0] == 0:
                cursor.execute("""
                INSERT INTO achievements (user_id, ach_name, unlock_date)
                VALUES (?, '默契初现', ?)
                """, (user_id, today.strftime("%Y-%m-%d")))
    
    # Check for streak-based achievements
    current_streak = get_user_streak(user_id)
    total_checkins = get_checkin_stats(user_id)["total_checkins"]
    
    # Streak length achievements
    streak_achievements = {
        3: "签到新星",
        7: "签到达人",
        30: "签到王者",
    }
    
    for streak_required, achievement_name in streak_achievements.items():
        if current_streak >= streak_required:
            cursor.execute("""
            SELECT COUNT(*) FROM achievements 
            WHERE user_id = ? AND ach_name = ?
            """, (user_id, achievement_name))
            
            if cursor.fetchone()[0] == 0:
                cursor.execute("""
                INSERT INTO achievements (user_id, ach_name, unlock_date)
                VALUES (?, ?, ?)
                """, (user_id, achievement_name, today.strftime("%Y-%m-%d")))
    
    # Total check-in count achievements
    count_achievements = {
        100: "百日签到",
        365: "周年签到",
    }
    
    for count_required, achievement_name in count_achievements.items():
        if total_checkins >= count_required:
            cursor.execute("""
            SELECT COUNT(*) FROM achievements 
            WHERE user_id = ? AND ach_name = ?
            """, (user_id, achievement_name))
            
            if cursor.fetchone()[0] == 0:
                cursor.execute("""
                INSERT INTO achievements (user_id, ach_name, unlock_date)
                VALUES (?, ?, ?)
                """, (user_id, achievement_name, today.strftime("%Y-%m-%d")))
    
    conn.commit()
    conn.close()

def get_recent_achievements(user_id: int, limit: int = 5):
    """Get recent achievements for a user with full details"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    SELECT 
        a.ach_id,
        a.ach_name,
        a.ach_description,
        a.ach_icon,
        a.ach_category,
        a.ach_points,
        a.unlock_date
    FROM achievements a
    WHERE a.user_id = ?
    ORDER BY a.unlock_date DESC, a.created_at DESC
    LIMIT ?
    """, (user_id, limit))
    
    achievements = []
    for row in cursor.fetchall():
        achievements.append({
            "id": row[0],
            "name": row[1],
            "description": row[2] or "",
            "icon": row[3] or "🏆",
            "category": row[4] or "general",
            "points": row[5] or 0,
            "date": row[6] or ""
        })
    
    conn.close()
    return achievements

def get_all_achievements(user_id: int):
    """Get all achievements for a user, grouped by category"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    SELECT 
        a.ach_id,
        a.ach_name,
        a.ach_description,
        a.ach_icon,
        a.ach_category,
        a.ach_points,
        a.unlock_date
    FROM achievements a
    WHERE a.user_id = ?
    ORDER BY a.ach_category, a.unlock_date DESC
    """, (user_id,))
    
    achievements_by_category = {}
    for row in cursor.fetchall():
        category = row[4] or "general"
        if category not in achievements_by_category:
            achievements_by_category[category] = []
        
        achievements_by_category[category].append({
            "id": row[0],
            "name": row[1],
            "description": row[2] or "",
            "icon": row[3] or "🏆",
            "category": category,
            "points": row[5] or 0,
            "date": row[6] or "",
            "unlocked": True
        })
    
    # Get all achievement definitions to show locked achievements
    cursor.execute("""
    SELECT key, value FROM meta_config 
    WHERE key LIKE 'achievement_def_%'
    """)
    
    all_definitions = {}
    for row in cursor.fetchall():
        parts = row[1].split('|')
        if len(parts) >= 5:
            ach_id = row[0].replace('achievement_def_', '')
            all_definitions[ach_id] = {
                "id": ach_id,
                "name": parts[0],
                "description": parts[1],
                "icon": parts[2],
                "category": parts[3],
                "points": int(parts[4])
            }
    
    conn.close()
    
    # Add locked achievements
    unlocked_ids = set()
    for category_achievements in achievements_by_category.values():
        for ach in category_achievements:
            unlocked_ids.add(ach["id"])
    
    for ach_id, ach_def in all_definitions.items():
        if ach_id not in unlocked_ids:
            category = ach_def["category"]
            if category not in achievements_by_category:
                achievements_by_category[category] = []
            
            achievements_by_category[category].append({
                **ach_def,
                "date": "",
                "unlocked": False
            })
    
    return achievements_by_category

def get_achievement_stats(user_id: int):
    """Get achievement statistics for a user"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get total achievements unlocked
    cursor.execute("""
    SELECT COUNT(*) FROM achievements WHERE user_id = ?
    """, (user_id,))
    total_unlocked = cursor.fetchone()[0]
    
    # Get total points
    cursor.execute("""
    SELECT SUM(ach_points) FROM achievements WHERE user_id = ?
    """, (user_id,))
    total_points = cursor.fetchone()[0] or 0
    
    # Get achievements by category
    cursor.execute("""
    SELECT ach_category, COUNT(*) 
    FROM achievements 
    WHERE user_id = ?
    GROUP BY ach_category
    """, (user_id,))
    
    category_stats = {}
    for row in cursor.fetchall():
        category_stats[row[0]] = row[1]
    
    # Get total achievement definitions
    cursor.execute("""
    SELECT COUNT(*) FROM meta_config WHERE key LIKE 'achievement_def_%'
    """)
    total_achievements = cursor.fetchone()[0]
    
    conn.close()
    
    return {
        "total_unlocked": total_unlocked,
        "total_achievements": total_achievements,
        "completion_rate": round((total_unlocked / total_achievements * 100), 1) if total_achievements > 0 else 0,
        "total_points": total_points,
        "category_stats": category_stats
    }

def get_user_streak(user_id: int):
    """Get current check-in streak for a user"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get all check-in dates for the user, ordered by date
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id = ?
    ORDER BY checkin_date DESC
    """, (user_id,))
    
    checkin_dates = [datetime.strptime(row[0], "%Y-%m-%d").date() for row in cursor.fetchall()]
    conn.close()
    
    if not checkin_dates:
        return 0
    
    # Calculate current streak
    today = datetime.now().date()
    streak = 0
    
    # Check if checked in today
    if checkin_dates[0] == today:
        streak = 1
        # Check previous days
        expected_date = today
        for checkin_date in checkin_dates[1:]:
            expected_date = expected_date - timedelta(days=1)
            if checkin_date == expected_date:
                streak += 1
            else:
                break
    else:
        # Check yesterday
        yesterday = today - timedelta(days=1)
        if checkin_dates[0] == yesterday:
            streak = 1
            expected_date = yesterday
            for checkin_date in checkin_dates[1:]:
                expected_date = expected_date - timedelta(days=1)
                if checkin_date == expected_date:
                    streak += 1
                else:
                    break
    
    return streak

def get_longest_streak(user_id: int):
    """Get longest check-in streak for a user"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id = ?
    ORDER BY checkin_date
    """, (user_id,))
    
    checkin_dates = [datetime.strptime(row[0], "%Y-%m-%d").date() for row in cursor.fetchall()]
    conn.close()
    
    if not checkin_dates:
        return 0
    
    # Calculate longest streak
    longest_streak = 1
    current_streak = 1
    
    for i in range(1, len(checkin_dates)):
        days_diff = (checkin_dates[i] - checkin_dates[i-1]).days
        if days_diff == 1:
            current_streak += 1
            longest_streak = max(longest_streak, current_streak)
        else:
            current_streak = 1
    
    return longest_streak

def get_checkin_stats(user_id: int):
    """Get comprehensive check-in statistics for a user"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Total check-ins
    cursor.execute("SELECT COUNT(*) FROM daily_checkin WHERE user_id = ?", (user_id,))
    total_checkins = cursor.fetchone()[0]
    
    # Current streak
    current_streak = get_user_streak(user_id)
    
    # Longest streak
    longest_streak = get_longest_streak(user_id)
    
    # Monthly check-ins
    cursor.execute("""
    SELECT strftime('%Y-%m', checkin_time) as month, COUNT(*) as count
    FROM daily_checkin
    WHERE user_id = ?
    GROUP BY month
    ORDER BY month DESC
    LIMIT 6
    """, (user_id,))
    
    monthly_stats = [{"month": row[0], "count": row[1]} for row in cursor.fetchall()]
    
    # Check-in calendar (last 30 days)
    thirty_days_ago = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id = ? AND DATE(checkin_time) >= ?
    ORDER BY checkin_date
    """, (user_id, thirty_days_ago))
    
    recent_checkins = [row[0] for row in cursor.fetchall()]
    
    # Both users check-in days
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id IN (1, 2)
    GROUP BY DATE(checkin_time)
    HAVING COUNT(DISTINCT user_id) = 2
    ORDER BY checkin_date DESC
    """)
    
    both_checkin_dates = [row[0] for row in cursor.fetchall()]
    total_both_checkins = len(both_checkin_dates)
    
    conn.close()
    
    return {
        "total_checkins": total_checkins,
        "current_streak": current_streak,
        "longest_streak": longest_streak,
        "monthly_stats": monthly_stats,
        "recent_checkins": recent_checkins,
        "total_both_checkins": total_both_checkins,
        "both_checkin_dates": both_checkin_dates[-30:] if len(both_checkin_dates) > 30 else both_checkin_dates
    }

def get_partner_checkin_status(current_user_id: int):
    """Get partner's check-in status and combined statistics"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Determine partner ID (assuming user IDs are 1 and 2)
    partner_id = 2 if current_user_id == 1 else 1
    
    # Get partner's today check-in status
    cursor.execute("""
    SELECT COUNT(*) FROM daily_checkin 
    WHERE user_id = ? AND DATE(checkin_time) = DATE('now')
    """, (partner_id,))
    
    partner_checked_in_today = cursor.fetchone()[0] > 0
    
    # Get partner's streak
    partner_current_streak = get_user_streak(partner_id)
    partner_longest_streak = get_longest_streak(partner_id)
    
    # Get partner's total checkins
    cursor.execute("SELECT COUNT(*) FROM daily_checkin WHERE user_id = ?", (partner_id,))
    partner_total_checkins = cursor.fetchone()[0]
    
    # Get combined statistics
    # Total days both checked in
    cursor.execute("""
    SELECT COUNT(DISTINCT DATE(checkin_time)) 
    FROM daily_checkin 
    WHERE user_id IN (1, 2)
    GROUP BY DATE(checkin_time)
    HAVING COUNT(DISTINCT user_id) = 2
    """)
    
    both_checkin_days_result = cursor.fetchone()
    total_both_checkin_days = both_checkin_days_result[0] if both_checkin_days_result else 0
    
    # Current streak of both checking in
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id IN (1, 2)
    GROUP BY DATE(checkin_time)
    HAVING COUNT(DISTINCT user_id) = 2
    ORDER BY checkin_date DESC
    """)
    
    both_checkin_dates = [datetime.strptime(row[0], "%Y-%m-%d").date() for row in cursor.fetchall()]
    
    # Calculate current both-checkin streak
    both_current_streak = 0
    if both_checkin_dates:
        today = datetime.now().date()
        
        # Check if both checked in today
        if both_checkin_dates[0] == today:
            both_current_streak = 1
            expected_date = today
            for checkin_date in both_checkin_dates[1:]:
                expected_date = expected_date - timedelta(days=1)
                if checkin_date == expected_date:
                    both_current_streak += 1
                else:
                    break
        else:
            # Check yesterday
            yesterday = today - timedelta(days=1)
            if both_checkin_dates[0] == yesterday:
                both_current_streak = 1
                expected_date = yesterday
                for checkin_date in both_checkin_dates[1:]:
                    expected_date = expected_date - timedelta(days=1)
                    if checkin_date == expected_date:
                        both_current_streak += 1
                    else:
                        break
    
    # Longest both-checkin streak
    both_longest_streak = 1
    if len(both_checkin_dates) >= 2:
        current_streak = 1
        for i in range(1, len(both_checkin_dates)):
            days_diff = (both_checkin_dates[i] - both_checkin_dates[i-1]).days
            if days_diff == -1:  # Dates are in descending order
                current_streak += 1
                both_longest_streak = max(both_longest_streak, current_streak)
            else:
                current_streak = 1
    
    conn.close()
    
    return {
        "partner": {
            "id": partner_id,
            "checked_in_today": partner_checked_in_today,
            "current_streak": partner_current_streak,
            "longest_streak": partner_longest_streak,
            "total_checkins": partner_total_checkins
        },
        "combined": {
            "total_both_checkin_days": total_both_checkin_days,
            "current_both_streak": both_current_streak,
            "longest_both_streak": both_longest_streak
        }
    }

def get_checkin_calendar(user_id: int, year: int = None, month: int = None):
    """Get check-in data for calendar display"""
    conn = get_connection()
    cursor = conn.cursor()
    
    today = datetime.now()
    if year is None:
        year = today.year
    if month is None:
        month = today.month
    
    # Get all check-ins for the specified month
    start_date = f"{year:04d}-{month:02d}-01"
    if month == 12:
        end_date = f"{year+1:04d}-01-01"
    else:
        end_date = f"{year:04d}-{month+1:02d}-01"
    
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id = ? AND checkin_time >= ? AND checkin_time < ?
    ORDER BY checkin_date
    """, (user_id, start_date, end_date))
    
    user_checkins = [row[0] for row in cursor.fetchall()]
    
    # Get both users check-ins for the same period
    cursor.execute("""
    SELECT DATE(checkin_time) as checkin_date
    FROM daily_checkin
    WHERE user_id IN (1, 2) AND checkin_time >= ? AND checkin_time < ?
    GROUP BY DATE(checkin_time)
    HAVING COUNT(DISTINCT user_id) = 2
    ORDER BY checkin_date
    """, (start_date, end_date))
    
    both_checkins = [row[0] for row in cursor.fetchall()]
    
    conn.close()
    
    return {
        "user_checkins": user_checkins,
        "both_checkins": both_checkins,
        "year": year,
        "month": month
    }

# ==================== 留言系统函数 ====================

def add_message(user_id: int, user_name: str, content: str, is_private: bool = False):
    """Add a new message"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    INSERT INTO messages (user_id, user_name, content, is_private)
    VALUES (?, ?, ?, ?)
    """, (user_id, user_name, content, 1 if is_private else 0))
    
    conn.commit()
    message_id = cursor.lastrowid
    
    # 解锁留言相关成就
    from datetime import datetime
    today = datetime.now()
    
    # 获取用户留言数量
    cursor.execute("SELECT COUNT(*) FROM messages WHERE user_id = ?", (user_id,))
    message_count = cursor.fetchone()[0]
    
    # 检查成就
    if message_count >= 1:
        cursor.execute("SELECT COUNT(*) FROM achievements WHERE user_id = ? AND ach_id = ?", 
                      (user_id, "milestone_first_note"))
        if cursor.fetchone()[0] == 0:
            cursor.execute("""
            INSERT INTO achievements 
            (user_id, ach_id, ach_name, ach_description, ach_icon, ach_category, ach_points, unlock_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (user_id, "milestone_first_note", "第一篇日记", "写下第一篇日记", "📝", "milestone", 20, today.strftime("%Y-%m-%d")))
    
    if message_count >= 10:
        cursor.execute("SELECT COUNT(*) FROM achievements WHERE user_id = ? AND ach_id = ?", 
                      (user_id, "milestone_10_notes"))
        if cursor.fetchone()[0] == 0:
            cursor.execute("""
            INSERT INTO achievements 
            (user_id, ach_id, ach_name, ach_description, ach_icon, ach_category, ach_points, unlock_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (user_id, "milestone_10_notes", "日记达人", "写下10篇日记", "📚", "milestone", 40, today.strftime("%Y-%m-%d")))
    
    conn.commit()
    conn.close()
    return message_id

def get_messages(user_id: int, include_private: bool = True, limit: int = 50):
    """Get messages for a user"""
    conn = get_connection()
    cursor = conn.cursor()
    
    if include_private:
        # 获取所有公开消息和用户自己的私密消息
        cursor.execute("""
        SELECT 
            m.id, m.user_id, m.user_name, m.content, m.is_private, m.created_at,
            CASE WHEN m.user_id = ? THEN 1 ELSE 0 END as is_own
        FROM messages m
        WHERE m.is_private = 0 OR m.user_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
        """, (user_id, user_id, limit))
    else:
        # 只获取公开消息
        cursor.execute("""
        SELECT 
            m.id, m.user_id, m.user_name, m.content, m.is_private, m.created_at,
            0 as is_own
        FROM messages m
        WHERE m.is_private = 0
        ORDER BY m.created_at DESC
        LIMIT ?
        """, (limit,))
    
    messages = []
    for row in cursor.fetchall():
        messages.append({
            "id": row[0],
            "user_id": row[1],
            "user_name": row[2],
            "content": row[3],
            "is_private": bool(row[4]),
            "created_at": row[5],
            "is_own": bool(row[6]),
            "can_delete": row[1] == user_id  # 只有自己的消息可以删除
        })
    
    conn.close()
    return messages

def delete_message(message_id: int, user_id: int):
    """Delete a message (only if user owns it)"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # 检查消息是否存在且属于该用户
    cursor.execute("SELECT user_id FROM messages WHERE id = ?", (message_id,))
    row = cursor.fetchone()
    
    if not row:
        conn.close()
        return False
    
    if row[0] != user_id:
        conn.close()
        return False
    
    # 删除消息
    cursor.execute("DELETE FROM messages WHERE id = ?", (message_id,))
    conn.commit()
    conn.close()
    return True

def get_message_stats(user_id: int):
    """Get message statistics for a user"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # 获取用户的消息统计
    cursor.execute("""
    SELECT 
        COUNT(*) as total_messages,
        SUM(CASE WHEN is_private = 1 THEN 1 ELSE 0 END) as private_messages,
        MIN(created_at) as first_message,
        MAX(created_at) as last_message
    FROM messages
    WHERE user_id = ?
    """, (user_id,))
    
    row = cursor.fetchone()
    
    # 获取总消息数
    cursor.execute("SELECT COUNT(*) FROM messages")
    total_all_messages = cursor.fetchone()[0]
    
    conn.close()
    print(f"User {user_id} message stats: {row}")
    if row:
        total_messages, private_messages, first_message, last_message = row
        private_messages = private_messages or 0  # Handle NULL case
        return {
            "total_messages": total_messages,
            "private_messages": private_messages,
            "public_messages": total_messages - private_messages,
            "first_message": first_message,
            "last_message": last_message,
            "total_all_messages": total_all_messages
        }
    
    return {
        "total_messages": 0,
        "private_messages": 0,
        "public_messages": 0,
        "first_message": None,
        "last_message": None,
        "total_all_messages": total_all_messages
    }

# ==================== 回忆相册函数 ====================

def add_memory(user_id: int, user_name: str, photo_path: str, caption: str = ""):
    """Add a new memory"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    INSERT INTO memories (user_id, user_name, photo_path, caption)
    VALUES (?, ?, ?, ?)
    """, (user_id, user_name, photo_path, caption))
    
    conn.commit()
    memory_id = cursor.lastrowid
    conn.close()
    return memory_id

def get_memories(limit: int = 50):
    """Get all memories"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    SELECT m.id, m.user_id, m.user_name, m.photo_path, m.caption, m.created_at
    FROM memories m
    ORDER BY m.created_at DESC
    LIMIT ?
    """, (limit,))
    
    memories = []
    for row in cursor.fetchall():
        memories.append({
            "id": row[0],
            "user_id": row[1],
            "user_name": row[2],
            "photo_path": row[3],
            "caption": row[4],
            "created_at": row[5]
        })
    
    conn.close()
    return memories

def delete_memory(memory_id: int, user_id: int):
    """Delete a memory (only if user owns it)"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT user_id, photo_path FROM memories WHERE id = ?", (memory_id,))
    row = cursor.fetchone()
    
    if not row:
        conn.close()
        return False
    
    if row[0] != user_id:
        conn.close()
        return False
    
    photo_path = row[1]
    cursor.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    conn.commit()
    conn.close()
    
    if os.path.exists(photo_path):
        try:
            os.remove(photo_path)
        except:
            pass
    
    return True

# ==================== 画板函数 ====================

