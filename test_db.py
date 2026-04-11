import sqlite3
from app.database import get_connection, init_db

def test_database():
    """Test database connection and user data"""
    print("=== Testing database connection and user data ===")
    
    # Initialize database
    print("1. Initializing database...")
    init_db()
    print("   [OK] Database initialized")
    
    # Test connection
    print("\n2. Testing database connection...")
    try:
        conn = get_connection()
        cursor = conn.cursor()
        print("   [OK] Database connected")
        
        # Check users table
        print("\n3. Checking users table...")
        cursor.execute("SELECT COUNT(*) FROM users")
        user_count = cursor.fetchone()[0]
        print(f"   User count: {user_count}")
        
        if user_count > 0:
            cursor.execute("SELECT id, name, secret_key FROM users")
            users = cursor.fetchall()
            print("   User list:")
            for user_id, name, secret_key in users:
                print(f"     ID: {user_id}, Name: {name}, Secret: {secret_key}")
        
        # Check login_log table
        print("\n4. Checking login_log table...")
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='login_log'")
        if cursor.fetchone():
            print("   [OK] login_log table exists")
            cursor.execute("SELECT COUNT(*) FROM login_log")
            log_count = cursor.fetchone()[0]
            print(f"   Login log records: {log_count}")
        else:
            print("   [ERROR] login_log table does not exist")
            
        conn.close()
        print("\n   [OK] Database test completed")
        
    except Exception as e:
        print(f"   [ERROR] Database error: {e}")

if __name__ == "__main__":
    test_database()