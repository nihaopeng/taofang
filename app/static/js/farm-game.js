// ============ 心动农场 - Phaser游戏逻辑 v2 ============
const MAP_W = 2000;
const MAP_H = 1500;
const PLOT_SIZE = 56;
const PLOT_GAP = 14;
const PLOTS_PER_ROW = 5;
const PLOTS_PER_COL = 4;
const PLOT_START_X = 750;
const PLOT_START_Y = 480;
const TOOLS = ['hoe', 'water', 'seed', 'fish', 'harvest'];

function getPlotWorldPos(index) {
    const col = index % PLOTS_PER_ROW;
    const row = Math.floor(index / PLOTS_PER_ROW);
    return {
        x: PLOT_START_X + col * (PLOT_SIZE + PLOT_GAP) + PLOT_SIZE / 2,
        y: PLOT_START_Y + row * (PLOT_SIZE + PLOT_GAP) + PLOT_SIZE / 2
    };
}

function findNearestPlot(wx, wy, maxDist) {
    if (!maxDist) maxDist = 55;
    let best = null, bestDist = Infinity;
    for (let i = 0; i < PLOTS_PER_ROW * PLOTS_PER_COL; i++) {
        const pos = getPlotWorldPos(i);
        const dist = Math.sqrt((wx - pos.x) ** 2 + (wy - pos.y) ** 2);
        if (dist < maxDist && dist < bestDist) { best = i; bestDist = dist; }
    }
    return best;
}

function isInWater(wx, wy) {
    if (wx >= 80 && wx <= 400 && wy >= 80 && wy <= 300) return true;
    if (wx >= 1100 && wx <= 1550 && wy >= 700 && wy <= 980) return true;
    return false;
}

// ============ BootScene ============
class BootScene extends Phaser.Scene {
    constructor() { super({ key: 'BootScene' }); }

    preload() {
        this.load.image('dirt', '/static/images/ground/hoeDirt.png');
        this.load.image('dirtDark', '/static/images/ground/hoeDirtDark.png');
        this.load.image('tree', '/static/images/tree/tree1_summer._01.png');

        // Caroline角色
        this.load.image('char_front1', '/static/images/carlorine/Caroline_front_walk_frame1.png');
        this.load.image('char_front2', '/static/images/carlorine/Caroline_front_walk_frame2.png');
        this.load.image('char_front3', '/static/images/carlorine/Caroline_front_walk_frame3.png');
        this.load.image('char_back1', '/static/images/carlorine/Caroline_back_walk_frame1.png');
        this.load.image('char_back2', '/static/images/carlorine/Caroline_back_walk_frame2.png');
        this.load.image('char_back3', '/static/images/carlorine/Caroline_back_walk_frame3.png');
        this.load.image('char_left1', '/static/images/carlorine/Caroline_left_walk_frame1.png');
        this.load.image('char_left2', '/static/images/carlorine/Caroline_left_walk_frame2.png');
        this.load.image('char_left3', '/static/images/carlorine/Caroline_left_walk_frame3.png');
        this.load.image('char_right1', '/static/images/carlorine/Caroline_right_walk_frame1.png');
        this.load.image('char_right2', '/static/images/carlorine/Caroline_right_walk_frame2.png');
        this.load.image('char_right3', '/static/images/carlorine/Caroline_right_walk_frame3.png');

        // 作物
        for (let i = 0; i <= 6; i++) {
            this.load.image('carrot_' + i, '/static/images/crops/carrot/crops_' + String(i).padStart(2, '0') + '.png');
        }
        for (let i = 7; i <= 14; i++) {
            this.load.image('hops_' + i, '/static/images/crops/Hops/crops_' + String(i).padStart(2, '0') + '.png');
        }
    }

    create() {
        this.anims.create({ key: 'walk-down', frames: [{ key: 'char_front1' }, { key: 'char_front2' }, { key: 'char_front3' }], frameRate: 8, repeat: -1 });
        this.anims.create({ key: 'walk-up', frames: [{ key: 'char_back1' }, { key: 'char_back2' }, { key: 'char_back3' }], frameRate: 8, repeat: -1 });
        this.anims.create({ key: 'walk-left', frames: [{ key: 'char_left1' }, { key: 'char_left2' }, { key: 'char_left3' }], frameRate: 8, repeat: -1 });
        this.anims.create({ key: 'walk-right', frames: [{ key: 'char_right1' }, { key: 'char_right2' }, { key: 'char_right3' }], frameRate: 8, repeat: -1 });
        this.scene.start('FarmScene');
    }
}

// ============ FarmScene ============
class FarmScene extends Phaser.Scene {
    constructor() { super({ key: 'FarmScene' }); }

    create() {
        this.physics.world.setBounds(0, 0, MAP_W, MAP_H);
        this.cameras.main.setBounds(0, 0, MAP_W, MAP_H);

        this.createGround();
        this.createPlayer();       // 必须先创建玩家
        this.createBoundary();     // 然后创建碰撞体
        this.createWaterBodies();
        this.createTrees();
        this.createPlotMarkers();

        this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
        this.input.on('pointerdown', this.handleClick, this);

        this.syncWithServer();
        this.time.addEvent({ delay: 10000, callback: () => this.syncWithServer(), loop: true });

        // 持续显示作物信息
        this.plotLabel = this.add.text(0, 0, '', {
            fontSize: '11px', color: '#ffdd88', fontFamily: 'Arial',
            stroke: '#000', strokeThickness: 3,
            align: 'center'
        }).setOrigin(0.5).setDepth(50).setVisible(false);
        this.time.addEvent({ delay: 500, callback: () => this.updatePlotLabel(), loop: true });

        this.currentTool = 'hoe';
    }

    updatePlotLabel() {
        if (!this.player || !this.player.body) return;
        if (window.FARM_DATA.isFishing) { this.plotLabel.setVisible(false); return; }

        const px = this.player.x, py = this.player.y;
        const idx = findNearestPlot(px, py, 60);
        if (idx === null) { this.plotLabel.setVisible(false); return; }

        const pd = window.FARM_DATA.plots[idx];
        if (!pd || !pd.plant_type) { this.plotLabel.setVisible(false); return; }

        const plantDef = window.FARM_DATA.plants[pd.plant_type];
        if (!plantDef) { this.plotLabel.setVisible(false); return; }

        const stage = pd.growth_stage;
        const totalStages = plantDef.stages;

        if (stage >= totalStages + 1) {
            this.plotLabel.setText('✨可收获✨');
            this.plotLabel.setVisible(true);
        } else {
            const now = Date.now();
            const plantedTime = pd.planted_at ? new Date(pd.planted_at).getTime() : now;
            const wateredTime = pd.watered_at ? new Date(pd.watered_at).getTime() : plantedTime;
            const waterCount = Math.max(0, Math.round((wateredTime - plantedTime) / 60000));
            const effectiveGrowth = Math.max(plantDef.growth_time * 0.3, plantDef.growth_time - waterCount * plantDef.water_reduction);
            const elapsed = (now - plantedTime) / 1000;
            const remaining = Math.max(0, Math.round(effectiveGrowth - elapsed));
            const remainText = remaining > 0 ? formatGrowthTime(remaining) : '即将成熟';
            this.plotLabel.setText(`${plantDef.name}\n剩余:${remainText}`);
            this.plotLabel.setVisible(true);
        }

        const pos = getPlotWorldPos(idx);
        this.plotLabel.setPosition(pos.x, pos.y - PLOT_SIZE / 2 - 18);
    }

    // ============ 地图构建 ============

    createGround() {
        const TW = 64, TH = 64;
        for (let r = 0; r < Math.ceil(MAP_H / TH) + 1; r++) {
            for (let c = 0; c < Math.ceil(MAP_W / TW) + 1; c++) {
                const key = (r + c) % 3 === 0 ? 'dirtDark' : 'dirt';
                const t = this.add.image(c * TW, r * TH, key).setOrigin(0, 0);
                t.setAlpha(0.45 + ((r + c) % 3) * 0.08).setDepth(-10);
            }
        }
    }

    createBoundary() {
        const g = this.add.graphics(); g.setDepth(20);
        const M = 20; // 边距

        // 围栏
        g.lineStyle(3, 0x8B6914, 1);
        g.strokeRect(M, M, MAP_W - M * 2, MAP_H - M * 2);

        // 围栏柱子
        for (let x = M; x <= MAP_W - M; x += 80) {
            g.fillStyle(0x6B4914, 0.9);
            g.fillRect(x - 2, M - 4, 4, 8);
            g.fillRect(x - 2, MAP_H - M - 4, 4, 8);
        }
        for (let y = M; y <= MAP_H - M; y += 80) {
            g.fillStyle(0x6B4914, 0.9);
            g.fillRect(M - 4, y - 2, 8, 4);
            g.fillRect(MAP_W - M - 4, y - 2, 8, 4);
        }

        // 物理边界（不可穿越的围栏）
        const bw = 8; // 围栏物理宽度
        const fenceGroup = this.physics.add.staticGroup();

        // 四条边
        this.addFenceWall(fenceGroup, M + MAP_W / 2, M - bw / 2, MAP_W, bw * 2);       // 上
        this.addFenceWall(fenceGroup, M + MAP_W / 2, MAP_H - M + bw / 2, MAP_W, bw * 2); // 下
        this.addFenceWall(fenceGroup, M - bw / 2, M + MAP_H / 2, bw * 2, MAP_H);         // 左
        this.addFenceWall(fenceGroup, MAP_W - M + bw / 2, M + MAP_H / 2, bw * 2, MAP_H); // 右

        // 碰撞
        this.physics.add.collider(this.player, fenceGroup);
    }

    addFenceWall(group, x, y, w, h) {
        const wall = this.add.rectangle(x, y, w, h);
        wall.setVisible(false);
        group.add(wall);
        wall.body.setSize(w, h);
    }

    createWaterBodies() {
        // 水塘1 - 左上
        const w1 = { x: 230, y: 190, w: 300, h: 200 };
        this.drawWater(w1.x, w1.y, w1.w, w1.h, 5);
        this.add.text(w1.x, w1.y + 10, '🎣 水塘', {
            fontSize: '16px', color: '#ddeeff', fontFamily: 'Arial',
            stroke: '#225577', strokeThickness: 3
        }).setOrigin(0.5).setDepth(-3).setAlpha(0.6);

        // 水塘2 - 右下
        const w2 = { x: 1320, y: 830, w: 400, h: 260 };
        this.drawWater(w2.x, w2.y, w2.w, w2.h, 7);
        this.add.text(w2.x, w2.y + 10, '🎣 水塘', {
            fontSize: '16px', color: '#ddeeff', fontFamily: 'Arial',
            stroke: '#225577', strokeThickness: 3
        }).setOrigin(0.5).setDepth(-3).setAlpha(0.6);
    }

    drawWater(cx, cy, w, h, ripples) {
        const g = this.add.graphics(); g.setDepth(-5);
        // 水底
        g.fillStyle(0x2288bb, 0.75);
        g.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 16);
        // 边框
        g.lineStyle(3, 0x116699, 0.9);
        g.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, 16);
        // 波纹
        for (let i = 0; i < ripples; i++) {
            const rx = cx - w / 2 + 40 + Math.random() * (w - 80);
            const ry = cy - h / 2 + 30 + Math.random() * (h - 60);
            this.add.ellipse(rx, ry, 30 + Math.random() * 25, 5, 0x88ccdd, 0.25).setDepth(-4);
        }
    }


    createTrees() {
        const treeGroup = this.physics.add.staticGroup();
        const positions = [
            { x: 500, y: 180 }, { x: 580, y: 200 }, { x: 520, y: 260 },
            { x: 1560, y: 350 }, { x: 1620, y: 400 }, { x: 1500, y: 380 },
            { x: 200, y: 620 }, { x: 280, y: 700 },
            { x: 340, y: 420 }, { x: 400, y: 380 },
            { x: 1520, y: 150 }, { x: 1600, y: 120 },
            { x: 800, y: 220 }, { x: 880, y: 180 },
            { x: 1600, y: 650 }, { x: 1700, y: 600 },
            { x: 300, y: 950 }, { x: 400, y: 1000 },
        ];

        positions.forEach(pos => {
            const tree = this.add.image(pos.x, pos.y, 'tree').setScale(1.3 + Math.random() * 0.8);
            tree.setDepth(5).setAlpha(0.85);

            // 物理碰撞（树干区域）
            const trunk = this.add.rectangle(pos.x, pos.y + 16, 18, 22);
            trunk.setVisible(false);
            this.physics.add.existing(trunk, true);
            treeGroup.add(trunk);
        });

        this.physics.add.collider(this.player, treeGroup);
    }

    createPlotMarkers() {
        this.plotSprites = {};
        for (let i = 0; i < PLOTS_PER_ROW * PLOTS_PER_COL; i++) {
            const pos = getPlotWorldPos(i);
            const g = this.add.graphics();
            g.setDepth(0);
            g.lineStyle(1, 0x555544, 0.4);
            g.strokeRect(pos.x - PLOT_SIZE / 2, pos.y - PLOT_SIZE / 2, PLOT_SIZE, PLOT_SIZE);
            this.plotSprites[i] = { graphics: g, cropSprite: null, bgRect: null, harvestMarker: null, state: 'empty' };
        }
    }

    createPlayer() {
        this.player = this.physics.add.sprite(500, 700, 'char_front1');
        this.player.setDepth(10).setScale(1.2).setCollideWorldBounds(false);
        this.player.body.setSize(20, 20);
        this.player.body.setOffset(22, 44);
        this.player.play('walk-down');
        this.player.anims.pause();
    }

    // ============ 点击处理 ============

    handleClick(pointer) {
        if (window.FARM_DATA.isFishing) return;
        if (pointer.downElement && pointer.downElement.closest && pointer.downElement.closest('.modal-overlay')) return;

        const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const wx = wp.x, wy = wp.y;

        // 钓鱼
        if (this.currentTool === 'fish' && isInWater(wx, wy)) {
            this.playerMoveTo(wx, wy, () => this.startFishing());
            return;
        }

        // 地块操作
        const plotIdx = findNearestPlot(wx, wy, 55);
        if (plotIdx !== null) {
            if (this.currentTool === 'hoe') this.playerMoveTo(wx, wy, () => this.tillPlot(plotIdx));
            else if (this.currentTool === 'water') this.playerMoveTo(wx, wy, () => this.waterPlot(plotIdx));
            else if (this.currentTool === 'seed') this.playerMoveTo(wx, wy, () => this.openSeedModal(plotIdx));
            else if (this.currentTool === 'harvest') this.playerMoveTo(wx, wy, () => this.harvestPlot(plotIdx));
            else {
                // 非操作工具：显示作物信息
                this.showPlotInfo(plotIdx);
                this.playerMoveTo(wx, wy, null);
            }
            return;
        }

        this.playerMoveTo(wx, wy, null);
    }

    showPlotInfo(plotIdx) {
        const pd = window.FARM_DATA.plots[plotIdx];
        if (!pd || !pd.plant_type) return;

        const plantDef = window.FARM_DATA.plants[pd.plant_type];
        if (!plantDef) return;

        const stage = pd.growth_stage;
        const totalStages = plantDef.stages;
        const stageNames = ['开垦', '种子', '发芽', '生长', '成熟', '可收获'];

        if (stage >= totalStages + 1) {
            showToast(`${plantDef.name} ✨已成熟，可以收获了！`);
            return;
        }

        // 计算剩余时间
        const now = Date.now();
        const plantedTime = pd.planted_at ? new Date(pd.planted_at).getTime() : now;
        const wateredTime = pd.watered_at ? new Date(pd.watered_at).getTime() : plantedTime;
        const waterCount = Math.max(0, Math.round((wateredTime - plantedTime) / 60000));
        const effectiveGrowth = Math.max(plantDef.growth_time * 0.3, plantDef.growth_time - waterCount * plantDef.water_reduction);
        const elapsed = (now - plantedTime) / 1000;
        const remaining = Math.max(0, Math.round(effectiveGrowth - elapsed));

        const stageName = stageNames[Math.min(stage, stageNames.length - 1)] || '生长中';
        const remainText = remaining > 0 ? formatGrowthTime(remaining) : '即将成熟';

        showToast(`${plantDef.name} | ${stageName}(阶段${stage}/${totalStages}) | 剩余约${remainText}`);
    }

    playerMoveTo(tx, ty, onArrive) {
        if (!this.player || !this.player.body) return;
        if (this.moveCheckTimer) { this.moveCheckTimer.remove(); this.moveCheckTimer = null; }
        this.player.body.setVelocity(0, 0);

        const dx = tx - this.player.x, dy = ty - this.player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 5) { if (onArrive) onArrive(); return; }

        const speed = 160;
        this.player.body.setVelocity((dx / dist) * speed, (dy / dist) * speed);

        if (Math.abs(dx) > Math.abs(dy)) {
            this.player.play(dx > 0 ? 'walk-right' : 'walk-left', true);
        } else {
            this.player.play(dy > 0 ? 'walk-down' : 'walk-up', true);
        }

        let elapsed = 0;
        this.moveCheckTimer = this.time.addEvent({
            delay: 50, loop: true,
            callback: () => {
                elapsed += 50;
                const cdx = tx - this.player.x, cdy = ty - this.player.y;
                if (Math.sqrt(cdx * cdx + cdy * cdy) < 8 || elapsed > 5000) {
                    this.player.body.setVelocity(0, 0);
                    this.player.anims.pause();
                    if (this.moveCheckTimer) { this.moveCheckTimer.remove(); this.moveCheckTimer = null; }
                    if (onArrive && elapsed <= 5000) onArrive();
                }
            }
        });
    }

    // ============ 工具操作 ============

    async tillPlot(idx) {
        const plot = window.FARM_DATA.plots[idx];
        if (plot && plot.growth_stage >= 0) { showToast('已开垦过'); return; }
        const r = await fetch('/api/farm/till', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plot_index: idx }) });
        const d = await r.json();
        if (d.success) { showToast('开垦成功！'); await this.syncWithServer(); }
        else showToast(d.error || '开垦失败');
    }

    async waterPlot(idx) {
        const plot = window.FARM_DATA.plots[idx];
        if (!plot || !plot.plant_type) { showToast('这里没种东西'); return; }
        if (plot.growth_stage >= 5) { showToast('作物已成熟！'); return; }
        const r = await fetch('/api/farm/water', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plot_index: idx }) });
        const d = await r.json();
        if (d.success) {
            const reduction = formatGrowthTime(d.water_reduction || 0);
            showToast(`💧 浇水成功！减少${reduction}`);
            await this.syncWithServer();
        }
        else showToast(d.error || '浇水失败');
    }

    async harvestPlot(idx) {
        const plot = window.FARM_DATA.plots[idx];
        if (!plot || !plot.plant_type) { showToast('没种东西'); return; }
        if (plot.growth_stage < 5) { showToast('还没成熟~'); return; }
        const r = await fetch('/api/farm/harvest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plot_index: idx }) });
        const d = await r.json();
        if (d.success) { showToast('收获了 ' + (window.FARM_DATA.plants[d.crop]?.name || d.crop) + '！🧺'); await this.syncWithServer(); updateInventoryDisplay(); }
        else showToast(d.error || '收获失败');
    }

    openSeedModal(idx) {
        const plot = window.FARM_DATA.plots[idx];
        if (!plot || plot.growth_stage !== 0) { showToast(plot?.plant_type ? '已种植' : '请先开垦'); return; }
        window.FARM_DATA.targetPlotIndex = idx;

        const c = document.getElementById('seed-items'); c.innerHTML = '';
        let has = false;
        for (const k in window.FARM_DATA.inventory) {
            const item = window.FARM_DATA.inventory[k];
            if (item.type !== 'seed') continue;
            has = true;
            const def = window.FARM_DATA.plants[item.id];
            const div = document.createElement('div'); div.className = 'item-row';
            div.innerHTML = `<div class="item-info"><div class="item-name">🌱 ${def?.name || item.id}</div><div class="item-desc">数量: ${item.quantity}</div></div><button class="btn-sm btn-plant">种植</button>`;
            div.querySelector('button').onclick = () => { this.plantSeed(idx, item.id); closeSeedModal(); };
            c.appendChild(div);
        }
        if (!has) c.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">没有种子，去商店买吧</div>';
        document.getElementById('seed-modal').classList.add('show');
    }

    async plantSeed(idx, seedId) {
        const r = await fetch('/api/farm/plant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plot_index: idx, plant_type: seedId }) });
        const d = await r.json();
        if (d.success) { showToast(d.message); await this.syncWithServer(); updateInventoryDisplay(); }
        else showToast(d.error || '种植失败');
    }

    async startFishing() {
        window.FARM_DATA.isFishing = true;
        this.fishingMinigame = new FishingMinigame(async (success) => {
            window.FARM_DATA.isFishing = false;
            document.getElementById('fishing-cancel-btn').style.display = 'none';
            document.getElementById('fishing-hint').style.display = 'none';
            if (success) {
                try {
                    const r = await fetch('/api/farm/fish', { method: 'POST' });
                    const d = await r.json();
                    if (d.success) {
                        showToast('🎣 钓到了 ' + d.fish.name + '！');
                        document.getElementById('caught-fish-name').textContent = '🎉 ' + d.fish.name + '！';
                    } else {
                        document.getElementById('caught-fish-name').textContent = '鱼跑了...';
                    }
                } catch (e) {
                    document.getElementById('caught-fish-name').textContent = '鱼跑了...';
                }
            } else {
                document.getElementById('caught-fish-name').textContent = '鱼逃走了...';
            }
            document.getElementById('fishing-result').style.display = 'flex';
            await this.syncWithServer();
            updateInventoryDisplay();
        });
        this.fishingMinigame.start();
    }

    // ============ 同步 ============

    async syncWithServer() {
        try {
            const r = await fetch('/api/farm/state'); const d = await r.json();
            if (d.success) {
                window.FARM_DATA.coins = d.coins;
                window.FARM_DATA.plots = d.plots;
                window.FARM_DATA.plants = d.plants;
                window.FARM_DATA.fish = d.fish;
                window.FARM_DATA.inventory = d.inventory;
                window.FARM_DATA.unlockedPlants = d.unlocked_plants || [];
                this.renderPlots();
                updateCoinsDisplay(d.coins);
                updateInventoryDisplay();
                // 根据领取状态禁用按钮
                if (d.claimed_checkin) disableRewardBtn('.btn-checkin');
                if (d.claimed_diary) disableRewardBtn('.btn-diary');
            }
        } catch (e) { console.error('同步失败:', e); }
    }

    renderPlots() {
        const plots = window.FARM_DATA.plots;
        for (let i = 0; i < PLOTS_PER_ROW * PLOTS_PER_COL; i++) {
            const pd = plots[i];
            const pos = getPlotWorldPos(i);
            const sp = this.plotSprites[i];
            if (!sp) continue;

            if (sp.cropSprite) { sp.cropSprite.destroy(); sp.cropSprite = null; }
            if (sp.bgRect) { sp.bgRect.destroy(); sp.bgRect = null; }
            if (sp.harvestMarker) { sp.harvestMarker.destroy(); sp.harvestMarker = null; }

            if (!pd || pd.growth_stage === undefined || pd.growth_stage < 0) {
                sp.state = 'empty'; continue;
            }

            // 浇水判断：watered_at > planted_at 表示浇过水
            const isWatered = pd.watered_at && pd.planted_at && pd.watered_at > pd.planted_at;
            const soilColor = isWatered ? 0x5C4A1E : 0x8B6914;
            const soilAlpha = isWatered ? 0.85 : 0.65;
            const bg = this.add.rectangle(pos.x, pos.y, PLOT_SIZE, PLOT_SIZE, soilColor, soilAlpha).setDepth(1);
            bg.setStrokeStyle(1, 0x6B4914, 0.7);
            sp.bgRect = bg; sp.state = 'tilled';

            if (!pd.plant_type) continue;

            const plantDef = window.FARM_DATA.plants[pd.plant_type];
            const stage = pd.growth_stage;
            const totalStages = plantDef?.stages || 4;

            let frameKey = null;
            if (pd.plant_type === 'carrot') {
                const fi = stage >= 8 ? 6 : Math.floor((stage - 1) / (totalStages + 1) * 7);
                frameKey = 'carrot_' + Math.max(0, Math.min(6, fi));
            } else if (pd.plant_type === 'hops') {
                const fi = stage >= 9 ? 7 : Math.floor((stage - 1) / (totalStages + 1) * 8);
                frameKey = 'hops_' + (7 + Math.max(0, Math.min(7, fi)));
            }

            if (frameKey && this.textures.exists(frameKey)) {
                sp.cropSprite = this.add.image(pos.x, pos.y - 6, frameKey).setDepth(3);
                sp.state = 'growing';
            } else {
                const name = plantDef?.name || pd.plant_type;
                sp.cropSprite = this.add.text(pos.x, pos.y - 4, name, {
                    fontSize: '10px', color: '#fff', fontFamily: 'Arial',
                    stroke: '#000', strokeThickness: 2
                }).setOrigin(0.5).setDepth(3);
                sp.state = 'growing';
            }

            if (stage >= totalStages + 1) {
                sp.harvestMarker = this.add.text(pos.x, pos.y - PLOT_SIZE / 2 - 10, '✨', {
                    fontSize: '14px', color: '#ffdd00', stroke: '#000', strokeThickness: 3
                }).setOrigin(0.5).setDepth(4);
            }
        }
    }
}

// ============ 钓鱼小游戏 ============
class FishingMinigame {
    constructor(onComplete) {
        this.onComplete = onComplete;
        this.barH = 200; this.floatY = 180; this.floatH = 18;
        this.targetY = 80; this.targetH = 36;
        this.floatVel = 0; this.progress = 50;
        this.isRunning = false; this.isHolding = false;
        this.targetPhase = 0;
        this.targetSpeed = 0.025 + Math.random() * 0.02;
        this.targetAmplitude = 40 + Math.random() * 40;
        this.targetCenter = 60 + Math.random() * (this.barH - 120);
        this.animId = null;
        this.frameCount = 0;
        this.jitterTimer = 0;
        this.jitterOffset = 0;
        this.speedChangeTimer = 0;
    }

    start() {
        const el = document.getElementById('fishing-game');
        el.classList.add('show');
        document.getElementById('fishing-result').style.display = 'none';
        document.getElementById('fishing-hint').style.display = 'block';
        document.getElementById('fishing-cancel-btn').style.display = 'block';
        document.getElementById('fishing-progress-fill').style.width = '0%';

        this.floatY = this.barH / 2; this.floatVel = 0; this.progress = 50;
        this.frameCount = 0; this.jitterTimer = 0; this.jitterOffset = 0; this.speedChangeTimer = 0;
        this.isRunning = true; this.targetPhase = Math.random() * Math.PI * 2;

        const barWrapper = document.querySelector('.fishing-bar-wrapper');
        const onDown = (e) => { e.preventDefault(); this.isHolding = true; };
        const onUp = (e) => { e.preventDefault(); this.isHolding = false; };
        barWrapper.addEventListener('mousedown', onDown);
        barWrapper.addEventListener('touchstart', onDown);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchend', onUp);
        this._cleanup = () => {
            barWrapper.removeEventListener('mousedown', onDown);
            barWrapper.removeEventListener('touchstart', onDown);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchend', onUp);
        };
        this.tick();
    }

    tick() {
        if (!this.isRunning) return;
        this.frameCount++;

        // 随机变速：每隔一段时间改变目标速度
        this.speedChangeTimer++;
        if (this.speedChangeTimer > 60 + Math.random() * 120) {
            this.speedChangeTimer = 0;
            this.targetSpeed = 0.015 + Math.random() * 0.045;
        }

        // 随机抖动：每隔一段时间给目标一个随机偏移
        this.jitterTimer++;
        if (this.jitterTimer > 30 + Math.random() * 90) {
            this.jitterTimer = 0;
            this.jitterOffset = (Math.random() - 0.5) * 40;
        }
        // 抖动平滑衰减
        this.jitterOffset *= 0.9;

        this.targetPhase += this.targetSpeed;
        this.targetY = this.targetCenter + Math.sin(this.targetPhase) * this.targetAmplitude + this.jitterOffset;
        this.targetY = Math.max(2, Math.min(this.barH - this.targetH - 2, this.targetY));

        const gravity = 0.25, lift = -0.45, friction = 0.93;
        if (this.isHolding) this.floatVel += lift; else this.floatVel += gravity;
        this.floatVel *= friction;
        this.floatY += this.floatVel;
        if (this.floatY < 0) { this.floatY = 0; this.floatVel *= -0.3; }
        if (this.floatY > this.barH - this.floatH) { this.floatY = this.barH - this.floatH; this.floatVel *= -0.3; }

        const fCenter = this.floatY + this.floatH / 2;
        if (fCenter >= this.targetY && fCenter <= this.targetY + this.targetH) {
            this.progress += 0.9;
        } else {
            this.progress -= 0.35;
        }
        this.progress = Math.max(0, Math.min(100, this.progress));

        document.getElementById('fishing-target').style.top = this.targetY + 'px';
        document.getElementById('fishing-float').style.top = this.floatY + 'px';
        document.getElementById('fishing-progress-fill').style.width = this.progress + '%';

        // 进度条颜色
        const fill = document.getElementById('fishing-progress-fill');
        if (this.progress > 70) fill.style.background = 'linear-gradient(90deg, #ffaa00, #ffcc44)';
        else if (this.progress > 25) fill.style.background = 'linear-gradient(90deg, #33cc55, #55ee77)';
        else fill.style.background = 'linear-gradient(90deg, #cc3333, #ee5555)';

        // 失败：进度归零
        if (this.progress <= 0) {
            this.isRunning = false;
            if (this._cleanup) this._cleanup();
            this.onComplete(false); return;
        }

        // 成功：进度满
        if (this.progress >= 100) {
            this.isRunning = false;
            if (this._cleanup) this._cleanup();
            this.onComplete(true); return;
        }
        this.animId = requestAnimationFrame(() => this.tick());
    }

    close() {
        this.isRunning = false;
        if (this._cleanup) this._cleanup();
        if (this.animId) cancelAnimationFrame(this.animId);
        document.getElementById('fishing-game').classList.remove('show');
    }
}

function closeFishingGame() {
    const scene = game.scene.getScene('FarmScene');
    if (scene && scene.fishingMinigame) {
        scene.fishingMinigame.close();
        scene.fishingMinigame = null;
    }
    window.FARM_DATA.isFishing = false;
}

function cancelFishing() {
    closeFishingGame();
    showToast('收起了鱼竿');
}

// ============ 启动游戏 ============
const game = new Phaser.Game({
    type: Phaser.AUTO, width: 800, height: 520,
    parent: 'game-container', pixelArt: true,
    physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
    scene: [BootScene, FarmScene],
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }
});

// ============ HUD 函数 ============
function updateCoinsDisplay(coins) {
    document.getElementById('coins-value').textContent = coins ?? window.FARM_DATA.coins;
}

let _toastTimer;
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

function setTool(tool) {
    window.FARM_DATA.currentTool = tool;
    const scene = game.scene.getScene('FarmScene');
    if (scene) scene.currentTool = tool;
    TOOLS.forEach(t => {
        const btn = document.getElementById('tool-' + t);
        if (btn) btn.classList.toggle('active', t === tool);
    });
}

// ============ 商店 ============
function formatGrowthTime(seconds) {
    if (seconds >= 3600) return Math.round(seconds / 3600) + '小时';
    if (seconds >= 60) return Math.round(seconds / 60) + '分钟';
    return seconds + '秒';
}

function openShopModal() {
    const c = document.getElementById('shop-items'); c.innerHTML = '';
    const plants = window.FARM_DATA.plants;
    const unlocked = window.FARM_DATA.unlockedPlants || [];
    for (const id in plants) {
        const p = plants[id]; const isUnlocked = unlocked.includes(id);
        const div = document.createElement('div');
        div.className = 'item-row' + (isUnlocked ? '' : ' locked');
        div.innerHTML = isUnlocked
            ? `<div class="item-info"><div class="item-name">🌱 ${p.name}</div><div class="item-desc">${p.description||''} | ${formatGrowthTime(p.growth_time)}</div><div class="item-price">🪙 ${p.seed_cost}</div></div><button class="btn-sm btn-buy">购买</button>`
            : `<div class="item-info"><div class="item-name">🔒 ${p.name}</div><div class="item-desc">${p.description||''} | ${formatGrowthTime(p.growth_time)}</div><div class="locked-label">需恋爱${p.unlock_days}天+共签${p.unlock_both_checkins}天</div></div>`;
        if (isUnlocked) div.querySelector('button').onclick = () => buySeed(id);
        c.appendChild(div);
    }
    document.getElementById('shop-modal').classList.add('show');
}
function closeShopModal() { document.getElementById('shop-modal').classList.remove('show'); }

async function buySeed(plantId) {
    const r = await fetch('/api/farm/buy-seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plant_id: plantId, quantity: 1 }) });
    const d = await r.json();
    if (d.success) { window.FARM_DATA.coins = d.coins; window.FARM_DATA.inventory = d.inventory; updateCoinsDisplay(d.coins); showToast(d.message); closeShopModal(); }
    else showToast(d.error || '购买失败');
}

// ============ 背包 ============
function openInventoryModal() { updateInventoryDisplay(); document.getElementById('inventory-modal').classList.add('show'); }
function closeInventoryModal() { document.getElementById('inventory-modal').classList.remove('show'); }

function updateInventoryDisplay() {
    const c = document.getElementById('inventory-items');
    if (!c) return;
    const inv = window.FARM_DATA.inventory, plants = window.FARM_DATA.plants, fish = window.FARM_DATA.fish;
    let h = ''; let has = false;
    for (const k in inv) {
        const item = inv[k]; has = true;
        let name = item.id, price = 0, icon = '📦';
        if (item.type === 'seed') { icon = '🌱'; const p = plants[item.id]; if (p) { name = p.name + '种子'; price = Math.floor(p.seed_cost * 0.5); } }
        else if (item.type === 'crop') { icon = '🥕'; const p = plants[item.id]; if (p) { name = p.name; price = p.sell_price; } }
        else if (item.type === 'fish') { icon = '🐟'; const f = fish[item.id]; if (f) { name = f.name; price = f.sell_price; } }
        h += `<div class="item-row"><div class="item-info"><div class="item-name">${icon} ${name}</div><div class="item-desc">x${item.quantity}</div>${price ? `<div class="item-price">🪙 ${price}</div>` : ''}</div>${price ? `<button class="btn-sm btn-sell" data-type="${item.type}" data-id="${item.id}">售卖</button>` : ''}</div>`;
    }
    if (!has) h = '<div style="text-align:center;color:#999;padding:20px;">背包空空如也~</div>';
    c.innerHTML = h;
    c.querySelectorAll('.btn-sell').forEach(b => {
        b.onclick = async () => {
            const r = await fetch('/api/farm/sell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_type: b.dataset.type, item_id: b.dataset.id, quantity: 1 }) });
            const d = await r.json();
            if (d.success) { window.FARM_DATA.coins = d.coins; window.FARM_DATA.inventory = d.inventory; updateCoinsDisplay(d.coins); showToast(d.message); updateInventoryDisplay(); }
            else showToast(d.error || '售卖失败');
        };
    });
}

function closeSeedModal() { document.getElementById('seed-modal').classList.remove('show'); window.FARM_DATA.targetPlotIndex = null; }

// ============ 签到/日记（绑定主系统） ============
async function claimCheckinReward() {
    const btn = document.querySelector('.btn-checkin');
    // 先执行主系统签到
    const r1 = await fetch('/api/checkin', { method: 'POST' });
    const d1 = await r1.json();

    // 再领取农场签到金币
    const r2 = await fetch('/api/farm/checkin-reward', { method: 'POST' });
    const d2 = await r2.json();

    if (d2.success) {
        window.FARM_DATA.coins = d2.coins;
        updateCoinsDisplay(d2.coins);
        showToast('📅 ' + d2.message);
        if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
    } else if (d2.error) {
        showToast(d2.error);
        // 今日已领取也禁用
        if (d2.error.includes('已领取')) {
            if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
        }
    }
}

async function claimDiaryReward() {
    const btn = document.querySelector('.btn-diary');
    const r = await fetch('/api/farm/diary-reward', { method: 'POST' });
    const d = await r.json();
    if (d.success) {
        window.FARM_DATA.coins = d.coins;
        updateCoinsDisplay(d.coins);
        showToast('📝 ' + d.message);
        if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
    } else if (d.error) {
        showToast(d.error);
        if (d.error.includes('已领取')) {
            if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
        }
        // 如果没写日记，提示去写
        if (d.error.includes('还没有写日记')) {
            if (confirm('今天还没写日记，要去留言板写一篇吗？')) {
                window.location.href = '/messages';
            }
        }
    }
}

updateCoinsDisplay(window.FARM_DATA.coins);

function disableRewardBtn(selector) {
    const btn = document.querySelector(selector);
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
}
