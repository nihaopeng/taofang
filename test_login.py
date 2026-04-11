import requests
import json

# Test login with database authentication
BASE_URL = "http://localhost:8001"

def test_login():
    """Test login with correct and incorrect passphrases"""
    
    print("=== 测试数据库登录功能 ===")
    
    # Test 1: Correct passphrase (should login as User_A)
    print("\n1. 测试正确口令 'first-love':")
    response = requests.post(f"{BASE_URL}/login", data={"passphrase": "first-love"})
    
    if response.status_code == 303:  # Redirect to dashboard
        print("   ✓ 登录成功！重定向到仪表板")
        # Check cookies
        cookies = response.cookies
        print(f"   会话Cookie: {cookies.get('session')}")
    else:
        print(f"   ✗ 登录失败: {response.status_code}")
        print(f"   响应: {response.text}")
    
    # Test 2: Incorrect passphrase
    print("\n2. 测试错误口令 'wrong-pass':")
    response = requests.post(f"{BASE_URL}/login", data={"passphrase": "wrong-pass"})
    
    if response.status_code == 401:
        print("   ✓ 正确拒绝错误口令")
        data = response.json()
        print(f"   错误信息: {data.get('error')}")
    else:
        print(f"   ✗ 预期401错误，实际: {response.status_code}")
        print(f"   响应: {response.text}")
    
    # Test 3: Empty passphrase
    print("\n3. 测试空口令:")
    response = requests.post(f"{BASE_URL}/login", data={"passphrase": ""})
    
    if response.status_code == 400:
        print("   ✓ 正确拒绝空口令")
        data = response.json()
        print(f"   错误信息: {data.get('error')}")
    else:
        print(f"   ✗ 预期400错误，实际: {response.status_code}")
        print(f"   响应: {response.text}")
    
    # Test 4: Access dashboard without login
    print("\n4. 测试未登录访问仪表板:")
    response = requests.get(f"{BASE_URL}/")
    
    if response.status_code == 200:
        # Check if redirected to gate page
        if "gate" in response.url:
            print("   ✓ 未登录用户被重定向到登录页")
        else:
            print("   ✗ 未登录用户可以直接访问仪表板 - 安全漏洞！")
    else:
        print(f"   状态码: {response.status_code}")
    
    print("\n=== 测试完成 ===")

if __name__ == "__main__":
    try:
        test_login()
    except requests.exceptions.ConnectionError:
        print("错误: 无法连接到服务器。请确保应用正在运行 (http://localhost:8001)")
    except Exception as e:
        print(f"测试过程中发生错误: {e}")