#!/usr/bin/env python3
"""
Test script for HeartSync application
"""

import asyncio
import aiohttp
import sys

async def test_application():
    """Test basic application functionality"""
    base_url = "http://localhost:8000"
    
    async with aiohttp.ClientSession() as session:
        print("Testing HeartSync application...")
        print("=" * 50)
        
        # Test 1: Access gate page (should work)
        print("\n1. Testing gate page access...")
        try:
            async with session.get(f"{base_url}/gate") as response:
                if response.status == 200:
                    print("   ✓ Gate page accessible")
                else:
                    print(f"   ✗ Gate page failed: {response.status}")
        except Exception as e:
            print(f"   ✗ Error accessing gate: {e}")
        
        # Test 2: Try login with wrong password
        print("\n2. Testing wrong password...")
        try:
            form_data = aiohttp.FormData()
            form_data.add_field('passphrase', 'wrong-password')
            
            async with session.post(f"{base_url}/login", data=form_data) as response:
                if response.status == 401:
                    print("   ✓ Wrong password correctly rejected")
                else:
                    print(f"   ✗ Unexpected response: {response.status}")
        except Exception as e:
            print(f"   ✗ Error testing login: {e}")
        
        # Test 3: Try login with correct password
        print("\n3. Testing correct password...")
        try:
            form_data = aiohttp.FormData()
            form_data.add_field('passphrase', 'first-love')
            
            async with session.post(f"{base_url}/login", data=form_data) as response:
                if response.status == 200 or response.status == 303:
                    print("   ✓ Login successful")
                    
                    # Store cookies for authenticated tests
                    cookies = session.cookie_jar.filter_cookies(base_url)
                    
                    # Test 4: Access dashboard
                    print("\n4. Testing dashboard access...")
                    async with session.get(f"{base_url}/") as dash_response:
                        if dash_response.status == 200:
                            print("   ✓ Dashboard accessible")
                        else:
                            print(f"   ✗ Dashboard failed: {dash_response.status}")
                    
                    # Test 5: Test API endpoints
                    print("\n5. Testing API endpoints...")
                    
                    # Love counter API
                    async with session.get(f"{base_url}/api/love-counter") as api_response:
                        if api_response.status == 200:
                            data = await api_response.json()
                            print(f"   ✓ Love counter API working (days: {data.get('days', 'N/A')})")
                        else:
                            print(f"   ✗ Love counter API failed: {api_response.status}")
                    
                    # Achievements API
                    async with session.get(f"{base_url}/api/achievements") as api_response:
                        if api_response.status == 200:
                            print("   ✓ Achievements API working")
                        else:
                            print(f"   ✗ Achievements API failed: {api_response.status}")
                    
                else:
                    print(f"   ✗ Login failed: {response.status}")
        except Exception as e:
            print(f"   ✗ Error testing correct login: {e}")
        
        print("\n" + "=" * 50)
        print("Test completed!")

if __name__ == "__main__":
    # Run the test
    asyncio.run(test_application())