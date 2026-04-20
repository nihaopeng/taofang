// ==================== 游戏核心变量 ====================
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// 游戏状态
let gameState = {
    running: false,
    paused: false,
    gameOver: false,
    winner: null,
    sessionId: 'ping_pong_default',
    player1: {
        id: 'player1',
        name: '玩家1',
        score: 0,
        color: '#ff6b6b',
        paddle: {
            x: 50,
            y: 200,
            width: 15,
            height: 100,
            speed: 8
        }
    },
    player2: {
        id: 'player2',
        name: '玩家2',
        score: 0,
        color: '#4ecdc4',
        paddle: {
            x: 735,
            y: 200,
            width: 15,
            height: 100,
            speed: 8
        }
    },
    ball: {
        x: 400,
        y: 250,
        radius: 10,
        speed: 5,
        velocityX: 5,
        velocityY: 5,
        color: '#ffd166',
        serving: true,
        serveTo: 'player1' // 谁发球
    },
    keys: {},
    lastUpdate: Date.now(),
    maxScore: 11,
    gamesWon: { player1: 0, player2: 0 }
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
        canvas.height = Math.min(containerWidth * 0.7, 400);
    } else {
        // PC端：固定尺寸
        canvas.width = 800;
        canvas.height = 500;
    }
    
    // 调整球拍位置
    gameState.player1.paddle.x = 50;
    gameState.player1.paddle.y = canvas.height / 2 - 50;
    gameState.player2.paddle.x = canvas.width - 65;
    gameState.player2.paddle.y = canvas.height / 2 - 50;
    
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
    const mobileButtons = ['mobile-up', 'mobile-down', 'mobile-up2', 'mobile-down2', 'mobile-serve'];
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
            type: 'pong_key',
            session_id: gameState.sessionId,
            key: key,
            pressed: pressed,
            user_id: userId,
            user_name: userName
        }));
    }
    
    // 本地处理按键
    if (pressed) {
        switch(key) {
            case ' ':
                if (gameState.ball.serving) {
                    serveBall();
                } else {
                    togglePause();
                }
                break;
        }
    }
}

function handleMobileButton(buttonId, pressed) {
    if (!gameState.running || gameState.paused) return;
    
    const keyMap = {
        'mobile-up': isPlayer1 ? 'w' : 'ArrowUp',
        'mobile-down': isPlayer1 ? 's' : 'ArrowDown',
        'mobile-up2': isPlayer1 ? 'ArrowUp' : 'w',
        'mobile-down2': isPlayer1 ? 'ArrowDown' : 's',
        'mobile-serve': ' '
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
    
    // 重置球的位置
    resetBall();
    
    // 发送游戏开始消息
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'pong_game_start',
            session_id: gameState.sessionId,
            user_id: userId,
            user_name: userName
        }));
    }
    
    updateGameStateText('游戏开始！');
    logEvent('游戏开始！');
}

function togglePause() {
    gameState.paused = !gameState.paused;
    document.getElementById('pause-game').textContent = 
        gameState.paused ? '继续游戏' : '暂停游戏';
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'pong_game_pause',
            session_id: gameState.sessionId,
            paused: gameState.paused,
            user_id: userId,
            user_name: userName
        }));
    }
    
    updateGameStateText(gameState.paused ? '游戏暂停' : '游戏继续');
    logEvent(gameState.paused ? '游戏暂停' : '游戏继续');
}

function resetGame() {
    // 重置游戏状态
    gameState.player1.score = 0;
    gameState.player2.score = 0;
    gameState.gamesWon = { player1: 0, player2: 0 };
    
    resetBall();
    gameState.running = false;
    gameState.paused = false;
    gameState.gameOver = false;
    gameState.winner = null;
    
    // 更新UI
    updateUI();
    updateGameStateText('等待开始...');
    
    // 发送重置消息
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'pong_game_reset',
            session_id: gameState.sessionId,
            user_id: userId,
            user_name: userName
        }));
    }
    
    logEvent('游戏已重置');
}

function resetBall() {
    gameState.ball.x = canvas.width / 2;
    gameState.ball.y = canvas.height / 2;
    gameState.ball.serving = true;
    
    // 随机决定发球方向
    gameState.ball.velocityX = (Math.random() > 0.5 ? 1 : -1) * gameState.ball.speed;
    gameState.ball.velocityY = (Math.random() * 2 - 1) * gameState.ball.speed;
    
    // 决定谁发球
    gameState.ball.serveTo = (gameState.player1.score + gameState.player2.score) % 2 === 0 ? 'player1' : 'player2';
    
    if (gameState.ball.serveTo === 'player1') {
        gameState.ball.x = gameState.player1.paddle.x + gameState.player1.paddle.width + 20;
    } else {
        gameState.ball.x = gameState.player2.paddle.x - 20;
        gameState.ball.velocityX = -gameState.ball.velocityX;
    }
}

function serveBall() {
    if (!gameState.ball.serving) return;
    
    gameState.ball.serving = false;
    
    // 发送发球消息
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'pong_serve',
            session_id: gameState.sessionId,
            user_id: userId,
            user_name: userName
        }));
    }
    
    logEvent('发球！');
}

function updateGame() {
    if (!gameState.running || gameState.paused || gameState.gameOver) return;
    
    const now = Date.now();
    const deltaTime = now - gameState.lastUpdate;
    gameState.lastUpdate = now;
    
    // 更新球拍位置
    updatePaddlePosition(gameState.player1);
    updatePaddlePosition(gameState.player2);
    
    // 如果球在发球状态，不移动
    if (!gameState.ball.serving) {
        // 更新球的位置
        gameState.ball.x += gameState.ball.velocityX;
        gameState.ball.y += gameState.ball.velocityY;
        
        // 球与上下墙壁碰撞
        if (gameState.ball.y - gameState.ball.radius < 0 || 
            gameState.ball.y + gameState.ball.radius > canvas.height) {
            gameState.ball.velocityY = -gameState.ball.velocityY;
        }
        
        // 球与球拍碰撞
        checkPaddleCollision(gameState.player1);
        checkPaddleCollision(gameState.player2);
        
        // 检查得分
        checkScore();
    }
    
    // 更新UI
    updateUI();
}

function updatePaddlePosition(player) {
    const paddle = player.paddle;
    let moveY = 0;
    
    if (player.id === 'player1') {
        if (gameState.keys['w'] || gameState.keys['W']) moveY -= 1;
        if (gameState.keys['s'] || gameState.keys['S']) moveY += 1;
    } else {
        if (gameState.keys['ArrowUp']) moveY -= 1;
        if (gameState.keys['ArrowDown']) moveY += 1;
    }
    
    // 更新位置
    paddle.y += moveY * paddle.speed;
    
    // 边界检查
    if (paddle.y < 0) paddle.y = 0;
    if (paddle.y + paddle.height > canvas.height) paddle.y = canvas.height - paddle.height;
}

function checkPaddleCollision(player) {
    const paddle = player.paddle;
    const ball = gameState.ball;
    
    // 检查碰撞
    if (ball.x - ball.radius < paddle.x + paddle.width &&
        ball.x + ball.radius > paddle.x &&
        ball.y - ball.radius < paddle.y + paddle.height &&
        ball.y + ball.radius > paddle.y) {
        
        // 计算碰撞点
        let collidePoint = (ball.y - (paddle.y + paddle.height / 2));
        collidePoint = collidePoint / (paddle.height / 2);
        
        // 计算反弹角度
        let angleRad = collidePoint * (Math.PI / 4);
        
        // 计算方向
        let direction = (ball.x < canvas.width / 2) ? 1 : -1;
        
        // 更新球的速度
        ball.velocityX = direction * ball.speed * Math.cos(angleRad);
        ball.velocityY = ball.speed * Math.sin(angleRad);
        
        // 增加球速
        ball.speed += 0.2;
        
        // 发送碰撞消息
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'pong_collision',
                session_id: gameState.sessionId,
                player: player.id,
                ball: gameState.ball,
                user_id: userId,
                user_name: userName
            }));
        }
        
        logEvent(`${player.name} 击中了球`);
    }
}

function checkScore() {
    const ball = gameState.ball;
    
    // 玩家2得分
    if (ball.x - ball.radius < 0) {
        gameState.player2.score++;
        resetBall();
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'pong_score',
                session_id: gameState.sessionId,
                player: 'player2',
                score: gameState.player2.score,
                user_id: userId,
                user_name: userName
            }));
        }
        
        logEvent(`玩家2得分！当前比分: ${gameState.player1.score}-${gameState.player2.score}`);
    }
    
    // 玩家1得分
    if (ball.x + ball.radius > canvas.width) {
        gameState.player1.score++;
        resetBall();
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'pong_score',
                session_id: gameState.sessionId,
                player: 'player1',
                score: gameState.player1.score,
                user_id: userId,
                user_name: userName
            }));
        }
        
        logEvent(`玩家1得分！当前比分: ${gameState.player1.score}-${gameState.player2.score}`);
    }
    
    // 检查游戏结束
    if (gameState.player1.score >= gameState.maxScore || gameState.player2.score >= gameState.maxScore) {
        endGame();
    }
}

function endGame() {
    gameState.gameOver = true;
    gameState.winner = gameState.player1.score > gameState.player2.score ? gameState.player1 : gameState.player2;
    
    // 更新获胜局数
    gameState.gamesWon[gameState.winner.id]++;
    
    // 检查比赛结束（赢得3局）
    if (gameState.gamesWon.player1 >= 3 || gameState.gamesWon.player2 >= 3) {
        updateGameStateText(`比赛结束！${gameState.winner.name} 赢得比赛！`);
    } else {
        updateGameStateText(`第${gameState.gamesWon.player1 + gameState.gamesWon.player2}局结束！${gameState.winner.name} 获胜！`);
        
        // 3秒后开始下一局
        setTimeout(() => {
            gameState.player1.score = 0;
            gameState.player2.score = 0;
            resetBall();
            gameState.gameOver = false;
            gameState.running = true;
            updateGameStateText('新的一局开始！');
        }, 3000);
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'pong_game_over',
            session_id: gameState.sessionId,
            winner: gameState.winner.id,
            games_won: gameState.gamesWon,
            user_id: userId,
            user_name: userName
        }));
    }
    
    logEvent(`游戏结束！${gameState.winner.name} 获胜！`);
}

// ==================== 渲染函数 ====================
function render() {
    // 清空画布
    ctx.fillStyle = '#0f3460';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 绘制中线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // 绘制球拍
    renderPaddle(gameState.player1);
    renderPaddle(gameState.player2);
    
    // 绘制球
    renderBall();
    
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
        ctx.fillText(`局分: ${gameState.gamesWon.player1}-${gameState.gamesWon.player2}`, canvas.width / 2, canvas.height / 2 + 80);
    }
}

function renderPaddle(player) {
    const paddle = player.paddle;
    
    // 绘制球拍
    ctx.fillStyle = player.color;
    ctx.fillRect(paddle.x, paddle.y, paddle.width, paddle.height);
    
    // 绘制边框
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(paddle.x, paddle.y, paddle.width, paddle.height);
    
    // 绘制玩家名称
    ctx.fillStyle = player.color;
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    
    if (player.id === 'player1') {
        ctx.fillText(player.name, paddle.x + paddle.width / 2, paddle.y - 10);
    } else {
        ctx.fillText(player.name, paddle.x + paddle.width / 2, paddle.y - 10);
    }
}

function renderBall() {
    const ball = gameState.ball;
    
    // 绘制球
    ctx.fillStyle = ball.color;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    ctx.fill();
    
    // 绘制球的高光
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(ball.x - ball.radius * 0.3, ball.y - ball.radius * 0.3, ball.radius * 0.4, 0, Math.PI * 2);
    ctx.fill();
    
    // 如果正在发球，显示发球指示
    if (ball.serving) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('按空格键发球', canvas.width / 2, canvas.height - 30);
    }
}

function updateUI() {
    // 更新玩家分数
    document.getElementById('player1-score').textContent = gameState.player1.score;
    document.getElementById('player2-score').textContent = gameState.player2.score;
    
    // 更新按钮状态
    document.getElementById('start-game').disabled = gameState.running;
    document.getElementById('pause-game').disabled = !gameState.running;
    
    // 更新游戏状态文本
    if (gameState.ball.serving && gameState.running) {
        updateGameStateText(`${gameState.ball.serveTo === 'player1' ? gameState.player1.name : gameState.player2.name} 发球`);
    }
}

function updateGameStateText(text) {
    document.getElementById('game-state').textContent = text;
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

        // 加入乒乓球会话
        ws.send(JSON.stringify({
            type: 'pong_join',
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
        case 'pong_users_update':
            updateUsersList(message.users);
            break;
            
        case 'pong_key':
            // 处理伙伴的按键
            if (message.user_id !== userId) {
                gameState.keys[message.key] = message.pressed;
                logEvent(`伙伴按键: ${message.key} = ${message.pressed}`);
            }
            break;
            
        case 'pong_serve':
            // 处理伙伴发球
            if (message.user_id !== userId) {
                gameState.ball.serving = false;
                logEvent('伙伴发球了');
            }
            break;
            
        case 'pong_collision':
            // 处理伙伴击球
            if (message.user_id !== userId) {
                gameState.ball = message.ball;
                logEvent(`伙伴击中了球`);
            }
            break;
            
        case 'pong_score':
            // 处理伙伴得分
            if (message.user_id !== userId) {
                const player = message.player === 'player1' ? gameState.player1 : gameState.player2;
                player.score = message.score;
                resetBall();
                logEvent(`伙伴得分: ${player.name} ${player.score}分`);
            }
            break;
            
        case 'pong_game_start':
            if (message.user_id !== userId) {
                gameState.running = true;
                gameState.paused = false;
                resetBall();
                logEvent('伙伴开始了游戏');
            }
            break;
            
        case 'pong_game_pause':
            if (message.user_id !== userId) {
                gameState.paused = message.paused;
                document.getElementById('pause-game').textContent = 
                    gameState.paused ? '继续游戏' : '暂停游戏';
                logEvent(`伙伴${message.paused ? '暂停' : '继续'}了游戏`);
            }
            break;
            
        case 'pong_game_reset':
            if (message.user_id !== userId) {
                resetGame();
                logEvent('伙伴重置了游戏');
            }
            break;
            
        case 'pong_game_over':
            if (message.user_id !== userId) {
                gameState.gameOver = true;
                gameState.winner = message.winner === 'player1' ? gameState.player1 : gameState.player2;
                gameState.gamesWon = message.games_won;
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
            alert('🏓 双人乒乓球已就绪！\n\n使用屏幕按钮控制球拍移动和发球。\n\n需要两人同时在线才能开始游戏。');
        }, 1000);
    }
});