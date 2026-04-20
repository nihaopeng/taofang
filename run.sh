#!/bin/bash

# env install
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
source .venv/bin/activate
pip install -r requirements.txt

# check if env exists
if [ ! -d ".env" ]; then
    mv .env.example .env
    vim .env
fi

# build service
echo "[Unit]\n\
Description=taofang server\n\
After=network.target\n\
\n\
[Service]\n\
# 确保使用 root 用户（如果你习惯用 root 运行）\n\
User=root\n\
Group=root\n\
\n\
# 关键：指定程序的运行目录，这样代码里的相对路径才不会报错\n\
WorkingDirectory=/root/projects/taofang\n\
\n\
# 使用虚拟环境内的 Python 绝对路径\n\
# 并且确保 main.py 也是绝对路径\n\
ExecStart=$(pwd)/.venv/bin/python $(pwd)/main.py 59075\n\
\n\
# 允许程序自动重启\n\
Restart=on-failure\n\
RestartSec=5s\n\
\n\
# 捕捉错误日志，方便调试
StandardOutput=inherit\n\
StandardError=inherit\n\
\n\
[Install]\n\
WantedBy=multi-user.target\n\
" > taofang.service

# start service
mv taofang.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable taofang.service
systemctl start taofang.service
echo "taofang service started successfully."

# show info
echo "service run on port 59075, you can check the status with: systemctl status taofang.service"