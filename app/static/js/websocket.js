// WebSocket client for HeartSync

class HeartSyncWebSocket {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.messageHandlers = new Map();
        this.userId = null;
        this.userName = null;
    }
    
    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
            
            // Send user info on connect
            if (this.userId && this.userName) {
                this.send({
                    type: 'user_connect',
                    userId: this.userId,
                    userName: this.userName
                });
            }
        };
        
        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        };
        
        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this.attemptReconnect();
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }
    
    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            
            setTimeout(() => {
                this.connect();
            }, this.reconnectDelay * this.reconnectAttempts);
        } else {
            console.error('Max reconnection attempts reached');
        }
    }
    
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        } else {
            console.warn('WebSocket not connected');
            return false;
        }
    }
    
    handleMessage(message) {
        const handlers = this.messageHandlers.get(message.type) || [];
        handlers.forEach(handler => {
            try {
                handler(message);
            } catch (error) {
                console.error('Error in message handler:', error);
            }
        });
    }
    
    on(messageType, handler) {
        if (!this.messageHandlers.has(messageType)) {
            this.messageHandlers.set(messageType, []);
        }
        this.messageHandlers.get(messageType).push(handler);
    }
    
    off(messageType, handler) {
        if (this.messageHandlers.has(messageType)) {
            const handlers = this.messageHandlers.get(messageType);
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }
    
    setUserInfo(userId, userName) {
        this.userId = userId;
        this.userName = userName;
    }
    
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// Canvas Sync functionality
class CanvasSync {
    constructor(canvasElement, wsClient) {
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');
        this.wsClient = wsClient;
        this.isDrawing = false;
        this.lastX = 0;
        this.lastY = 0;
        this.color = '#ff6b6b';
        this.lineWidth = 3;
        
        this.setupCanvas();
        this.setupWebSocket();
    }
    
    setupCanvas() {
        // Set canvas size
        this.canvas.width = this.canvas.offsetWidth;
        this.canvas.height = this.canvas.offsetHeight;
        
        // Set initial style
        this.ctx.strokeStyle = this.color;
        this.ctx.lineWidth = this.lineWidth;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        // Event listeners
        this.canvas.addEventListener('mousedown', this.startDrawing.bind(this));
        this.canvas.addEventListener('mousemove', this.draw.bind(this));
        this.canvas.addEventListener('mouseup', this.stopDrawing.bind(this));
        this.canvas.addEventListener('mouseout', this.stopDrawing.bind(this));
        
        // Touch events for mobile
        this.canvas.addEventListener('touchstart', this.handleTouchStart.bind(this));
        this.canvas.addEventListener('touchmove', this.handleTouchMove.bind(this));
        this.canvas.addEventListener('touchend', this.handleTouchEnd.bind(this));
    }
    
    setupWebSocket() {
        // Listen for canvas updates from other users
        this.wsClient.on('canvas_update', (message) => {
            this.drawRemote(message.data);
        });
    }
    
    startDrawing(e) {
        this.isDrawing = true;
        [this.lastX, this.lastY] = this.getCoordinates(e);
    }
    
    draw(e) {
        if (!this.isDrawing) return;
        
        e.preventDefault();
        
        const [x, y] = this.getCoordinates(e);
        
        // Draw locally
        this.ctx.beginPath();
        this.ctx.moveTo(this.lastX, this.lastY);
        this.ctx.lineTo(x, y);
        this.ctx.stroke();
        
        // Send drawing data via WebSocket
        const drawingData = {
            fromX: this.lastX,
            fromY: this.lastY,
            toX: x,
            toY: y,
            color: this.color,
            width: this.lineWidth
        };
        
        this.wsClient.send({
            type: 'canvas_draw',
            data: drawingData
        });
        
        [this.lastX, this.lastY] = [x, y];
    }
    
    drawRemote(drawingData) {
        // Save current context state
        this.ctx.save();
        
        // Apply remote drawing settings
        this.ctx.strokeStyle = drawingData.color;
        this.ctx.lineWidth = drawingData.width;
        
        // Draw the remote line
        this.ctx.beginPath();
        this.ctx.moveTo(drawingData.fromX, drawingData.fromY);
        this.ctx.lineTo(drawingData.toX, drawingData.toY);
        this.ctx.stroke();
        
        // Restore context state
        this.ctx.restore();
    }
    
    stopDrawing() {
        this.isDrawing = false;
    }
    
    getCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        
        if (e.type.includes('touch')) {
            const touch = e.touches[0];
            return [
                touch.clientX - rect.left,
                touch.clientY - rect.top
            ];
        } else {
            return [
                e.clientX - rect.left,
                e.clientY - rect.top
            ];
        }
    }
    
    handleTouchStart(e) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousedown', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        this.canvas.dispatchEvent(mouseEvent);
    }
    
    handleTouchMove(e) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousemove', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        this.canvas.dispatchEvent(mouseEvent);
    }
    
    handleTouchEnd(e) {
        e.preventDefault();
        const mouseEvent = new MouseEvent('mouseup', {});
        this.canvas.dispatchEvent(mouseEvent);
    }
    
    clearCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    
    setColor(color) {
        this.color = color;
        this.ctx.strokeStyle = color;
    }
    
    setLineWidth(width) {
        this.lineWidth = width;
        this.ctx.lineWidth = width;
    }
}

// Quiz functionality
class QuizGame {
    constructor(wsClient) {
        this.wsClient = wsClient;
        this.currentQuestion = null;
        this.userAnswer = null;
        this.partnerAnswer = null;
        this.quizComplete = false;
        
        this.setupWebSocket();
    }
    
    setupWebSocket() {
        this.wsClient.on('quiz_result', (message) => {
            this.handleQuizResult(message);
        });
    }
    
    startQuiz(questions) {
        this.questions = questions;
        this.currentQuestionIndex = 0;
        this.quizComplete = false;
        this.userAnswer = null;
        this.partnerAnswer = null;
        
        this.showQuestion(this.questions[0]);
    }
    
    showQuestion(question) {
        this.currentQuestion = question;
        this.userAnswer = null;
        this.partnerAnswer = null;
        
        // This would update the UI with the question
        console.log('Quiz question:', question);
        
        // In a real implementation, this would update DOM elements
        // document.getElementById('quiz-question').textContent = question.text;
        // document.getElementById('quiz-option-a').textContent = question.options.a;
        // document.getElementById('quiz-option-b').textContent = question.options.b;
    }
    
    submitAnswer(answer) {
        if (!this.currentQuestion || this.userAnswer) return;
        
        this.userAnswer = answer;
        
        // Send answer via WebSocket
        this.wsClient.send({
            type: 'quiz_answer',
            questionId: this.currentQuestion.id,
            answer: answer,
            userId: this.wsClient.userId
        });
        
        // Check if both answers are in
        this.checkAnswers();
    }
    
    handleQuizResult(message) {
        // Handle quiz results from server
        console.log('Quiz result:', message);
        
        if (message.correct) {
            // Show success animation
            this.showCelebration();
        }
    }
    
    checkAnswers() {
        // In a real implementation, this would be handled by the server
        // For now, we'll simulate partner response after delay
        if (this.userAnswer && !this.partnerAnswer) {
            setTimeout(() => {
                this.partnerAnswer = 'A'; // Simulated partner answer
                this.evaluateAnswers();
            }, 2000);
        }
    }
    
    evaluateAnswers() {
        if (this.userAnswer === this.partnerAnswer) {
            // Answers match - increase默契值
            this.showMatchCelebration();
            
            // Move to next question or end quiz
            this.currentQuestionIndex++;
            if (this.currentQuestionIndex < this.questions.length) {
                setTimeout(() => {
                    this.showQuestion(this.questions[this.currentQuestionIndex]);
                }, 3000);
            } else {
                this.quizComplete = true;
                this.showQuizComplete();
            }
        } else {
            // Answers don't match
            this.showMismatchMessage();
            
            // Retry current question
            setTimeout(() => {
                this.userAnswer = null;
                this.partnerAnswer = null;
                // Show retry UI
            }, 3000);
        }
    }
    
    showMatchCelebration() {
        // Show celebration for matching answers
        console.log('默契值 +1! 答案一致！');
        
        // In a real implementation, this would show animations
        // and update默契值 display
    }
    
    showMismatchMessage() {
        console.log('答案不一致，再试试看！');
    }
    
    showCelebration() {
        // Generic celebration animation
        console.log('庆祝动画！');
    }
    
    showQuizComplete() {
        console.log('测验完成！');
    }
}

// Mood Sync functionality
class MoodSync {
    constructor(wsClient) {
        this.wsClient = wsClient;
        this.currentMood = null;
        
        this.setupWebSocket();
    }
    
    setupWebSocket() {
        this.wsClient.on('mood_sync', (message) => {
            this.handleMoodUpdate(message);
        });
    }
    
    setMood(mood) {
        this.currentMood = mood;
        
        // Send mood update via WebSocket
        this.wsClient.send({
            type: 'mood_update',
            mood: mood,
            user: this.wsClient.userName
        });
        
        // Update local UI
        this.updateMoodDisplay(mood);
    }
    
    handleMoodUpdate(message) {
        // Update UI with partner's mood
        console.log(`${message.user} 的心情: ${message.mood}`);
        
        // Change background based on mood
        this.updateBackgroundByMood(message.mood);
    }
    
    updateMoodDisplay(mood) {
        // Update mood display in UI
        console.log(`你的心情: ${mood}`);
        
        // In a real implementation, this would update DOM elements
        // document.getElementById('current-mood').textContent = mood;
    }
    
    updateBackgroundByMood(mood) {
        const moodColors = {
            '开心': '#FFD700', // Gold
            '委屈': '#87CEEB', // Sky Blue
            '想抱抱': '#FFB6C1', // Light Pink
            '平静': '#98FB98', // Pale Green
            '兴奋': '#FF6347', // Tomato
            '思念': '#DDA0DD'  // Plum
        };
        
        const color = moodColors[mood] || '#FFFFFF';
        
        // Smooth transition
        document.body.style.transition = 'background-color 1s ease';
        document.body.style.backgroundColor = color;
        
        // Add gradient overlay for better visual
        document.body.style.background = `linear-gradient(135deg, ${color}99 0%, ${color}66 100%)`;
    }
}

// Export classes for global use
window.HeartSyncWebSocket = HeartSyncWebSocket;
window.CanvasSync = CanvasSync;
window.QuizGame = QuizGame;
window.MoodSync = MoodSync;