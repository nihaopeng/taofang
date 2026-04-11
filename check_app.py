import socket
import time

def check_port(host='localhost', port=8001):
    """Check if port is open and accepting connections"""
    print(f"Checking if {host}:{port} is accepting connections...")
    
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        result = sock.connect_ex((host, port))
        sock.close()
        
        if result == 0:
            print(f"  [OK] Port {port} is open and accepting connections")
            return True
        else:
            print(f"  [ERROR] Port {port} is not accepting connections (error: {result})")
            return False
    except Exception as e:
        print(f"  [ERROR] Socket error: {e}")
        return False

def test_connection():
    """Test basic HTTP connection"""
    print("\nTesting HTTP connection...")
    
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(('localhost', 8001))
        
        # Send a simple HTTP GET request
        request = b"GET /gate HTTP/1.1\r\nHost: localhost:8001\r\n\r\n"
        sock.send(request)
        
        # Receive response
        response = sock.recv(4096)
        sock.close()
        
        print("  [OK] Received response:")
        print(response.decode('utf-8', errors='ignore')[:200])
        return True
    except Exception as e:
        print(f"  [ERROR] Connection test failed: {e}")
        return False

if __name__ == "__main__":
    print("=== Application Connection Test ===")
    
    # Check port
    if check_port():
        # Test connection
        test_connection()
    else:
        print("\nApplication may not be running. Please start it with: python main.py")