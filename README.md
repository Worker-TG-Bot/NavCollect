# 📚 NavCollect - 个人网站导航收藏系统

NavCollect 是一个基于 Cloudflare Worker 的个人网站导航收藏系统，支持 Telegram Bot 快速录入、深浅色主题、后台管理、多用户支持等功能。单文件部署，零成本运行。

---

## ✨ 功能特性

NavCollect 提供完整的导航收藏解决方案，从网页端到 Telegram Bot，一应俱全。

* 🤖 **Telegram Bot 录入**：通过 Telegram Bot 快速添加收藏，支持 #标签、转发消息、代码块，随时随地记录灵感。
* 🌓 **深浅色主题**：支持一键切换深色/浅色主题，自动保存用户偏好，保护眼睛。
* ⚡ **SPA 单页应用**：页面切换无刷新，静默操作（删除、编辑、筛选），实时轮询更新内容。
* 🏷️ **标签管理**：支持多标签分类，标签云可视化展示，快速筛选查找。
* 👥 **多用户支持**：支持多个 Telegram 用户 ID，团队协作共享收藏。
* ⚙️ **后台配置**：网站标题、Logo、Bot Token、页脚链接等全部可在后台实时配置。
* 📱 **响应式布局**：完美适配电脑端和移动端，随时随地访问管理。
* 💻 **代码块支持**：自动识别并美化显示代码块，支持语法高亮和一键复制。
* 🔒 **安全认证**：网站密码登录 + Telegram 用户 ID 白名单，双重保护。

---

## 🚀 部署步骤

只需几分钟，即可完成部署，开始使用你的个人导航收藏系统。

### 1. 创建 Cloudflare Worker
登录 [Cloudflare Dashboard](https://dash.cloudflare.com)，进入 Workers & Pages，点击 "Create Worker"。
> 💡 建议命名为 `nav-tg` 或类似名称。

### 2. 创建 KV 命名空间
在 Workers & Pages → KV 中创建一个新的命名空间。
1. 点击 "Create a namespace"。
2. 命名为 `NAV_KV`。
3. 在 Worker 的 Settings → Variables → KV Namespace Bindings 中绑定。
4. Variable name 填写 `NAV_KV`。

### 3. 设置环境变量
在 Worker 的 Settings → Variables → Environment Variables 中添加：

| 变量名 | 说明 | 类型 |
| :--- | :--- | :--- |
| `ADMIN_PASSWORD` | 后台管理密码 | Secret（加密） |

> 💡 只需要这一个环境变量！Bot Token 等配置在后台 UI 中设置。

### 4. 部署代码
复制完整代码，粘贴到 Worker 编辑器中，点击 "Save and Deploy"。

### 5. 初始化配置
访问你的 Worker URL 进行初始配置：
1. 访问 `https://your-worker.workers.dev/admin`。
2. 输入你设置的 `ADMIN_PASSWORD` 登录。
3. 点击 **⚙️ 系统设置**。
4. 配置网站标题、描述、Logo。
5. 配置 Bot Token（从 @BotFather 获取）。
6. 配置允许的用户 ID（从 @userinfobot 获取）。
7. 点击 **🔗 设置 Webhook**。

### 6. 开始使用
一切就绪！
* ✅ 在 Telegram 中发送 `/start` 测试 Bot。
* ✅ 发送 `#标签 内容` 添加收藏。
* ✅ 访问网站首页查看收藏列表。

---

## 🤖 Telegram Bot 使用说明

通过 Telegram Bot 快速添加和管理收藏。

### 📝 添加收藏
* 直接发送内容即可添加（自动归类到 #inbox）。
* 使用 `#标签` 分类。
* 转发其他消息自动收藏。
* 支持代码块（用 \`\`\` 包裹）。
> **示例**：`#tech #ai https://openai.com ChatGPT 官网`

### 📋 命令列表
* `/start`：打开主菜单
* `/menu`：打开主菜单
* `/help`：查看使用帮助
> **主菜单功能**：➕ 添加 | 🕐 最近 | 📋 所有 | 🏷️ 标签

---