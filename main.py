from app import create_app
import uvicorn

if __name__ == "__main__":
    app = create_app()
    print(f"Starting HeartSync application on port 8002...")
    print(f"Database initialized with users: User_A and User_B (passphrase: 'first-love')")
    uvicorn.run(app, host="0.0.0.0", port=8002, log_level="debug")