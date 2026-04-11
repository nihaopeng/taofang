import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

def create_session_with_retries():
    """Create a requests session with retry logic"""
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=0.5,
        status_forcelist=[500, 502, 503, 504],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    return session

def test_login_flow():
    """Test the complete login flow"""
    print("=== Testing Login Flow ===")
    
    session = create_session_with_retries()
    base_url = "http://127.0.0.1:8002"
    
    try:
        # Step 1: Access home page (should redirect to gate)
        print("\n1. Accessing home page (should redirect to gate)...")
        response = session.get(f"{base_url}/", allow_redirects=False)
        print(f"   Status: {response.status_code}")
        print(f"   Redirect to: {response.headers.get('Location', 'None')}")
        
        # Step 2: Access gate page
        print("\n2. Accessing gate page...")
        response = session.get(f"{base_url}/gate")
        print(f"   Status: {response.status_code}")
        print(f"   Page contains '真爱口令': {'真爱口令' in response.text}")
        
        # Step 3: Login with correct passphrase
        print("\n3. Logging in with correct passphrase...")
        login_data = {"passphrase": "first-love"}
        response = session.post(f"{base_url}/login", data=login_data, allow_redirects=False)
        print(f"   Status: {response.status_code}")
        print(f"   Redirect to: {response.headers.get('Location', 'None')}")
        
        if response.status_code == 303:
            # Follow redirect
            redirect_url = response.headers.get('Location')
            if redirect_url:
                response = session.get(f"{base_url}{redirect_url}")
                print(f"   Dashboard status: {response.status_code}")
                print(f"   Page contains user name: {'User_A' in response.text or 'User_B' in response.text}")
        
        # Step 4: Try to access home page again (should work)
        print("\n4. Accessing home page after login...")
        response = session.get(f"{base_url}/")
        print(f"   Status: {response.status_code}")
        print(f"   Page contains '心动坐标': {'心动坐标' in response.text}")
        
        # Step 5: Logout
        print("\n5. Logging out...")
        response = session.get(f"{base_url}/logout", allow_redirects=False)
        print(f"   Status: {response.status_code}")
        print(f"   Redirect to: {response.headers.get('Location', 'None')}")
        
        # Step 6: Try to access home page after logout (should redirect to gate)
        print("\n6. Accessing home page after logout...")
        response = session.get(f"{base_url}/", allow_redirects=False)
        print(f"   Status: {response.status_code}")
        print(f"   Redirect to: {response.headers.get('Location', 'None')}")
        
        print("\n=== Test Complete ===")
        
    except requests.exceptions.ConnectionError:
        print("ERROR: Cannot connect to server. Make sure the application is running.")
    except Exception as e:
        print(f"ERROR: {e}")

if __name__ == "__main__":
    test_login_flow()