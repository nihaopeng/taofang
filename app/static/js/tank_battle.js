// ==================== 游戏核心变量 ====================
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// 游戏状态
let gameState = {
    running: false,
    paused: false,
    gameOver: false,
    winner: null,
    sessionId: 'tank_battle_default',
    player1: {
        id: 'player1',
        name: '玩家1',
        score: 0,
        health: 100,
        color: '#ff6b6b',
        position: { x: 100, y: 300 },
        direction: 0, // 角度，0表示向右
        speed: 3,
        lastFire: 0,
        fireRate: 500 // 发射间隔(ms)
    },
    player2: {
        id: 'player2',
        name: '玩家2',
        score: 0,
        health: 100,
        color: '#4ecdc4',
        position: { x: 700, y: 300 },
        direction: Math.PI, // 向左
        speed: 3,
        lastFire: 0,
        fireRate: 500
    },
    bullets: [],
    obstacles: [
        { x: 300, y: 200, width: 100, height: 50 },
        { x: 400, y: 400, width: 100, height: 50 },
        { x: 200, y: 400, width: 50, height: 100 },
        { x: 550, y: 200, width: 50, height: 100 }
    ],
    keys: {},
    lastUpdate: Date.now()
};

// WebSocket连接
let ws = null;
const userId = '{{ user_id }}';
const userName = '{{ user_name }}';
const isPlayer1 = userId === '1'; // 假设用户ID 1是玩家1，2是玩家2

// ==================== 设备检测 ====================
function detectDevice() {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const hasTouch = 'ontouchstart' in window;
    
    // 显示移动端控制
    if (isMobile || hasTouch) {
        document.getElementById('mobile-controls').style.display = 'block';
    }
    
    return { isMobile, hasTouch };
}

// ==================== 事件日志 ====================
const eventLog = document.getElementById('event-log');
function logEvent(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}\n`;
    eventLog.textContent += logEntry;
    eventLog.scrollTop = eventLog.scrollHeight;
}

function toggleDebug() {
    const log = document.getElementById('event-log');
    log.style.display = log.style.display === 'none' ? 'block' : 'none';
}

// ==================== 游戏初始化 ====================
function initGame() {
    const deviceInfo = detectDevice();
    logEvent(`设备检测: 移动设备=${deviceInfo.isMobile}, 触摸支持=${deviceInfo.hasTouch}`);
    
    // 设置画布尺寸
    const container = canvas.parentElement;
    const containerWidth = container.clientWidth;
    
    if (deviceInfo.isMobile) {
        // 移动端：自适应宽度
        canvas.width = Math.min(containerWidth, 800);
        canvas.height = Math.min(containerWidth * 0.7, 500);
    } else {
        // PC端：固定尺寸
        canvas.width = 800;
        canvas.height = 600;
    }
    
    logEvent(`游戏画布尺寸: ${canvas.width}x${canvas.height}`);
    
    // 设置玩家信息
    if (isPlayer1) {
        gameState.player1.name = userName;
        document.getElementById('player1-name').textContent = userName;
        document.getElementById('player1-name').style.color = gameState.player1.color;
    } else {
        gameState.player2.name = userName;
        document.getElementById('player2-name').textContent = userName;
        document.getElementById('player2-name').style.color = gameState.player2.color;
    }
    
    // 设置事件监听器
    setupEventListeners();
    
    // 连接WebSocket
    connectWebSocket();
    
    // 开始游戏循环
    requestAnimationFrame(gameLoop);
}

// ==================== 事件监听器设置 ====================
function setupEventListeners() {
    // 键盘事件
    window.addEventListener('keydown', (e) => {
        gameState.keys[e.key] = true;
        handleKeyPress(e.key, true);
    });
    
    window.addEventListener('keyup', (e) => {
        gameState.keys[e.key] = false;
        handleKeyPress(e.key, false);
    });
    
    // 移动端按钮事件
    const mobileButtons = ['mobile-up', 'mobile-left', 'mobile-down', 'mobile-right', 'mobile-fire', 'mobile-up2'];
    mobileButtons.forEach(btnId => {
        const btn = document.getElementById(btnId);
        if (btn) {
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                handleMobileButton(btnId, true);
            });
            btn.addEventListener('touchend', (e) => {
                e.preventDefault();
                handleMobileButton(btnId, false);
            });
            btn.addEventListener('touchcancel', (e) => {
                e.preventDefault();
                handleMobileButton(btnId, false);
            });
        }
    });
    
    // 游戏控制按钮
    document.getElementById('start-game').addEventListener('click', startGame);
    document.getElementById('pause-game').addEventListener('click', togglePause);
    document.getElementById('reset-game').addEventListener('click', resetGame);
    
    logEvent('事件监听器已设置');
}

function handleKeyPress(key, pressed) {
    if (!gameState.running || gameState.paused) return;
    
    // 发送按键消息给伙伴
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'tank_key',
            session_id: gameState.sessionId,
            key: key,
            pressed: pressed,
            user_id: userId,
            user_name: userName
        }));
    }
    
    // 本地处理按键
    const player = isPlayer1 ? gameState.player1 : gameState.player2;
    
    if (pressed) {
        switch(key) {
            case ' ':
                if (isPlayer1) fireBullet(player);
                break;
            case 'Enter':
                if (!isPlayer1) fireBullet(player);
                break;
        }
    }
}

function handleMobileButton(buttonId, pressed) {
    if (!gameState.running || gameState.paused) return;
    
    const keyMap = {
        'mobile-up': isPlayer1 ? 'w' : 'ArrowUp',
        'mobile-left': isPlayer1 ? 'a' : 'ArrowLeft',
        'mobile-down': isPlayer1 ? 's' : 'ArrowDown',
        'mobile-right': isPlayer1 ? 'd' : 'ArrowRight',
        'mobile-fire': isPlayer1 ? ' ' : 'Enter',
        'mobile-up2': isPlayer1 ? 'ArrowUp' : 'w'
    };
    
    const key = keyMap[buttonId];
    if (key) {
        gameState.keys[key] = pressed;
        handleKeyPress(key, pressed);
    }
}

// ==================== 游戏逻辑 ====================
function startGame() {
    if (gameState.running) return;
    
    gameState.running = true;
    gameState.paused = false;
    gameState.gameOver = false;
    
    // 发送游戏开始消息
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'tank_game_start',
            session_id: gameState.sessionId,
            user_id: userId,
            user_name: userName
        }));
    }
    
    logEvent('游戏开始！');
}

function togglePause() {
    gameState.paused = !gameState.paused;
    document.getElementById('pause-game').textContent = 
        gameState.paused ? '继续游戏' : '暂停游戏';
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'tank_game_pause',
            session_id: gameState.sessionId,
            paused: gameState.paused,
            user_id: userId,
            user_name: userName
        }));
    }
    
    logEvent(gameState.paused ? '游戏暂停' : '游戏继续');
}

function resetGame() {
    // 重置游戏状态
    gameState.player1.score = 0;
    gameState.player1.health = 100;
    gameState.player1.position = { x: 100, y: 300 };
    gameState.player1.direction = 0;
    
    gameState.player2.score = 0;
    gameState.player2.health = 100;
    gameState.player2.position = { x: 700, y: 300 };
    gameState.player2.direction = Math.PI;
    
    gameState.bullets = [];
    gameState.running = false;
    gameState.paused = false;
    gameState.gameOver = false;
    gameState.winner = null;
    
    // 更新UI
    updateUI();
    
    // 发送重置消息
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'tank_game_reset',
            session_id: gameState.sessionId,
            user_id: userId,
            user_name: userName
        }));
    }
    
    logEvent('游戏已重置');
}

function fireBullet(player) {
    const now = Date.now();
    if (now - player.lastFire < player.fireRate) return;
    
    player.lastFire = now;
    
    const bullet = {
        x: player.position.x + Math.cos(player.direction) * 25,
        y: player.position.y + Math.sin(player.direction) * 25,
        vx: Math.cos(player.direction) * 8,
        vy: Math.sin(player.direction) * 8,
        owner: player.id,
        color: player.color,
        createdAt: now
    };
    
    gameState.bullets.push(bullet);
    
    // 发送发射消息
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'tank_fire',
            session_id: gameState.sessionId,
            bullet: bullet,
            user_id: userId,
            user_name: userName
        }));
    }
    
    logEvent(`${player.name} 发射了炮弹`);
}

function updateGame() {
    if (!gameState.running || gameState.paused || gameState.gameOver) return;
    
    const now = Date.now();
    const deltaTime = now - gameState.lastUpdate;
    gameState.lastUpdate = now;
    
    // 更新玩家1位置
    updatePlayerPosition(gameState.player1);
    
    // 更新玩家2位置
    updatePlayerPosition(gameState.player2);
    
    // 更新炮弹位置
    for (let i = gameState.bullets.length - 1; i >= 0; i--) {
        const bullet = gameState.bullets[i];
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;
        
        // 边界检查
        if (bullet.x < 0 || bullet.x > canvas.width || 
            bullet.y < 0 || bullet.y > canvas.height ||
            now - bullet.createdAt > 3000) {
            gameState.bullets.splice(i, 1);
            continue;
        }
        
        // 碰撞检测
        checkBulletCollision(bullet, i);
    }
    
    // 检查游戏结束条件
    if (gameState.player1.health <= 0 || gameState.player2.health <= 0) {
        gameState.gameOver = true;
        gameState.winner = gameState.player1.health > 0 ? gameState.player1 : gameState.player2;
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'tank_game_over',
                session_id: gameState.sessionId,
                winner: gameState.winner.id,
                user_id: userId,
                user_name: userName
            }));
        }
        
        logEvent(`游戏结束！${gameState.winner.name} 获胜！`);
    }
    
    // 更新UI
    updateUI();
}

function updatePlayerPosition(player) {
    // 根据按键更新方向
    const keys = gameState.keys;
    let moveX = 0, moveY = 0;
    
    if (player.id === 'player1') {
        if (keys['w'] || keys['W']) moveY -= 1;
        if (keys['s'] || keys['S']) moveY += 1;
        if (keys['a'] || keys['A']) moveX -= 1;
        if (keys['d'] || keys['D']) moveX += 1;
    } else {
        if (keys['ArrowUp']) moveY -= 1;
        if (keys['ArrowDown']) moveY += 1;
        if (keys['ArrowLeft']) moveX -= 1;
        if (keys['ArrowRight']) moveX += 1;
    }
    
    // 更新方向
    if (moveX !== 0 || moveY !== 0) {
        player.direction = Math.atan2(moveY, moveX);
    }
    
    // 计算新位置
    const newX = player.position.x + Math.cos(player.direction) * player.speed;
    const newY = player.position.y + Math.sin(player.direction) * player.speed;
    
    // 边界检查
    if (newX >= 20 && newX <= canvas.width - 20) {
        player.position.x = newX;
    }
    if (newY >= 20 && newY <= canvas.height - 20) {
        player.position.y = newY;
    }
    
    // 障碍物碰撞检测
    for (const obstacle of gameState.obstacles) {
        if (checkCollision(player.position.x, player.position.y, 20, obstacle)) {
            // 如果碰撞，回退到之前的位置
            player.position.x -= Math.cos(player.direction) * player.speed;
            player.position.y -= Math.sin(player.direction) * player.speed;
            break;
        }
    }
}

function checkBulletCollision(bullet, bulletIndex) {
    // 检查与玩家的碰撞
    const players = [gameState.player1, gameState.player2];
    for (const player of players) {
        if (bullet.owner === player.id) continue; // 不能打自己
        
        const dx = bullet.x - player.position.x;
        const dy = bullet.y - player.position.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < 25) { // 碰撞半径
            // 击中玩家
            player.health -= 10;
            if (player.health < 0) player.health = 0;
            
            // 给发射者加分
            const shooter = bullet.owner === 'player1' ? gameState.player1 : gameState.player2;
            shooter.score += 1;
            
            // 移除炮弹
            gameState.bullets.splice(bulletIndex, 1);
            
            // 发送击中消息
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'tank_hit',
                    session_id: gameState.sessionId,
                    shooter: shooter.id,
                    target: player.id,
                    damage: 10,
                    user_id: userId,
                    user_name: userName
                }));
            }
            
            logEvent(`${shooter.name} 击中了 ${player.name}`);
            return;
        }
    }
    
    // 检查与障碍物的碰撞
    for (const obstacle of gameState.obstacles) {
        if (checkCollision(bullet.x, bullet.y, 5, obstacle)) {
            gameState.bullets.splice(bulletIndex, 1);
            return;
        }
    }
}

function checkCollision(x, y, radius, rect) {
    const closestX = Math.max(rect.x, Math.min(x, rect.x + rect.width));
    const closestY = Math.max(rect.y, Math.min(y, rect.y + rect.height));
    const distanceX = x - closestX;
    const distanceY = y - closestY;
    return (distanceX * distanceX + distanceY * distanceY) < (radius * radius);
}

// ==================== 渲染函数 ====================
function render() {
    // 清空画布
    ctx.fillStyle = '#0f3460';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 绘制障碍物
    ctx.fillStyle = '#555';
    gameState.obstacles.forEach(obstacle => {
        ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
        ctx.strokeStyle = '#333';
        ctx.strokeRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
    });
    
    // 绘制玩家
    renderPlayer(gameState.player1);
    renderPlayer(gameState.player2);
    
    // 绘制炮弹
    gameState.bullets.forEach(bullet => {
        ctx.fillStyle = bullet.color;
        ctx.beginPath();
        ctx.arc(bullet.x, bullet.y, 5, 0, Math.PI * 2);
        ctx.fill();
        
        // 炮弹轨迹
        ctx.strokeStyle = bullet.color + '80';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bullet.x - bullet.vx * 2, bullet.y - bullet.vy * 2);
        ctx.lineTo(bullet.x, bullet.y);
        ctx.stroke();
    });
    
    // 绘制游戏状态
    if (gameState.gameOver) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = '#ffd166';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('游戏结束！', canvas.width / 2, canvas.height / 2 - 50);
        
        ctx.fillStyle = '#4ecdc4';
        ctx.font = 'bold 36px Arial';
        ctx.fillText(`${gameState.winner.name} 获胜！`, canvas.width / 2, canvas.height / 2 + 20);
        
        ctx.fillStyle = '#ff6b6b';
        ctx.font = '24px Arial';
        ctx.fillText('点击"重新开始"按钮再来一局', canvas.width / 2, canvas.height / 2 + 80);
    }
}

function renderPlayer(player) {
    // 绘制坦克车身
    ctx.save();
    ctx.translate(player.position.x, player.position.y);
    ctx.rotate(player.direction);
    
    // 车身
    ctx.fillStyle = player.color;
    ctx.fillRect(-20, -15, 40, 30);
    
    // 炮管
    ctx.fillStyle = '#333';
    ctx.fillRect(0, -5, 30, 10);
    
    // 履带
    ctx.fillStyle = '#222';
    ctx.fillRect(-25, -20, 50, 5);
    ctx.fillRect(-25, 15, 50, 5);
    
    ctx.restore();
    
    // 绘制玩家名称
    ctx.fillStyle = player.color;
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(player.name, player.position.x, player.position.y - 30);
}

function updateUI() {
    // 更新玩家1信息
    document.getElementById('player1-score').textContent = gameState.player1.score;
    document.getElementById('player1-health').style.width = `${gameState.player1.health}%`;
    
    // 更新玩家2信息
    document.getElementById('player2-score').textContent = gameState.player2.score;
    document.getElementById('player2-health').style.width = `${gameState.player2.health}%`;
    
    // 更新按钮状态
    document.getElementById('start-game').disabled = gameState.running;
    document.getElementById('pause-game').disabled = !gameState.running;
}

// ==================== 游戏循环 ====================
function gameLoop() {
    updateGame();
    render();
    requestAnimationFrame(gameLoop);
}

// ==================== WebSocket功能 ====================
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = function() {
        logEvent('WebSocket连接已建立');
        updateStatus('connected', '✅ 已连接到服务器');
        
        // 1. 必须先发送 auth 消息，否则后端不记录你的 session
        ws.send(JSON.stringify({
            type: 'auth',
            user_id: userId,
            user_name: userName
        }));

        // 加入坦克大战会话
        ws.send(JSON.stringify({
            type: 'tank_join',
            session_id: gameState.sessionId,
            user_id: userId,
            user_name: userName,
            color: isPlayer1 ? gameState.player1.color : gameState.player2.color,
            is_player1: isPlayer1
        }));
    };
    
    ws.onmessage = function(event) {
        try {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        } catch (error) {
            logEvent(`消息解析错误: ${error}`);
        }
    };
    
    ws.onclose = function() {
        logEvent('WebSocket连接已关闭');
        updateStatus('disconnected', '❌ 连接断开，正在重连...');
        
        // 3秒后重连
        setTimeout(connectWebSocket, 3000);
    };
    
    ws.onerror = function(error) {
        logEvent(`WebSocket错误: ${error}`);
        updateStatus('disconnected', '❌ 连接错误');
    };
}

function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'tank_users_update':
            updateUsersList(message.users);
            break;
            
        case 'tank_key':
            // 处理伙伴的按键
            if (message.user_id !== userId) {
                gameState.keys[message.key] = message.pressed;
                logEvent(`伙伴按键: ${message.key} = ${message.pressed}`);
            }
            break;
            
        case 'tank_fire':
            // 处理伙伴发射的炮弹
            if (message.user_id !== userId) {
                gameState.bullets.push(message.bullet);
                logEvent(`伙伴发射了炮弹`);
            }
            break;
            
        case 'tank_hit':
            // 处理伙伴击中事件
            if (message.user_id !== userId) {
                const shooter = message.shooter === 'player1' ? gameState.player1 : gameState.player2;
                const target = message.target === 'player1' ? gameState.player1 : gameState.player2;
                
                target.health -= message.damage;
                if (target.health < 0) target.health = 0;
                shooter.score += 1;
                
                logEvent(`伙伴击中: ${shooter.name} → ${target.name}`);
            }
            break;
            
        case 'tank_game_start':
            if (message.user_id !== userId) {
                gameState.running = true;
                gameState.paused = false;
                logEvent('伙伴开始了游戏');
            }
            break;
            
        case 'tank_game_pause':
            if (message.user_id !== userId) {
                gameState.paused = message.paused;
                document.getElementById('pause-game').textContent = 
                    gameState.paused ? '继续游戏' : '暂停游戏';
                logEvent(`伙伴${message.paused ? '暂停' : '继续'}了游戏`);
            }
            break;
            
        case 'tank_game_reset':
            if (message.user_id !== userId) {
                resetGame();
                logEvent('伙伴重置了游戏');
            }
            break;
            
        case 'tank_game_over':
            if (message.user_id !== userId) {
                gameState.gameOver = true;
                gameState.winner = message.winner === 'player1' ? gameState.player1 : gameState.player2;
                logEvent(`伙伴宣布游戏结束: ${gameState.winner.name} 获胜`);
            }
            break;
            
        case 'pong':
            // 心跳响应
            break;
            
        default:
            logEvent(`未知消息类型: ${message.type}`);
    }
}

function updateUsersList(users) {
    const usersSection = document.getElementById('players-section');
    usersSection.innerHTML = '';
    
    Object.values(users).forEach(user => {
        const playerBadge = document.createElement('div');
        playerBadge.className = 'player-badge';
        playerBadge.innerHTML = `
            <div class="player-color" style="background-color: ${user.color};"></div>
            <span style="font-weight: bold;">${user.name}</span>
            <span style="opacity: 0.8;">(${user.is_player1 ? '玩家1' : '玩家2'})</span>
        `;
        usersSection.appendChild(playerBadge);
    });
    
    // 更新伙伴状态
    const partnerStatus = document.getElementById('partner-status');
    const userCount = Object.keys(users).length;
    
    if (userCount > 1) {
        partnerStatus.textContent = ` 👥 ${userCount-1} 位伙伴在线`;
        partnerStatus.style.color = '#4ecdc4';
    } else {
        partnerStatus.textContent = ' ⏳ 等待伙伴加入...';
        partnerStatus.style.color = '#ff6b6b';
    }
}

function updateStatus(status, text) {
    const statusElement = document.getElementById('status-text');
    const connectionStatus = document.getElementById('connection-status');
    
    statusElement.textContent = text;
    
    if (status === 'connected') {
        connectionStatus.classList.remove('disconnected');
        connectionStatus.classList.add('connected');
    } else {
        connectionStatus.classList.remove('connected');
        connectionStatus.classList.add('disconnected');
    }
}

// ==================== 页面初始化 ====================
window.addEventListener('load', function() {
    logEvent('页面加载完成');
    initGame();
    
    // 窗口大小变化时重新初始化
    window.addEventListener('resize', function() {
        logEvent('窗口大小变化，重新初始化画板');
        initGame();
    });
    
    // 心跳保持连接
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
    
    // 初始提示
    const deviceInfo = detectDevice();
    if (deviceInfo.isMobile) {
        setTimeout(() => {
            alert('🎮 双人坦克大战已就绪！\n\n使用屏幕按钮控制坦克移动和发射炮弹。\n\n需要两人同时在线才能开始游戏。');
        }, 1000);
    }
});