import sqlite3
import os
from datetime import datetime, timedelta

DATABASE_PATH = "app/database/heartsync.db"

def get_connection():
    return sqlite3.connect(DATABASE_PATH)

def init_db():
    if not os.path.exists("app/database"):
        os.makedirs("app/database")
    
    conn = get_connection()
    cursor = conn.cursor()
    
    # Create tables based on PRD schema
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        secret_key TEXT NOT NULL
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ach_name TEXT NOT NULL,
        unlock_date DATE,
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
    CREATE TABLE IF NOT EXISTS canvas_drawings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        from_x REAL NOT NULL,
        from_y REAL NOT NULL,
        to_x REAL NOT NULL,
        to_y REAL NOT NULL,
        color TEXT NOT NULL,
        brush_size REAL NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
    """)
    
    # Create index for faster queries
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_canvas_session ON canvas_drawings(session_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_canvas_created ON canvas_drawings(created_at)")
    
    # Insert initial data if tables are empty
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] == 0:
        # Create the two users as specified in PRD
        cursor.execute("INSERT INTO users (id, name, secret_key) VALUES (1, 'User_A', 'first-love')")
        cursor.execute("INSERT INTO users (id, name, secret_key) VALUES (2, 'User_B', 'first-love')")
        
        # Set anniversary date (default to today for demo)
        anniversary_date = datetime.now().strftime("%Y-%m-%d")
        cursor.execute("INSERT OR REPLACE INTO meta_config (key, value) VALUES ('anniversary_date', ?)", (anniversary_date,))
        
        # Initialize achievement milestones
        achievements = [
            (1, "萌芽", "相识 1 天"),
            (2, "默契初现", "连续双人打卡 7 天"),
            (3, "百日维新", "相识 100 天"),
            (4, "半载同行", "相识 182 天"),
            (5, "岁月如歌", "相识 365 天"),
            # Streak-based achievements
            (6, "签到新星", "连续签到 3 天"),
            (7, "签到达人", "连续签到 7 天"),
            (8, "签到王者", "连续签到 30 天"),
            (9, "百日签到", "累计签到 100 天"),
            (10, "周年签到", "累计签到 365 天"),
        ]
        
        for ach_id, name, description in achievements:
            cursor.execute("""
            INSERT OR IGNORE INTO meta_config (key, value) 
            VALUES (?, ?)
            """, (f"achievement_{ach_id}", f"{name}|{description}"))
    
    conn.commit()
    conn.close()

def check_and_unlock_achievements(user_id: int):
    """Check and unlock achievements based on conditions"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get anniversary date
    cursor.execute("SELECT value FROM meta_config WHERE key = 'anniversary_date'")
    anniversary_row = cursor.fetchone()
    
    if not anniversary_row:
        conn.close()
        return
    
    anniversary_date = datetime.strptime(anniversary_row[0], "%Y-%m-%d")
    today = datetime.now()
    days_together = (today - anniversary_date).days
    
    # Check for day-based achievements
    day_achievements = {
        1: "萌芽",
        100: "百日维新",
        182: "半载同行",
        365: "岁月如歌",
    }
    
    for days_required, achievement_name in day_achievements.items():
        if days_together >= days_required:
            # Check if already unlocked
            cursor.execute("""
            SELECT COUNT(*) FROM achievements 
            WHERE user_id = ? AND ach_name = ?
            """, (user_id, achievement_name))
            
            if cursor.fetchone()[0] == 0:
                # Unlock achievement
                cursor.execute("""
                INSERT INTO achievements (user_id, ach_name, unlock_date)
                VALUES (?, ?, ?)
                """, (user_id, achievement_name, today.strftime("%Y-%m-%d")))
    
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

# ==================== Canvas Drawing Functions ====================

def save_canvas_drawing(session_id: str, user_id: int, user_name: str, 
                       from_x: float, from_y: float, to_x: float, to_y: float,
                       color: str, brush_size: float):
    """Save a canvas drawing stroke to database"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    INSERT INTO canvas_drawings 
    (session_id, user_id, user_name, from_x, from_y, to_x, to_y, color, brush_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (session_id, user_id, user_name, from_x, from_y, to_x, to_y, color, brush_size))
    
    conn.commit()
    conn.close()
    
    return cursor.lastrowid

def get_canvas_drawings(session_id: str, limit: int = 1000):
    """Get all drawings for a canvas session"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    SELECT id, user_id, user_name, from_x, from_y, to_x, to_y, color, brush_size, created_at
    FROM canvas_drawings
    WHERE session_id = ?
    ORDER BY created_at ASC
    LIMIT ?
    """, (session_id, limit))
    
    drawings = []
    for row in cursor.fetchall():
        drawings.append({
            "id": row[0],
            "user_id": row[1],
            "user_name": row[2],
            "from_x": row[3],
            "from_y": row[4],
            "to_x": row[5],
            "to_y": row[6],
            "color": row[7],
            "brush_size": row[8],
            "created_at": row[9]
        })
    
    conn.close()
    return drawings

def clear_canvas_drawings(session_id: str):
    """Clear all drawings for a canvas session"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    DELETE FROM canvas_drawings
    WHERE session_id = ?
    """, (session_id,))
    
    deleted_count = cursor.rowcount
    conn.commit()
    conn.close()
    
    return deleted_count

def get_canvas_stats(session_id: str):
    """Get statistics for a canvas session"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Total drawings count
    cursor.execute("""
    SELECT COUNT(*) FROM canvas_drawings
    WHERE session_id = ?
    """, (session_id,))
    total_drawings = cursor.fetchone()[0]
    
    # Unique users count
    cursor.execute("""
    SELECT COUNT(DISTINCT user_id) FROM canvas_drawings
    WHERE session_id = ?
    """, (session_id,))
    unique_users = cursor.fetchone()[0]
    
    # First drawing date
    cursor.execute("""
    SELECT MIN(created_at) FROM canvas_drawings
    WHERE session_id = ?
    """, (session_id,))
    first_drawing = cursor.fetchone()[0]
    
    # Last drawing date
    cursor.execute("""
    SELECT MAX(created_at) FROM canvas_drawings
    WHERE session_id = ?
    """, (session_id,))
    last_drawing = cursor.fetchone()[0]
    
    conn.close()
    
    return {
        "total_drawings": total_drawings,
        "unique_users": unique_users,
        "first_drawing": first_drawing,
        "last_drawing": last_drawing
    }