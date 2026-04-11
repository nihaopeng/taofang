import http.client
import urllib.parse

def test_login():
    """Simple test for login functionality"""
    print("Testing login functionality...")
    
    conn = http.client.HTTPConnection("localhost", 8001)
    
    # Test 1: Try to access home page without login
    print("\n1. Access home page without login:")
    conn.request("GET", "/")
    response = conn.getresponse()
    print(f"   Status: {response.status}")
    print(f"   Location: {response.getheader('Location', 'None')}")
    
    # Test 2: Access gate page (should work)
    print("\n2. Access gate page:")
    conn.request("GET", "/gate")
    response = conn.getresponse()
    print(f"   Status: {response.status}")
    
    # Test 3: Try login with correct passphrase
    print("\n3. Login with correct passphrase:")
    params = urllib.parse.urlencode({'passphrase': 'first-love'})
    headers = {"Content-type": "application/x-www-form-urlencoded"}
    conn.request("POST", "/login", params, headers)
    response = conn.getresponse()
    print(f"   Status: {response.status}")
    print(f"   Location: {response.getheader('Location', 'None')}")
    
    # Get session cookie
    cookies = response.getheader('Set-Cookie', '')
    print(f"   Cookies: {cookies}")
    
    # Test 4: Try login with wrong passphrase
    print("\n4. Login with wrong passphrase:")
    params = urllib.parse.urlencode({'passphrase': 'wrong'})
    conn.request("POST", "/login", params, headers)
    response = conn.getresponse()
    print(f"   Status: {response.status}")
    data = response.read()
    print(f"   Response: {data.decode()}")
    
    conn.close()
    print("\nTest completed.")

if __name__ == "__main__":
    test_login()