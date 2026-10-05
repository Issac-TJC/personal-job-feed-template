# Personal Job Feed

一个可独立部署的私人 ChatGPT MCP App：上传简历建立画像，从公司官网和官方 ATS 发现岗位，按自己的周期接收推荐，并通过左右滑管理兴趣状态。

## 功能

- PDF、DOCX、TXT 简历上传；原件保存到部署者自己的私有 Cloudflare R2
- 画像预览、编辑、确认、替换、下载和删除
- 任意国家、岗位、行业、经验级别和全职/实习/合同工筛选
- 按用户画像缓存匹配结果，职位事实与个人匹配数据分离
- 每周日历、每天最多 3 个时段、每次 1–30 个岗位
- 左滑感兴趣、右滑不感兴趣、Saved/已投状态和 CSV 导出
- 简约白灰毛玻璃 UI、手机 fullscreen 和深色模式
- Cloudflare Workers + D1 + R2 + Auth0；不需要 OpenAI API Key

每个使用者部署自己的 Worker、数据库、文件存储和 OAuth。仓库维护者不会托管或接触其他人的简历和求职数据。

## 快速开始

前置条件：Node.js 22+、Cloudflare 免费账户、Auth0 免费账户，以及支持私有插件和 Scheduled Tasks 的 ChatGPT 账户。

```bash
git clone <your-repository-url>
cd personal-job-feed
npm install
npm run setup
```

`setup` 会创建 D1、私有 R2 Bucket 和 Worker，暂停提示你完成 Auth0 配置，然后执行迁移、部署、健康检查并生成 `dist/personal-job-feed-plugin.zip`。外部账号授权仍需本人确认，脚本不会保存 Auth0 Client Secret。

部署完成后：

1. 在 ChatGPT 创建私人 MCP 连接，URL 使用脚本打印的 `/mcp` 地址。
2. OAuth scopes 填 `jobfeed:read jobfeed:write jobfeed:resume`。
3. 安装生成的插件包或连接同一 MCP server。
4. 打开 Personal Job Feed，上传简历并确认画像。
5. 在 Settings 选择周期和岗位数，点击“保存并应用任务”。

同一 OpenAI 账号登录手机后，插件状态和 Scheduled Tasks 会同步；是否显示手机通知取决于 ChatGPT 账户能力和系统通知设置。

## 日常维护

```bash
npm run doctor          # 检查本机、Cloudflare、Auth0 和线上 Worker
npm run check           # 类型检查与测试
npm run upgrade         # 迁移、构建、部署并重新打包插件
npm run package:plugin  # 只重新生成私人插件 ZIP
```

部署状态和个性化配置保存在被 Git 忽略的 `.jobfeed/`；公开仓库不包含 Worker URL、D1 ID、Auth0 tenant 或用户 subject。

## 隐私与成本

- R2 Bucket 不公开；简历工具需要独立 `jobfeed:resume` scope。
- D1 只保存结构化画像、限长提取文本、岗位状态和匹配缓存。
- 替换画像后旧简历删除；未确认的临时简历最长保留 24 小时并在后续操作时清理。
- 日常滑卡和状态更新不调用模型。
- ChatGPT 只处理首次画像和新增/变更岗位，不访问 `api.openai.com`。
- 设计目标适配 Cloudflare、R2、D1 和 Auth0 免费额度；R2 启用的是按量订阅，免费额度用尽后 Cloudflare 可能计费，请自行设置用量提醒并定期检查账单。

## 开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

生产环境始终验证 Auth0 issuer、audience、scope 和唯一 owner subject。本地认证绕过仅在 development 且 localhost 时生效。

不自动申请职位，不承诺公司会提供 sponsorship，也不会把公司历史记录描述为具体岗位承诺。
