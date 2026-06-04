import sqlite3
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv
from zoneinfo import ZoneInfo

load_dotenv()

VALID_ACHIEVEMENT_CATEGORIES = {"time", "checkin_streak", "checkin_count", "checkin_both"}

def get_connection():
    return sqlite3.connect(os.getenv("DATABASE_PATH", "app/database/heartsync.db"), check_same_thread=False)

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
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        photo_path TEXT NOT NULL,
        caption TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        work_date DATE NOT NULL,
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
        anniversary_date = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
        cursor.execute("INSERT OR REPLACE INTO meta_config (key, value) VALUES ('anniversary_date', ?)", (anniversary_date,))
        
        # Initialize achievement definitions
        achievement_definitions = [
            ("time_7days", "一周之约", "恋爱7天", "❤️", "time", 10),
            ("time_30days", "满月之喜", "恋爱30天", "🌕", "time", 30),
            ("time_100days", "百日纪念", "恋爱100天", "💯", "time", 50),
            ("time_200days", "双百纪念", "恋爱200天", "💎", "time", 60),
            ("time_365days", "周年庆典", "恋爱1周年", "🎂", "time", 100),
            ("time_500days", "五百天纪念", "恋爱500天", "💖", "time", 120),
            ("time_1000days", "千日之恋", "恋爱1000天", "🌟", "time", 200),
            ("time_2000days", "两干日之情", "恋爱2000天", "👑", "time", 300),
            ("streak_3", "签到新星", "连续打卡3天", "🌱", "checkin_streak", 10),
            ("streak_7", "签到达人", "连续打卡7天", "📅", "checkin_streak", 30),
            ("streak_14", "半月坚持", "连续打卡14天", "🌟", "checkin_streak", 50),
            ("streak_21", "三周习惯", "连续打卡21天", "💪", "checkin_streak", 70),
            ("streak_30", "签到王者", "连续打卡30天", "👑", "checkin_streak", 100),
            ("streak_60", "双月连签", "连续打卡60天", "🔥", "checkin_streak", 150),
            ("streak_100", "百日连胜", "连续打卡100天", "💎", "checkin_streak", 200),
            ("streak_180", "半年之约", "连续打卡180天", "✨", "checkin_streak", 300),
            ("streak_365", "全年无休", "连续打卡365天", "🏆", "checkin_streak", 500),
            ("checkin_10", "十次打卡", "累计打卡10次", "📝", "checkin_count", 10),
            ("checkin_50", "五十次打卡", "累计打卡50次", "📋", "checkin_count", 30),
            ("checkin_100", "百日签到", "累计打卡100次", "💯", "checkin_count", 60),
            ("checkin_200", "两百次打卡", "累计打卡200次", "💫", "checkin_count", 100),
            ("checkin_365", "周年签到", "累计打卡365次", "🎂", "checkin_count", 200),
            ("checkin_500", "五百里程碑", "累计打卡500次", "🌟", "checkin_count", 300),
            ("checkin_1000", "千次打卡", "累计打卡1000次", "👑", "checkin_count", 500),
            ("checkin_both_7", "默契初现", "双人同时打卡7天", "🤝", "checkin_both", 30),
            ("checkin_both_14", "两周同步", "双人同时打卡14天", "💕", "checkin_both", 60),
            ("checkin_both_30", "月度默契", "双人同时打卡30天", "💑", "checkin_both", 100),
            ("checkin_both_60", "双月同在", "双人同时打卡60天", "💖", "checkin_both", 150),
            ("checkin_both_100", "百日同心", "双人同时打卡100天", "💎", "checkin_both", 200),
            ("checkin_both_200", "两百天默契", "双人同时打卡200天", "🌟", "checkin_both", 300),
            ("checkin_both_365", "全年相伴", "双人同时打卡365天", "🏆", "checkin_both", 500),
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
    today = datetime.now(ZoneInfo("Asia/Shanghai"))
    
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
    today = datetime.now(ZoneInfo("Asia/Shanghai"))
    
    # Get user's anniversary date
    cursor.execute("SELECT value FROM meta_config WHERE key = 'anniversary_date'")
    anniversary_row = cursor.fetchone()
    
    if not anniversary_row:
        conn.close()
        return
    
    anniversary_date = datetime.strptime(anniversary_row[0], "%Y-%m-%d").date()
    days_together = (datetime.now(ZoneInfo("Asia/Shanghai")).date() - anniversary_date).days
    
    # Time-based achievements
    time_achievements = {
        7: "time_7days",
        30: "time_30days",
        100: "time_100days",
        200: "time_200days",
        365: "time_365days",
        500: "time_500days",
        1000: "time_1000days",
        2000: "time_2000days"
    }
    
    for days_required, achievement_id in time_achievements.items():
        if days_together >= days_required:
            unlock_achievement(user_id, achievement_id)
    
    conn.close()

def check_and_unlock_achievements(user_id: int):
    """Check and unlock all types of achievements for a user"""
    check_and_unlock_time_achievements(user_id)
    check_and_unlock_checkin_achievements(user_id)

def check_and_unlock_checkin_achievements(user_id: int):
    """Check and unlock check-in based achievements"""
    today = datetime.now(ZoneInfo("Asia/Shanghai"))
    conn = get_connection()
    cursor = conn.cursor()
    
    current_streak = get_user_streak(user_id)
    total_checkins = get_checkin_stats(user_id)["total_checkins"]
    
    streak_thresholds = [3, 7, 14, 21, 30, 60, 100, 180, 365]
    for threshold in streak_thresholds:
        if current_streak >= threshold:
            unlock_achievement(user_id, f"streak_{threshold}")
    
    count_thresholds = [10, 50, 100, 200, 365, 500, 1000]
    for threshold in count_thresholds:
        if total_checkins >= threshold:
            unlock_achievement(user_id, f"checkin_{threshold}")
    
    cursor.execute("""
    SELECT COUNT(DISTINCT DATE(checkin_time))
    FROM daily_checkin
    WHERE user_id IN (1, 2)
    GROUP BY DATE(checkin_time)
    HAVING COUNT(DISTINCT user_id) = 2
    """)
    both_checkin_days = len(cursor.fetchall())
    
    both_thresholds = [7, 14, 30, 60, 100, 200, 365]
    for threshold in both_thresholds:
        if both_checkin_days >= threshold:
            unlock_achievement(user_id, f"checkin_both_{threshold}")
    
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
        if category not in VALID_ACHIEVEMENT_CATEGORIES:
            continue
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
            category = parts[3]
            if category not in VALID_ACHIEVEMENT_CATEGORIES:
                continue
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
    
    cursor.execute("""
    SELECT ach_category, COUNT(*), SUM(ach_points)
    FROM achievements 
    WHERE user_id = ?
    GROUP BY ach_category
    """, (user_id,))
    
    total_unlocked = 0
    total_points = 0
    category_stats = {}
    for row in cursor.fetchall():
        cat = row[0]
        if cat not in VALID_ACHIEVEMENT_CATEGORIES:
            continue
        category_stats[cat] = row[1]
        total_unlocked += row[1]
        total_points += (row[2] or 0)
    
    cursor.execute(
        "SELECT COUNT(*) FROM meta_config WHERE key LIKE 'achievement_def_%'"
    )
    total_defs = cursor.fetchone()[0]
    
    valid_total = sum(
        1 for p in [
            "time_",
            "checkin_streak_",
            "checkin_count_",
            "checkin_both_"
        ]
        for _ in range(total_defs)
    )
    
    valid_count = 0
    cursor.execute("SELECT key FROM meta_config WHERE key LIKE 'achievement_def_%'")
    for row in cursor.fetchall():
        ach_id = row[0].replace("achievement_def_", "")
        for prefix in ["time_", "streak_", "checkin_", "checkin_both_"]:
            if ach_id.startswith(prefix):
                valid_count += 1
                break
    
    conn.close()
    
    return {
        "total_unlocked": total_unlocked,
        "total_achievements": valid_count,
        "completion_rate": round((total_unlocked / valid_count * 100), 1) if valid_count > 0 else 0,
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
    res = cursor.fetchall()
    #print(f"user:{user_id},res:{res}")
    checkin_dates = [datetime.strptime(row[0], "%Y-%m-%d").date() for row in res]
    #print(f"checking dates:{checkin_dates}") 
    conn.close()
    
    if not checkin_dates:
        return 0
    
    # Calculate current streak
    #today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    # print(f"user_id:{user_id},today:{today},last checkin:{checkin_dates[0]},checkin is today:{checkin_dates[0] == today}")
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
    # print(f"streak:{streak}")
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
    thirty_days_ago = (datetime.now(ZoneInfo("Asia/Shanghai")) - timedelta(days=30)).strftime("%Y-%m-%d")
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
        today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        
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
    
    today = datetime.now(ZoneInfo("Asia/Shanghai"))
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

# ==================== 工作总结函数 ====================

def add_work_item(user_id: int, content: str, work_date: str):
    """Add a new work item (default completed)"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO work_items (user_id, content, completed, work_date) VALUES (?, ?, 1, ?)",
        (user_id, content, work_date)
    )
    conn.commit()
    item_id = cursor.lastrowid
    conn.close()
    return item_id

def get_work_items(user_id: int, work_date: str = None):
    """Get work items for a user, optionally filtered by date"""
    conn = get_connection()
    cursor = conn.cursor()
    if work_date:
        cursor.execute(
            "SELECT id, content, completed, work_date, created_at FROM work_items WHERE user_id = ? AND work_date = ? ORDER BY created_at ASC",
            (user_id, work_date)
        )
    else:
        cursor.execute(
            "SELECT id, content, completed, work_date, created_at FROM work_items WHERE user_id = ? ORDER BY work_date DESC, created_at ASC",
            (user_id,)
        )
    items = []
    for row in cursor.fetchall():
        items.append({
            "id": row[0],
            "content": row[1],
            "completed": bool(row[2]),
            "work_date": row[3],
            "created_at": row[4]
        })
    conn.close()
    return items

def toggle_work_item(item_id: int, user_id: int):
    """Toggle completion status of a work item"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE work_items SET completed = 1 - completed WHERE id = ? AND user_id = ?",
        (item_id, user_id)
    )
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    return affected > 0

def update_work_item(item_id: int, user_id: int, content: str):
    """Update content of a work item"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE work_items SET content = ? WHERE id = ? AND user_id = ?",
        (content, item_id, user_id)
    )
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    return affected > 0

def delete_work_item(item_id: int, user_id: int):
    """Delete a work item"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "DELETE FROM work_items WHERE id = ? AND user_id = ?",
        (item_id, user_id)
    )
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    return affected > 0

def get_work_stats(user_id: int):
    """Get work stats for visualization - daily completed items count"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        """SELECT work_date, 
                  COUNT(*) as total, 
                  SUM(completed) as completed_count
           FROM work_items 
           WHERE user_id = ? 
           GROUP BY work_date 
           ORDER BY work_date ASC""",
        (user_id,)
    )
    stats = []
    for row in cursor.fetchall():
        stats.append({
            "date": row[0],
            "total": row[1],
            "completed": row[2] or 0
        })
    conn.close()
    return stats


def record_work_visit(user_id: int, date_str: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT OR REPLACE INTO meta_config (key, value) VALUES (?, ?)",
                   (f"work_visit_{user_id}", date_str))
    conn.commit()
    conn.close()


def get_work_visit_date(user_id: int) -> str:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM meta_config WHERE key = ?", (f"work_visit_{user_id}",))
    row = cursor.fetchone()
    conn.close()
    return row[0] if row else ""


def acknowledge_work_day(user_id: int, date_str: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT OR REPLACE INTO meta_config (key, value) VALUES (?, ?)",
                   (f"work_ack_{user_id}", date_str))
    conn.commit()
    conn.close()


def is_work_day_acknowledged(user_id: int, date_str: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM meta_config WHERE key = ?", (f"work_ack_{user_id}",))
    row = cursor.fetchone()
    conn.close()
    return row is not None and row[0] == date_str


def was_email_sent_today(user_id: int, date_str: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM meta_config WHERE key = ?", (f"email_reminder_{user_id}",))
    row = cursor.fetchone()
    conn.close()
    return row is not None and row[0] == date_str


def mark_email_sent(user_id: int, date_str: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT OR REPLACE INTO meta_config (key, value) VALUES (?, ?)",
                   (f"email_reminder_{user_id}", date_str))
    conn.commit()
    conn.close()


def check_and_send_reminders():
    from zoneinfo import ZoneInfo
    from datetime import datetime
    today_str = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
    current_hour = datetime.now(ZoneInfo("Asia/Shanghai")).hour
    check_hour = int(os.getenv("REMINDER_CHECK_HOUR", "20"))
    if current_hour < check_hour:
        return []
    results = []
    for uid in [1, 2]:
        if was_email_sent_today(uid, today_str):
            continue
        if is_work_day_acknowledged(uid, today_str):
            continue
        items = get_work_items(uid, today_str)
        if items:
            continue
        results.append(uid)
    return results

