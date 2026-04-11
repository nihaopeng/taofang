from starlette.responses import RedirectResponse, JSONResponse
from starlette.requests import Request
import json
import sqlite3
from app.database import get_connection

async def gate(request: Request):
    """Gate page for passphrase authentication"""
    return request.app.templates.TemplateResponse("gate.html", {"request": request})

async def login(request: Request):
    """Handle passphrase authentication from database"""
    form = await request.form()
    passphrase = form.get("passphrase", "").strip()
    
    if not passphrase:
        return JSONResponse(
            status_code=400,
            content={"error": "请输入真爱口令", "success": False}
        )
    
    # Query database for user with matching secret_key
    conn = get_connection()
    cursor = conn.cursor()
    
    try:
        cursor.execute("""
            SELECT id, name FROM users 
            WHERE secret_key = ?
        """, (passphrase,))
        
        user = cursor.fetchone()
        
        if user:
            user_id, user_name = user
            # Set session with user info
            request.session["authenticated"] = True
            request.session["user_id"] = user_id
            request.session["user_name"] = user_name
            
            # Log login activity
            cursor.execute("""
                INSERT INTO login_log (user_id, login_time) 
                VALUES (?, datetime('now'))
            """, (user_id,))
            
            conn.commit()
            return RedirectResponse(url="/", status_code=303)
        else:
            # Return error for wrong passphrase
            return JSONResponse(
                status_code=401,
                content={"error": "只有对的人才能进入", "success": False}
            )
    except sqlite3.Error as e:
        return JSONResponse(
            status_code=500,
            content={"error": "数据库错误", "success": False}
        )
    finally:
        conn.close()

async def logout(request: Request):
    """Logout user"""
    request.session.clear()
    return RedirectResponse(url="/gate", status_code=303)