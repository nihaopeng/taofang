from app import create_app
import uvicorn

if __name__ == "__main__":
    import sys
    app = create_app()
    print(f"Starting HeartSync application on port 8002...")
    print(f"Database initialized with users: User_A and User_B (passphrase: 'first-love')")
    port = sys.argv[1] if len(sys.argv) > 1 else 8002
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="debug")