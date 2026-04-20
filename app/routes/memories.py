from starlette.responses import RedirectResponse
from starlette.requests import Request

async def memories_page(request: Request):
    """Memories page (placeholder)"""
    # Check authentication
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/gate", status_code=303)
    
    # Get user info
    user_name = request.session.get("user_name")
    
    # Prepare context
    context = {
        "request": request,
        "user_name": user_name
    }
    
    return request.app.templates.TemplateResponse("memories.html", context)