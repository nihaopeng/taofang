#!/usr/bin/env python3
"""
Simple test for HeartSync application
"""

import requests
import sys

def test_application():
    """Test basic application functionality"""
    base_url = "http://localhost:8000"
    
    print("Testing HeartSync application...")
    print("=" * 50)
    
    # Test 1: Access gate page
    print("\n1. Testing gate page access...")
    try:
        response = requests.get(f"{base_url}/gate")
        if response.status_code == 200:
            print("   [OK] Gate page accessible")
        else:
            print(f"   [FAIL] Gate page failed: {response.status_code}")
    except Exception as e:
        print(f"   [ERROR] Error accessing gate: {e}")
    
    # Test 2: Try login with wrong password
    print("\n2. Testing wrong password...")
    try:
        response = requests.post(f"{base_url}/login", data={"passphrase": "wrong-password"})
        if response.status_code == 401:
            print("   [OK] Wrong password correctly rejected")
        else:
            print(f"   [FAIL] Unexpected response: {response.status_code}")
    except Exception as e:
        print(f"   [ERROR] Error testing login: {e}")
    
    # Test 3: Create a session and test authenticated endpoints
    print("\n3. Testing authenticated endpoints...")
    session = requests.Session()
    
    try:
        # Login
        response = session.post(f"{base_url}/login", data={"passphrase": "first-love"})
        if response.status_code in [200, 303]:
            print("   [OK] Login successful")
            
            # Test dashboard
            response = session.get(f"{base_url}/")
            if response.status_code == 200:
                print("   [OK] Dashboard accessible")
            else:
                print(f"   [FAIL] Dashboard failed: {response.status_code}")
            
            # Test API endpoints
            print("\n4. Testing API endpoints...")
            
            # Love counter API
            response = session.get(f"{base_url}/api/love-counter")
            if response.status_code == 200:
                data = response.json()
                print(f"   [OK] Love counter API working (days: {data.get('days', 'N/A')})")
            else:
                print(f"   [FAIL] Love counter API failed: {response.status_code}")
            
            # Streak API
            response = session.get(f"{base_url}/api/streak")
            if response.status_code == 200:
                data = response.json()
                print(f"   [OK] Streak API working (current: {data.get('current_streak', 'N/A')})")
            else:
                print(f"   [FAIL] Streak API failed: {response.status_code}")
            
            # Check-in stats API
            response = session.get(f"{base_url}/api/checkin-stats")
            if response.status_code == 200:
                print("   [OK] Check-in stats API working")
            else:
                print(f"   [FAIL] Check-in stats API failed: {response.status_code}")
            
            # Check-in insights API
            response = session.get(f"{base_url}/api/checkin-insights")
            if response.status_code == 200:
                print("   [OK] Check-in insights API working")
            else:
                print(f"   [FAIL] Check-in insights API failed: {response.status_code}")
            
        else:
            print(f"   [FAIL] Login failed: {response.status_code}")
    except Exception as e:
        print(f"   [ERROR] Error testing authenticated endpoints: {e}")
    
    print("\n" + "=" * 50)
    print("Test completed!")

if __name__ == "__main__":
    # Check if server is running
    try:
        response = requests.get("http://localhost:8000/gate", timeout=2)
        test_application()
    except requests.ConnectionError:
        print("Error: Server is not running on http://localhost:8000")
        print("Please start the server first with: python main.py")
        sys.exit(1)