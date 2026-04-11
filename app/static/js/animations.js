// HeartSync Animations Library

class HeartSyncAnimations {
    constructor() {
        this.particleSystems = new Map();
    }
    
    // Heart particle effect for check-in celebration
    createHeartParticles(count = 50, container = document.body) {
        const particles = [];
        const colors = ['#ff6b6b', '#ff8787', '#ffa8a8', '#ffc9c9'];
        
        for (let i = 0; i < count; i++) {
            const particle = document.createElement('div');
            particle.style.cssText = `
                position: fixed;
                width: ${10 + Math.random() * 20}px;
                height: ${10 + Math.random() * 20}px;
                background: ${colors[Math.floor(Math.random() * colors.length)]};
                border-radius: 50%;
                pointer-events: none;
                z-index: 1000;
                opacity: 0;
                transform: translate(-50%, -50%);
            `;
            
            container.appendChild(particle);
            particles.push(particle);
        }
        
        return particles;
    }
    
    // Animate heart particles from center
    animateHeartParticles(particles, duration = 2000) {
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        
        particles.forEach((particle, index) => {
            // Random angle and distance
            const angle = Math.random() * Math.PI * 2;
            const distance = 100 + Math.random() * 300;
            const endX = centerX + Math.cos(angle) * distance;
            const endY = centerY + Math.sin(angle) * distance;
            
            // Random size variation
            const size = parseFloat(particle.style.width);
            
            // Animation
            const startTime = Date.now();
            const delay = index * 20; // Stagger particles
            
            setTimeout(() => {
                const animate = () => {
                    const elapsed = Date.now() - startTime;
                    const progress = Math.min(elapsed / duration, 1);
                    
                    // Easing function
                    const ease = 1 - Math.pow(1 - progress, 3);
                    
                    // Current position
                    const x = centerX + (endX - centerX) * ease;
                    const y = centerY + (endY - centerY) * ease;
                    
                    // Opacity (fade in then out)
                    let opacity;
                    if (progress < 0.3) {
                        opacity = progress / 0.3;
                    } else if (progress > 0.7) {
                        opacity = 1 - (progress - 0.7) / 0.3;
                    } else {
                        opacity = 1;
                    }
                    
                    // Scale (pulse effect)
                    const scale = 0.5 + Math.sin(progress * Math.PI * 4) * 0.2;
                    
                    // Apply transformations
                    particle.style.left = `${x}px`;
                    particle.style.top = `${y}px`;
                    particle.style.opacity = opacity;
                    particle.style.transform = `translate(-50%, -50%) scale(${scale})`;
                    
                    if (progress < 1) {
                        requestAnimationFrame(animate);
                    } else {
                        particle.remove();
                    }
                };
                
                animate();
            }, delay);
        });
    }
    
    // Celebration effect for achievements
    showAchievementCelebration(achievementName) {
        const celebration = document.createElement('div');
        celebration.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(255, 255, 255, 0.9);
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            z-index: 2000;
            opacity: 0;
            transition: opacity 0.5s ease;
        `;
        
        celebration.innerHTML = `
            <div style="text-align: center; transform: scale(0.5); transition: transform 0.5s ease;">
                <div style="font-size: 4em; margin-bottom: 20px;">🎉</div>
                <h2 style="color: #667eea; margin-bottom: 10px;">成就解锁！</h2>
                <h3 style="color: #764ba2; margin-bottom: 20px;">${achievementName}</h3>
                <p style="color: #666; max-width: 300px;">恭喜达成新的里程碑！</p>
            </div>
        `;
        
        document.body.appendChild(celebration);
        
        // Animate in
        setTimeout(() => {
            celebration.style.opacity = '1';
            celebration.querySelector('div').style.transform = 'scale(1)';
        }, 10);
        
        // Animate out after 3 seconds
        setTimeout(() => {
            celebration.style.opacity = '0';
            setTimeout(() => {
                celebration.remove();
            }, 500);
        }, 3000);
    }
    
    // Love counter pulse animation
    animateLoveCounter() {
        const counter = document.querySelector('.days-count');
        if (!counter) return;
        
        // Store original text
        const originalText = counter.textContent;
        
        // Create pulse effect
        counter.style.animation = 'pulse 1s ease';
        
        // Reset animation after it completes
        setTimeout(() => {
            counter.style.animation = '';
        }, 1000);
    }
    
    // Floating hearts background effect
    createFloatingHearts(count = 20) {
        const container = document.createElement('div');
        container.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: -1;
            overflow: hidden;
        `;
        
        document.body.appendChild(container);
        
        const hearts = [];
        
        for (let i = 0; i < count; i++) {
            const heart = document.createElement('div');
            heart.innerHTML = '❤️';
            heart.style.cssText = `
                position: absolute;
                font-size: ${20 + Math.random() * 30}px;
                opacity: ${0.1 + Math.random() * 0.2};
                top: ${Math.random() * 100}%;
                left: ${Math.random() * 100}%;
                animation: floatHeart ${10 + Math.random() * 20}s linear infinite;
                animation-delay: ${Math.random() * 5}s;
            `;
            
            container.appendChild(heart);
            hearts.push({ element: heart, container });
        }
        
        // Add CSS for animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes floatHeart {
                0% {
                    transform: translate(0, 0) rotate(0deg);
                    opacity: 0;
                }
                10% {
                    opacity: ${0.1 + Math.random() * 0.2};
                }
                90% {
                    opacity: ${0.1 + Math.random() * 0.2};
                }
                100% {
                    transform: translate(${Math.random() * 100 - 50}px, -100vh) rotate(${Math.random() * 360}deg);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(style);
        
        return hearts;
    }
    
    // Progress bar animation
    animateProgressBar(progressBar, targetValue, duration = 1000) {
        const currentValue = parseFloat(progressBar.style.width) || 0;
        const startTime = Date.now();
        
        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Easing function
            const ease = 1 - Math.pow(1 - progress, 3);
            
            // Calculate current value
            const current = currentValue + (targetValue - currentValue) * ease;
            
            // Update progress bar
            progressBar.style.width = `${current}%`;
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };
        
        animate();
    }
    
    // Typewriter effect for text
    typewriterEffect(element, text, speed = 50) {
        let i = 0;
        element.textContent = '';
        
        const type = () => {
            if (i < text.length) {
                element.textContent += text.charAt(i);
                i++;
                setTimeout(type, speed);
            }
        };
        
        type();
    }
    
    // Confetti explosion
    createConfetti(count = 100, duration = 3000) {
        const confettiContainer = document.createElement('div');
        confettiContainer.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1000;
        `;
        
        document.body.appendChild(confettiContainer);
        
        const colors = ['#ff6b6b', '#51cf66', '#339af0', '#ffd43b', '#be4bdb'];
        const shapes = ['■', '●', '▲', '❤️', '★'];
        
        for (let i = 0; i < count; i++) {
            const confetti = document.createElement('div');
            confetti.style.cssText = `
                position: absolute;
                top: -50px;
                left: ${Math.random() * 100}%;
                font-size: ${10 + Math.random() * 20}px;
                color: ${colors[Math.floor(Math.random() * colors.length)]};
                opacity: ${0.7 + Math.random() * 0.3};
                transform: rotate(${Math.random() * 360}deg);
            `;
            
            confetti.textContent = shapes[Math.floor(Math.random() * shapes.length)];
            confettiContainer.appendChild(confetti);
            
            // Animate confetti
            const angle = Math.random() * Math.PI * 2;
            const velocity = 2 + Math.random() * 3;
            const rotationSpeed = (Math.random() - 0.5) * 10;
            
            let x = parseFloat(confetti.style.left) / 100 * window.innerWidth;
            let y = -50;
            let rotation = 0;
            
            const startTime = Date.now();
            
            const animate = () => {
                const elapsed = Date.now() - startTime;
                const progress = elapsed / duration;
                
                if (progress < 1) {
                    // Physics simulation
                    x += Math.cos(angle) * velocity;
                    y += Math.sin(angle) * velocity + progress * 2; // Gravity
                    rotation += rotationSpeed;
                    
                    // Apply transformations
                    confetti.style.left = `${x}px`;
                    confetti.style.top = `${y}px`;
                    confetti.style.transform = `rotate(${rotation}deg)`;
                    confetti.style.opacity = 1 - progress;
                    
                    requestAnimationFrame(animate);
                } else {
                    confetti.remove();
                }
            };
            
            animate();
        }
        
        // Remove container after animation
        setTimeout(() => {
            confettiContainer.remove();
        }, duration);
    }
    
    // Smooth scroll to element
    smoothScrollTo(element, duration = 1000) {
        const targetPosition = element.getBoundingClientRect().top + window.pageYOffset;
        const startPosition = window.pageYOffset;
        const distance = targetPosition - startPosition;
        const startTime = Date.now();
        
        const ease = (t) => {
            return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        };
        
        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeProgress = ease(progress);
            
            window.scrollTo(0, startPosition + distance * easeProgress);
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };
        
        animate();
    }
    
    // Card flip animation
    createCardFlip(cardElement) {
        cardElement.style.transition = 'transform 0.6s';
        cardElement.style.transformStyle = 'preserve-3d';
        
        const flip = () => {
            const isFlipped = cardElement.classList.contains('flipped');
            
            if (isFlipped) {
                cardElement.classList.remove('flipped');
                cardElement.style.transform = 'rotateY(0deg)';
            } else {
                cardElement.classList.add('flipped');
                cardElement.style.transform = 'rotateY(180deg)';
            }
        };
        
        return flip;
    }
}

// Initialize animations on page load
document.addEventListener('DOMContentLoaded', () => {
    const animations = new HeartSyncAnimations();
    
    // Add floating hearts to background
    animations.createFloatingHearts(15);
    
    // Add pulse animation to love counter every minute
    setInterval(() => {
        animations.animateLoveCounter();
    }, 60000);
    
    // Make animations available globally
    window.HeartSyncAnimations = HeartSyncAnimations;
    window.animations = animations;
    
    // Check for new achievements and show celebration
    const checkForNewAchievements = () => {
        // This would be called after check-in or page load
        // to check for newly unlocked achievements
        console.log('Animation system ready!');
    };
    
    checkForNewAchievements();
});