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
cat << EOF > /etc/systemd/system/taofang.service
echo "[Unit]
Description=taofang server
After=network.target
[Service]
User=root
Group=root
WorkingDirectory=/root/projects/taofang
ExecStart=$(pwd)/.venv/bin/python $(pwd)/main.py 59075
Restart=on-failure
RestartSec=5s
StandardOutput=inherit
StandardError=inherit
[Install]
WantedBy=multi-user.target
EOF

# start service
mv taofang.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable taofang.service
systemctl start taofang.service
echo "taofang service started successfully."

# show info
echo "service run on port 59075, you can check the status with: systemctl status taofang.service"