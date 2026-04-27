from starlette.responses import RedirectResponse, JSONResponse
from starlette.requests import Request
from ..database import get_memories, add_memory, delete_memory
import os, uuid

UPLOAD_DIR = "app/static/uploads/memories"

async def memories_page(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/gate", status_code=303)
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    memories = get_memories(limit=50)
    
    context = {
        "request": request,
        "user_name": user_name,
        "user_id": user_id,
        "memories": memories
    }
    return request.app.templates.TemplateResponse("memories.html", context)

async def api_get_memories(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    user_id = request.session.get("user_id")
    memories = get_memories(limit=50)
    for m in memories:
        m["can_delete"] = m["user_id"] == user_id
    return JSONResponse({"memories": memories, "success": True})

async def api_add_memory(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    form = await request.form()
    photo = form.get("photo")
    caption = form.get("caption", "")
    
    if not photo or not hasattr(photo, "filename") or not photo.filename:
        return JSONResponse({"error": "请选择照片", "success": False}, status_code=400)
    
    ext = os.path.splitext(photo.filename)[1] or ".jpg"
    filename = f"{uuid.uuid4().hex}{ext}"
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filepath = os.path.join(UPLOAD_DIR, filename)
    
    content = await photo.read()
    with open(filepath, "wb") as f:
        f.write(content)
    
    photo_path = f"/static/uploads/memories/{filename}"
    memory_id = add_memory(user_id, user_name, photo_path, caption)
    
    return JSONResponse({"success": True, "message": "上传成功", "memory_id": memory_id})

async def api_delete_memory(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    user_id = request.session.get("user_id")
    memory_id = int(request.path_params.get("memory_id"))
    success = delete_memory(memory_id, user_id)
    if success:
        return JSONResponse({"success": True, "message": "已删除"})
    return JSONResponse({"error": "无法删除", "success": False}, status_code=403)
