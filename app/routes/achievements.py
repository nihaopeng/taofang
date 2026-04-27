from starlette.responses import RedirectResponse
from starlette.requests import Request
from ..database import get_all_achievements, get_achievement_stats

async def achievements_page(request: Request):
    """Achievements page"""
    # Check authentication
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/gate", status_code=303)
    
    # Get user info
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    # Get achievements data
    achievements_by_category = get_all_achievements(user_id)
    stats = get_achievement_stats(user_id)
    
    # Category names and icons
    category_names = {
        "time": "恋爱时间",
        "interaction": "互动成就",
        "special": "特殊时刻",
        "milestone": "里程碑",
        "general": "一般成就"
    }
    
    category_icons = {
        "time": "⏰",
        "interaction": "💬",
        "special": "🎉",
        "milestone": "🏅",
        "general": "🏆"
    }
    
    # Prepare context
    context = {
        "request": request,
        "user_name": user_name,
        "achievements_by_category": achievements_by_category,
        "stats": stats,
        "categories": list(achievements_by_category.keys()),
        "category_names": category_names,
        "category_icons": category_icons,
        "category_count": len(achievements_by_category),
        "total_achievements": sum(len(achs) for achs in achievements_by_category.values())
    }
    
    return request.app.templates.TemplateResponse("achievements.html", context)