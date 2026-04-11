import socket
import threading

def simple_server():
    """A simple test server to verify networking works"""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    
    try:
        server.bind(('127.0.0.1', 9999))
        server.listen(1)
        print(f"Test server listening on 127.0.0.1:9999")
        
        # Accept one connection
        client, addr = server.accept()
        print(f"Accepted connection from {addr}")
        
        # Send a simple response
        response = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHello World"
        client.send(response)
        client.close()
        
    except Exception as e:
        print(f"Server error: {e}")
    finally:
        server.close()

def test_client():
    """Test connecting to the server"""
    import time
    time.sleep(1)  # Give server time to start
    
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        client.connect(('127.0.0.1', 9999))
        print("Client: Connected to server")
        
        # Send a request
        client.send(b"GET / HTTP/1.1\r\n\r\n")
        
        # Receive response
        response = client.recv(1024)
        print(f"Client: Received: {response[:50]}...")
        
    except Exception as e:
        print(f"Client error: {e}")
    finally:
        client.close()

if __name__ == "__main__":
    # Start server in a thread
    server_thread = threading.Thread(target=simple_server)
    server_thread.daemon = True
    server_thread.start()
    
    # Test client
    test_client()