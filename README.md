# 心动坐标 (HeartSync)

一个专为情侣设计的私密互动网站，强调仪式感、私密性和游戏化互动。

## 功能特性

### 🛡️ 准入与安全机制
- **真爱口令认证**：仅通过特定口令访问，无常规注册
- **身份隔离**：仅支持两个用户 (User_A 和 User_B)
- **会话持久化**：30天免登录

### ❤️ 核心功能
- **恋爱计时器**：实时显示相爱天数、时分秒
- **阶梯式成就系统**：随着时间自然解锁的成就
- **每日双人签到**：共同打卡触发爱心特效
- **纪念日提醒**：重要日子前7天滚动提醒

### 🎮 实时互动
- **同步画板**：WebSocket实时同步绘画
- **默契问答**：双人答题增加默契值
- **情绪天气**：实时同步心情状态

### 🎨 用户体验
- **响应式设计**：完美适配移动端
- **玻璃拟态UI**：现代毛玻璃设计风格
- **丰富动画**：粒子特效、庆祝动画、浮动元素

## 技术栈

- **后端框架**: Starlette (Python异步Web框架)
- **数据库**: SQLite3
- **实时通信**: WebSocket
- **前端**: HTML5, CSS3, JavaScript (ES6+)
- **模板引擎**: Jinja2
- **部署**: Uvicorn ASGI服务器

## 快速开始

### 1. 环境设置
```bash
# 克隆项目
git clone <repository-url>
cd taofang

# 创建虚拟环境
python -m venv .venv

# 激活虚拟环境
# Windows:
.venv\Scripts\activate
# Linux/Mac:
source .venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

### 2. 配置环境变量
```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，设置你的配置
# 重要：修改 SECRET_KEY 和 PASSPHRASE
```

### 3. 运行应用
```bash
# 启动开发服务器
python main.py

# 或使用 uvicorn 直接运行
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 4. 访问应用
- 打开浏览器访问: `http://localhost:8000`
- 默认口令: `first-love` (可在 .env 中修改)

## 项目结构

```
taofang/
├── app/
│   ├── __init__.py          # 应用工厂
│   ├── database/           # 数据库模块
│   ├── routes/            # 路由处理
│   │   ├── auth.py        # 认证路由
│   │   ├── dashboard.py   # 仪表板路由
│   │   ├── api.py         # API路由
│   │   └── websocket.py   # WebSocket路由
│   ├── models/            # 数据模型
│   ├── utils/             # 工具函数
│   ├── templates/         # HTML模板
│   │   ├── gate.html      # 登录页面
│   │   └── dashboard.html # 主仪表板
│   └── static/            # 静态资源
│       ├── css/           # 样式表
│       ├── js/            # JavaScript
│       └── images/        # 图片资源
├── main.py                # 应用入口
├── requirements.txt       # Python依赖
├── .env.example          # 环境变量模板
├── robots.txt            # 爬虫限制
└── PRD.md               # 产品需求文档
```

## 数据库架构

```sql
-- 用户表 (仅两个用户)
CREATE TABLE users (id INT PRIMARY KEY, name TEXT, secret_key TEXT);

-- 成就表
CREATE TABLE achievements (id INT, user_id INT, ach_name TEXT, unlock_date DATE);

-- 打卡日志
CREATE TABLE daily_checkin (id INT, user_id INT, checkin_time TIMESTAMP);

-- 全局配置
CREATE TABLE meta_config (key TEXT, value TEXT);
```

## 成就系统

| 等级 | 成就名称 | 解锁条件 | 视觉表现 |
|------|----------|----------|----------|
| LV1 | 萌芽 | 相识 1 天 | 灰色种子变绿 |
| LV2 | 默契初现 | 连续双人打卡 7 天 | 获得"小萌芽"图标 |
| LV3 | 百日维新 | 相识 100 天 | 背景解锁"星空"主题 |
| LV4 | 半载同行 | 相识 182 天 | 首页解锁"时光相册"功能 |
| LV5 | 岁月如歌 | 相识 365 天 | 解锁"双人联机游戏"模块 |

## 隐私保护

- **禁止爬虫**：robots.txt 拒绝所有爬虫
- **错误隐藏**：未授权访问统一重定向至404
- **安全头**：CSP、X-Frame-Options等安全头
- **会话安全**：加密会话，30天有效期

## 开发说明

### 添加新功能
1. 在 `app/routes/` 中添加新的路由模块
2. 在 `app/templates/` 中添加对应的HTML模板
3. 在 `app/static/js/` 中添加前端逻辑
4. 在 `app/__init__.py` 中注册路由

### 数据库操作
- 使用 `app/database/__init__.py` 中的 `get_connection()` 获取数据库连接
- 所有数据库操作应在事务中完成
- 使用参数化查询防止SQL注入

### 前端开发
- 使用现代CSS特性 (Flexbox, Grid, CSS Variables)
- JavaScript使用ES6+语法
- 所有交互使用异步请求 (Fetch API)
- 实时功能使用WebSocket

## 部署建议

### 生产环境配置
1. 设置强密码的 `SECRET_KEY`
2. 关闭 `DEBUG` 模式
3. 使用HTTPS
4. 配置反向代理 (Nginx/Apache)
5. 设置进程管理 (Systemd/Supervisor)

### 性能优化
- 启用Gzip压缩
- 配置静态文件缓存
- 使用CDN分发静态资源
- 数据库定期备份

## 许可证

本项目仅供个人使用，保留所有权利。

## 贡献

由于项目的私密性，暂不接受外部贡献。

## 支持

如有问题，请检查：
1. 环境变量配置是否正确
2. 数据库文件权限
3. 端口是否被占用
4. 依赖是否安装完整

---

**心动坐标** - 只属于你们的私密空间 ❤️