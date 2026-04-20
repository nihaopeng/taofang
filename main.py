import socket

from app import create_app
import uvicorn

def run_server(port=8002):
    # 创建一个支持 IPv6 的 socket
    sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    
    # 关键步骤：显式关闭 V6ONLY，强制开启双栈
    # 这样 [::] 就能同时处理 IPv4 和 IPv6
    try:
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    except (AttributeError, socket.error):
        # 某些老版本系统可能不支持
        pass

    sock.bind(("::", port))
    
    config = uvicorn.Config(app=app, log_level="debug")
    server = uvicorn.Server(config)
    
    # 将手动创建的 socket 传给 uvicorn
    server.run(sockets=[sock])

if __name__ == "__main__":
    import sys
    app = create_app()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8002
    print(f"Starting HeartSync application on port {port}...")
    run_server(port = port)