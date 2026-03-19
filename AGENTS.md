# Developer & Agent Guidelines (LLM-Friendly)

> AI Agent 在生成、修改、审查本目录代码时，必须遵守本规范。

## 0. 规则优先级（冲突处理）

1. 硬性禁令（禁止项）
2. MUST（必须）
3. SHOULD（建议）
4. 示例代码与说明文字（仅参考）

如规则冲突，按上面顺序执行。

---

## 1. 硬性禁令（MUST NOT）

- 禁止使用 ES Modules（`type="module"`、`import/export`）。
- 禁止引入构建流程（如 Vite/Webpack、本地打包产物、`node_modules` 依赖运行时）。
- 禁止创建独立 `.css` 文件。
- 禁止创建或依赖 `shared.js`、`utils.js`、`api.js` 等额外 JS 文件。
- 禁止使用 `<iconify-icon>` 组件或 Iconify JS 运行时脚本。
- 禁止从零创建新页面；必须以 `template.html` 复制为起点。
- 禁止在示例目录中新增无关页面；示例统一维护在 `template.html`。

---

## 2. 核心目标（MUST）

- 页面必须是**单文件交付**：一个 `.html` 文件即可运行。
- 所有业务逻辑与交互逻辑必须写在该 HTML 内的 `<script>` 中。
- API 配置、请求封装、页面状态、工具函数都必须内联在同一个 HTML 文件内。

---

## 3. 技术与加载规则（MUST）

- 依赖通过 CDN 引入，无本地构建步骤。建议使用 `https://cdn.jsdelivr.net`，主版本号即可。
- 标准栈：[Tailwind CSS (Play CDN)](https://tailwindcss.com) + [DaisyUI](https://daisyui.com) + [Alpine.js](https://alpinejs.dev) + [Day.js](https://day.js.org)。
- 遇到交互需求时优先查找 [Alpine 官方插件](https://alpinejs.dev/plugins)（如 `@alpinejs/mask` 处理输入掩码），插件必须在主库之前引入。
- 引入顺序：DaisyUI CSS → Tailwind → Alpine 插件 → Alpine 主库 → 其他库。
- 图标必须从 [Iconify 图标库](https://icon-sets.iconify.design/) 复制 SVG 源码后直接内联到 HTML（`<svg ...>...</svg>`），不得依赖运行时图标组件。
- 所有页面逻辑放在 `document.addEventListener('alpine:init', ...)` 中初始化。
- 所有接口请求统一使用浏览器原生 `fetch`；必须使用 `try...catch` 并维护 `loading` 状态。

---

## 4. 交互反馈规则（MUST）

- **读操作（GET/查询）**：
  - 初始加载：使用 `skeleton` 或 `loading-spinner`。
  - 失败：禁止使用 `alert-error`（含全页或跨模块错误块）；错误反馈必须在发起该读取请求的数据模块内就地显示，且仅允许“简短错误文案”和/或“重试按钮”。
- **写操作（POST/PUT/PATCH/DELETE）**：
  - 成功/失败反馈统一使用页面内联提示（可用 DaisyUI `alert`）。
  - 提交按钮必须有 loading 态并 `disabled`。
- **弹窗（Modal）**：
  - 使用 DaisyUI `<dialog>` + Alpine `x-ref`，不使用全局 ID。
  - 打开：`@click="$refs.myModal.showModal()"`，关闭：`<form method="dialog">`。

---

## 5. 命名规范（SHOULD）

- Alpine 组件名：`[feature]Page`（如 `indexPage`、`chatPage`）。
- 布尔状态：`is/has/show` 前缀（如 `isLoading`、`showModal`）。
- 交互函数：`handle/toggle` 前缀（如 `handleSubmit()`、`toggleSidebar()`）。
- 请求函数：`fetch/submit` 前缀（如 `fetchUserList()`）。
- 全局常量：`SNAKE_CASE`（如 `BASE_URL`、`MAX_RETRY_COUNT`）。
- 图标：使用内联 `<svg>`，优先复用同一套图标风格（如 `lucide`）。

---

## 6. 项目结构（MUST）

```text
/project-root
└── template.html    # 单文件示例页（包含全部 HTML/CSS/JS）
```

---

## 7. AI 执行检查清单（提交前逐项通过）

- [ ] 示例是否统一维护在 `template.html`（无额外页面依赖）。
- [ ] 是否仅产出一个 HTML 文件。
- [ ] 所有 JS 是否都在该 HTML 的 `<script>` 中。
- [ ] 是否不存在 `shared.js` 等额外 JS 依赖。
- [ ] 是否未使用 `<iconify-icon>`，图标是否为内联 SVG。
- [ ] JS 是否在 `alpine:init` 内初始化。
- [ ] API 请求是否统一使用原生 `fetch`。
- [ ] 读操作是否有 loading 与错误重试。
- [ ] 写操作按钮是否有 loading + disabled。
