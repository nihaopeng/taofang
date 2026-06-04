from starlette.responses import RedirectResponse, JSONResponse
from starlette.requests import Request
from ..database import (
    add_work_item, get_work_items, toggle_work_item, update_work_item,
    delete_work_item, get_work_stats,
    acknowledge_work_day, is_work_day_acknowledged,
)
from datetime import datetime
from zoneinfo import ZoneInfo


async def work_summary_page(request: Request):
    """Daily work summary page"""
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/gate", status_code=303)

    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")

    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
    items = get_work_items(user_id, today)
    stats = get_work_stats(user_id)

    acknowledged = is_work_day_acknowledged(user_id, today)
    has_items = len(items) > 0

    context = {
        "request": request,
        "user_name": user_name,
        "today": today,
        "items": items,
        "stats": stats,
        "has_items": has_items,
        "acknowledged": acknowledged,
    }
    return request.app.templates.TemplateResponse("work_summary.html", context)


async def api_get_work_items(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)

    user_id = request.session.get("user_id")
    date = request.query_params.get("date")

    try:
        items = get_work_items(user_id, date)
        return JSONResponse({"items": items, "success": True})
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)


async def api_add_work_item(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)

    user_id = request.session.get("user_id")

    try:
        data = await request.json()
        content = data.get("content", "").strip()
        work_date = data.get("work_date", datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"))

        if not content:
            return JSONResponse({"error": "内容不能为空", "success": False}, status_code=400)
        if len(content) > 500:
            return JSONResponse({"error": "内容不能超过500字符", "success": False}, status_code=400)

        item_id = add_work_item(user_id, content, work_date)
        return JSONResponse({"item_id": item_id, "success": True})
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)


async def api_update_work_item(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)

    user_id = request.session.get("user_id")

    try:
        item_id = int(request.path_params.get("item_id"))
        data = await request.json()
        action = data.get("action", "toggle")

        if action == "toggle":
            success = toggle_work_item(item_id, user_id)
        elif action == "edit":
            content = data.get("content", "").strip()
            if not content:
                return JSONResponse({"error": "内容不能为空", "success": False}, status_code=400)
            success = update_work_item(item_id, user_id, content)
        else:
            return JSONResponse({"error": "无效的操作", "success": False}, status_code=400)

        if success:
            return JSONResponse({"success": True})
        else:
            return JSONResponse({"error": "操作失败", "success": False}, status_code=404)
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)


async def api_delete_work_item(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)

    user_id = request.session.get("user_id")

    try:
        item_id = int(request.path_params.get("item_id"))
        success = delete_work_item(item_id, user_id)

        if success:
            return JSONResponse({"success": True})
        else:
            return JSONResponse({"error": "删除失败", "success": False}, status_code=404)
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)


async def api_get_work_stats(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)

    user_id = request.session.get("user_id")

    try:
        stats = get_work_stats(user_id)
        return JSONResponse({"stats": stats, "success": True})
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)


async def api_acknowledge_day(request: Request):
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)

    user_id = request.session.get("user_id")
    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")

    try:
        acknowledge_work_day(user_id, today)
        return JSONResponse({"success": True})
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False}, status_code=500)


async def api_check_reminders(request: Request):
    """Cron-callable endpoint to check and send reminders"""
    import os
    from ..database import check_and_send_reminders, mark_email_sent

    pending_users = check_and_send_reminders()
    if not pending_users:
        return JSONResponse({"sent": 0, "success": True})

    from ..utils.email_reminder import send_reminder_email
    from zoneinfo import ZoneInfo
    user_names = {
        1: os.getenv("USER_A_NAME", "taotao"),
        2: os.getenv("USER_B_NAME", "fangfang"),
    }
    user_emails = {
        1: os.getenv("USER_A_NOTIFY_EMAIL", ""),
        2: os.getenv("USER_B_NOTIFY_EMAIL", ""),
    }
    today_str = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
    sent_count = 0
    for uid in pending_users:
        to_email = user_emails.get(uid, "")
        if to_email and send_reminder_email(to_email, user_names.get(uid, "")):
            mark_email_sent(uid, today_str)
            sent_count += 1

    return JSONResponse({"sent": sent_count, "success": True})
