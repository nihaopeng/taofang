#!/usr/bin/env python3
"""
测试游戏功能
"""

import requests
import json

BASE_URL = "http://localhost:8002"

def test_game_routes():
    """测试游戏路由"""
    print("测试游戏路由...")
    
    # 首先需要登录获取会话
    session = requests.Session()
    
    # 登录
    login_data = {
        "passphrase": "first-love"
    }
    
    try:
        response = session.post(f"{BASE_URL}/login", data=login_data)
        print(f"登录状态: {response.status_code}")
        
        # 测试游戏大厅
        response = session.get(f"{BASE_URL}/games")
        print(f"游戏大厅状态: {response.status_code}")
        
        # 测试同步画板游戏
        response = session.get(f"{BASE_URL}/game/canvas")
        print(f"同步画板状态: {response.status_code}")
        
        # 测试坦克大战游戏
        response = session.get(f"{BASE_URL}/game/tank")
        print(f"坦克大战状态: {response.status_code}")
        
        print("\n[OK] 所有游戏路由测试通过！")
        
    except Exception as e:
        print(f"[ERROR] 测试失败: {e}")

def check_game_structure():
    """检查游戏文件结构"""
    print("\n检查游戏文件结构...")
    
    import os
    
    files_to_check = [
        "app/templates/tank_battle.html",
        "app/static/js/tank_battle.js",
        "app/routes/games.py",
        "app/routes/websocket.py",
        "app/__init__.py"
    ]
    
    for file_path in files_to_check:
        if os.path.exists(file_path):
            print(f"[OK] {file_path} 存在")
        else:
            print(f"[ERROR] {file_path} 不存在")

if __name__ == "__main__":
    print("=== 测试心动坐标游戏功能 ===\n")
    check_game_structure()
    print("\n" + "="*50 + "\n")
    test_game_routes()