import asyncio
import sys
import os

# Add current directory to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app import create_app
import uvicorn

if __name__ == "__main__":
    app = create_app()
    
    # Print startup information
    print("=" * 50)
    print("HeartSync Application")
    print("=" * 50)
    print("Database users:")
    print("  - User_A (ID: 1, Passphrase: 'first-love')")
    print("  - User_B (ID: 2, Passphrase: 'first-love')")
    print("\nAccess URLs:")
    print("  - Login page: http://localhost:8080/gate")
    print("  - Dashboard: http://localhost:8080/ (after login)")
    print("  - Games: http://localhost:8080/games")
    print("=" * 50)
    
    # Run the app
    uvicorn.run(
        app, 
        host="127.0.0.1",  # Use 127.0.0.1 instead of 0.0.0.0
        port=8080,  # Try port 8080 instead
        log_level="info",
        access_log=True
    )