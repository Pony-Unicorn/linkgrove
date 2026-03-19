---
name: Linkgrove 技术选型决策
description: Linkgrove 项目已确认的技术栈和架构决策
type: project
---

Linkgrove 是一个 Tag-first 个人链接知识库，已确认以下技术选型：

**后端**
- Cloudflare Workers：API、业务逻辑、AI 调用、页面抓取
- Cloudflare D1：主数据库
- Cloudflare Workers AI：AI 推理

**前端**
- Alpine.js + 静态 HTML，托管在 Cloudflare Pages
- 不使用 React/Vue，接受交互代码稍复杂的取舍

**AI 模型**
- 默认：`@cf/meta/llama-3.1-8b-instruct`（JSON mode）
- 升级备选：`@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- AI 调用为同步流程：用户点击"AI 补全" → Worker 调用 AI → 前端填充建议 → 用户确认保存

**页面抓取（第一版）**
- 仅第一层：Workers fetch + HTMLRewriter 提取 title、meta description、og 标签
- 不使用三方服务（Jina 等），不做全文正文提取

**鉴权**
- 使用 Cloudflare Access（Zero Trust 免费层，≤50 用户）
- 不写自定义 OAuth 代码
- 后续如需多用户，再迁移到自定义 JWT + GitHub OAuth

**Why:** 首版优先简单、低成本、快速落地；复杂度后移。
**How to apply:** 建议方案时优先考虑这些技术，不引入 Redis/Queue/Durable Objects 等额外复杂度。
