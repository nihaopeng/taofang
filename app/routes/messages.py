from starlette.responses import RedirectResponse, JSONResponse
from starlette.requests import Request
from ..database import get_messages, add_message, delete_message, get_message_stats
import json

async def messages_page(request: Request):
    """Messages page"""
    # Check authentication
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/gate", status_code=303)
    
    # Get user info
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    # Get messages and stats
    messages = get_messages(user_id, include_private=True, limit=50)
    stats = get_message_stats(user_id)
    
    # Prepare context
    context = {
        "request": request,
        "user_name": user_name,
        "messages": messages,
        "stats": stats
    }
    
    return request.app.templates.TemplateResponse("messages.html", context)

# API endpoints for messages
async def api_get_messages(request: Request):
    """API endpoint to get messages"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    try:
        messages = get_messages(user_id, include_private=True, limit=50)
        return JSONResponse({
            "messages": messages,
            "success": True
        })
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)

async def api_add_message(request: Request):
    """API endpoint to add a message"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    try:
        data = await request.json()
        content = data.get("content", "").strip()
        is_private = data.get("is_private", False)
        
        if not content:
            return JSONResponse({"error": "留言内容不能为空", "success": False}, status_code=400)
        
        if len(content) > 1000:
            return JSONResponse({"error": "留言内容不能超过1000字符", "success": False}, status_code=400)
        
        # Add message
        message_id = add_message(user_id, user_name, content, is_private)
        
        return JSONResponse({
            "message_id": message_id,
            "success": True,
            "message": "留言发送成功"
        })
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)

async def api_delete_message(request: Request):
    """API endpoint to delete a message"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    try:
        message_id = int(request.path_params.get("message_id"))
        
        # Delete message
        success = delete_message(message_id, user_id)
        
        if success:
            return JSONResponse({
                "success": True,
                "message": "留言已删除"
            })
        else:
            return JSONResponse({
                "error": "无法删除留言（可能不属于你或不存在）",
                "success": False
            }, status_code=403)
    except (ValueError, TypeError):
        return JSONResponse({"error": "无效的消息ID", "success": False}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)