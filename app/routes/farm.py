from starlette.responses import JSONResponse, Response
from starlette.requests import Request
from ..database import (
    get_connection, get_farm_state, get_farm_currency, add_farm_currency,
    spend_farm_currency, get_inventory, add_to_inventory, remove_from_inventory,
    get_plot, till_plot, plant_seed, water_plot, harvest_plot,
    get_plant_def, get_fish_def, get_unlocked_plants, get_love_progress,
    update_growth_stages, init_farm_tables,
    can_claim_daily, record_daily_claim
)
from datetime import datetime
import random


def format_growth_time(seconds):
    """格式化生长时间为可读字符串"""
    if seconds >= 3600:
        h = seconds // 3600
        m = (seconds % 3600) // 60
        if m > 0:
            return f"{h}小时{m}分钟"
        return f"{h}小时"
    elif seconds >= 60:
        return f"{seconds // 60}分钟"
    else:
        return f"{seconds}秒"


async def farm_page(request: Request):
    """农场游戏页面"""
    if not request.session.get("authenticated"):
        from starlette.responses import RedirectResponse
        return RedirectResponse(url="/gate", status_code=303)
    
    user_id = request.session.get("user_id")
    user_name = request.session.get("user_name")
    
    context = {
        "request": request,
        "user_id": user_id,
        "user_name": user_name,
    }
    return request.app.templates.TemplateResponse("farm.html", context)


async def api_farm_state(request: Request):
    """获取完整农场状态"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    init_farm_tables()
    update_growth_stages()
    
    farm_state = get_farm_state()
    coins = get_farm_currency(user_id)
    inventory = get_inventory(user_id)
    days_together, both_checkins = get_love_progress()
    unlocked_plants = get_unlocked_plants(days_together, both_checkins)
    
    return JSONResponse({
        "success": True,
        "coins": coins,
        "plots": farm_state["plots"],
        "plants": farm_state["plants"],
        "fish": farm_state["fish"],
        "inventory": inventory,
        "unlocked_plants": [p["id"] for p in unlocked_plants],
        "days_together": days_together,
        "both_checkins": both_checkins,
        "claimed_checkin": not can_claim_daily(user_id, "checkin"),
        "claimed_diary": not can_claim_daily(user_id, "diary")
    })


async def api_farm_currency(request: Request):
    """获取货币"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    coins = get_farm_currency(user_id)
    return JSONResponse({"success": True, "coins": coins})


async def api_buy_seed(request: Request):
    """购买种子"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    try:
        body = await request.json()
    except:
        body = {}
    
    plant_id = body.get("plant_id", "")
    quantity = body.get("quantity", 1)
    
    plant = get_plant_def(plant_id)
    if not plant:
        return JSONResponse({"success": False, "error": "植物不存在"}, status_code=400)
    
    # 检查是否解锁
    days_together, both_checkins = get_love_progress()
    if days_together < plant["unlock_days"] or both_checkins < plant["unlock_both_checkins"]:
        return JSONResponse({"success": False, "error": "该植物尚未解锁"}, status_code=400)
    
    total_cost = plant["seed_cost"] * quantity
    if not spend_farm_currency(user_id, total_cost):
        return JSONResponse({"success": False, "error": "货币不足"}, status_code=400)
    
    add_to_inventory(user_id, "seed", plant_id, quantity)
    coins = get_farm_currency(user_id)
    inventory = get_inventory(user_id)
    
    return JSONResponse({
        "success": True,
        "message": f"购买了 {quantity} 个{plant['name']}种子",
        "coins": coins,
        "inventory": inventory
    })


async def api_till(request: Request):
    """开垦地块"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    try:
        body = await request.json()
    except:
        body = {}
    
    plot_index = body.get("plot_index", 0)
    till_plot(plot_index)
    
    update_growth_stages()
    farm_state = get_farm_state()
    
    return JSONResponse({
        "success": True,
        "message": "开垦成功",
        "plot": farm_state["plots"].get(str(plot_index), {"plot_index": plot_index, "growth_stage": 0})
    })


async def api_plant(request: Request):
    """种植种子"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    try:
        body = await request.json()
    except:
        body = {}
    
    plot_index = body.get("plot_index", 0)
    plant_type = body.get("plant_type", "")
    
    if not plant_type:
        return JSONResponse({"success": False, "error": "请选择种子"}, status_code=400)
    
    # 检查背包中是否有种子
    if not remove_from_inventory(user_id, "seed", plant_type, 1):
        return JSONResponse({"success": False, "error": "背包中没有该种子"}, status_code=400)
    
    plot = get_plot(plot_index)
    if not plot or plot["growth_stage"] != 0:
        return JSONResponse({"success": False, "error": "请先开垦土地"}, status_code=400)
    
    plant_seed(plot_index, plant_type)
    
    update_growth_stages()
    farm_state = get_farm_state()
    inventory = get_inventory(user_id)
    
    plant_def = get_plant_def(plant_type)
    
    return JSONResponse({
        "success": True,
        "message": f"种下了{plant_def['name'] if plant_def else plant_type}",
        "plot": farm_state["plots"].get(str(plot_index)),
        "inventory": inventory
    })


async def api_water(request: Request):
    """浇水"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    try:
        body = await request.json()
    except:
        body = {}
    
    plot_index = body.get("plot_index", 0)
    
    plot = get_plot(plot_index)
    if not plot or not plot["plant_type"]:
        return JSONResponse({"success": False, "error": "该地块没有种植作物"}, status_code=400)
    
    if plot["growth_stage"] >= 5:
        return JSONResponse({"success": False, "error": "作物已成熟，可以收获了"}, status_code=400)
    
    plant_def = get_plant_def(plot["plant_type"])
    water_reduction = plant_def["water_reduction"] if plant_def else 60
    
    water_plot(plot_index)
    update_growth_stages()
    
    farm_state = get_farm_state()
    updated_plot = farm_state["plots"].get(str(plot_index))
    stage_before = plot["growth_stage"]
    stage_after = updated_plot["growth_stage"] if updated_plot else stage_before
    
    reduction_text = format_growth_time(water_reduction)
    
    return JSONResponse({
        "success": True,
        "message": f"浇水成功！减少了{reduction_text}",
        "water_reduction": water_reduction,
        "stage_before": stage_before,
        "stage_after": stage_after,
        "plot": updated_plot
    })


async def api_harvest(request: Request):
    """收获作物"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    try:
        body = await request.json()
    except:
        body = {}
    
    plot_index = body.get("plot_index", 0)
    
    plant_type = harvest_plot(plot_index)
    if not plant_type:
        # 检查原因
        plot = get_plot(plot_index)
        if not plot or not plot["plant_type"]:
            return JSONResponse({"success": False, "error": "该地块没有种植作物"}, status_code=400)
        if plot["growth_stage"] < 5:
            return JSONResponse({"success": False, "error": "作物尚未成熟"}, status_code=400)
        return JSONResponse({"success": False, "error": "收获失败"}, status_code=400)
    
    # 获得作物放入背包
    add_to_inventory(user_id, "crop", plant_type, 1)
    
    update_growth_stages()
    farm_state = get_farm_state()
    inventory = get_inventory(user_id)
    plant_def = get_plant_def(plant_type)
    
    return JSONResponse({
        "success": True,
        "message": f"收获了{plant_def['name'] if plant_def else plant_type}！",
        "crop": plant_type,
        "plots": farm_state["plots"],
        "inventory": inventory
    })


async def api_sell(request: Request):
    """售卖物品"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    try:
        body = await request.json()
    except:
        body = {}
    
    item_type = body.get("item_type", "")
    item_id = body.get("item_id", "")
    quantity = body.get("quantity", 1)
    
    if not item_id:
        return JSONResponse({"success": False, "error": "请选择物品"}, status_code=400)
    
    # 获取售价
    price = 0
    item_name = item_id
    if item_type == "crop":
        plant = get_plant_def(item_id)
        if plant:
            price = plant["sell_price"]
            item_name = plant["name"]
    elif item_type == "fish":
        fish = get_fish_def(item_id)
        if fish:
            price = fish["sell_price"]
            item_name = fish["name"]
    else:
        return JSONResponse({"success": False, "error": "不支持售卖的物品类型"}, status_code=400)
    
    if not remove_from_inventory(user_id, item_type, item_id, quantity):
        return JSONResponse({"success": False, "error": "背包中物品数量不足"}, status_code=400)
    
    total_price = price * quantity
    new_coins = add_farm_currency(user_id, total_price)
    inventory = get_inventory(user_id)
    
    return JSONResponse({
        "success": True,
        "message": f"售卖了 {quantity} 个{item_name}，获得 {total_price} 金币",
        "coins": new_coins,
        "inventory": inventory
    })


async def api_fish(request: Request):
    """钓鱼"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    # 获取所有鱼类及其概率
    farm_state = get_farm_state()
    fish_defs = farm_state["fish"]
    
    # 根据稀有度计算概率
    weights = {"common": 50, "uncommon": 30, "rare": 15, "legendary": 5}
    fish_list = list(fish_defs.values())
    
    # 加权随机选择
    total_weight = sum(weights.get(f["rarity"], 10) for f in fish_list)
    roll = random.uniform(0, total_weight)
    
    cumulative = 0
    caught = None
    for f in fish_list:
        cumulative += weights.get(f["rarity"], 10)
        if roll <= cumulative:
            caught = f
            break
    
    if not caught:
        caught = fish_list[0]
    
    # 计算等待时间
    wait_time = random.uniform(caught["min_wait"], caught["max_wait"])
    
    # 加入背包
    add_to_inventory(user_id, "fish", caught["id"], 1)
    inventory = get_inventory(user_id)
    
    return JSONResponse({
        "success": True,
        "message": f"钓到了 {caught['name']}！",
        "fish": caught,
        "wait_time": wait_time,
        "inventory": inventory
    })


async def api_diary_reward(request: Request):
    """日记奖励 - 验证主系统今日是否写了日记"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    if not can_claim_daily(user_id, "diary"):
        return JSONResponse({"success": False, "error": "今日已领取日记奖励"}, status_code=400)
    
    # 验证主系统：今天是否写了日记（messages表）
    conn = get_connection()
    cursor = conn.cursor()
    today = datetime.now().strftime("%Y-%m-%d")
    cursor.execute("SELECT COUNT(*) FROM messages WHERE user_id = ? AND DATE(created_at) = ?", (user_id, today))
    has_diary_today = cursor.fetchone()[0] > 0
    conn.close()
    
    if not has_diary_today:
        return JSONResponse({"success": False, "error": "今天还没有写日记哦，先去写一篇吧！"}, status_code=400)
    
    reward = random.randint(10, 30)
    new_coins = add_farm_currency(user_id, reward)
    record_daily_claim(user_id, "diary")
    
    return JSONResponse({
        "success": True,
        "message": f"日记奖励 +{reward} 金币！",
        "coins": new_coins,
        "reward": reward
    })


async def api_checkin_reward(request: Request):
    """签到奖励 - 验证主系统今日是否已签到"""
    if not request.session.get("authenticated"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    
    user_id = request.session.get("user_id")
    
    if not can_claim_daily(user_id, "checkin"):
        return JSONResponse({"success": False, "error": "今日已领取签到奖励"}, status_code=400)
    
    # 验证主系统：今天是否签到过（daily_checkin表）
    conn = get_connection()
    cursor = conn.cursor()
    today = datetime.now().strftime("%Y-%m-%d")
    cursor.execute("SELECT COUNT(*) FROM daily_checkin WHERE user_id = ? AND DATE(checkin_time) = ?", (user_id, today))
    has_checked_in = cursor.fetchone()[0] > 0
    conn.close()
    
    if not has_checked_in:
        return JSONResponse({"success": False, "error": "今天还没有签到，请先完成签到"}, status_code=400)
    
    reward = 50
    new_coins = add_farm_currency(user_id, reward)
    record_daily_claim(user_id, "checkin")
    
    return JSONResponse({
        "success": True,
        "message": f"签到奖励 +{reward} 金币！",
        "coins": new_coins,
        "reward": reward
    })
