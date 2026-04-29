#!/bin/bash

port=80

# backup old db
if [ -f "app\database\heartsync.db" ]; then
    timestamp=$(date +"%Y%m%d%H%M%S")
    cp "app\database\heartsync.db" "app\database\heartsync.$timestamp.bak.db"
    echo "Existing database backed up as app\database\heartsync.$timestamp.bak.db"
fi

if [ -f "app\database\farm.db" ]; then
    timestamp=$(date +"%Y%m%d%H%M%S")
    cp "app\database\farm.db" "app\database\farm.$timestamp.bak.db"
    echo "Existing database backed up as app\database\farm.$timestamp.bak.db"
fi

# env install
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
source .venv/bin/activate
pip install -r requirements.txt

# check if env exists
if [ ! -d ".env" ]; then
    cp .env.example .env
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
ExecStart=$(pwd)/.venv/bin/python $(pwd)/main.py $port
Restart=on-failure
RestartSec=5s
StandardOutput=inherit
StandardError=inherit
[Install]
WantedBy=multi-user.target
EOF

# open double stack
if ! grep -q "net.ipv6.bindv6only=0" /etc/sysctl.conf || ! grep -q "net.ipv6.bindv6only = 0" /etc/sysctl.conf; then
    echo "Enabling dual-stack support..."
    echo "net.ipv6.bindv6only=0" >> /etc/sysctl.conf
fi

# start service
systemctl daemon-reload
systemctl enable --now taofang.service
systemctl restart taofang.service
echo "taofang service started successfully."

# show info
echo "service run on port $port, you can check the status with: systemctl status taofang.service"