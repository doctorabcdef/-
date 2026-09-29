# 弈间 · 在线围棋

面向电脑、手机的中文围棋网页。所有访客共享同一张公共棋盘；关闭网页、刷新或更换设备后，打开同一网址即可继续云端保存的对局。

网页地址：[https://doctorabcdef.github.io/-/](https://doctorabcdef.github.io/-/)

## 功能

- 双人对弈、入门人机对弈（人类执黑，电脑执白）
- 9、13、19 路棋盘，提子、禁止自杀、按轮次禁全同
- 悔棋、停一手、认输、死子标记与面积计分（白贴 7.5）
- 每次有效操作保存到云端，其他打开的设备约 3 秒内更新
- 落子、悔棋立即在本地显示，后台按顺序保存；冲突或网络异常时重新核对云端进度
- 版本号条件更新避免设备之间互相覆盖；人机落子及应手一起保存
- 断网仅显示最后同步的棋局，恢复网络后核对云端进度
- 键盘方向键移动，回车或空格落子；手机触摸操作

**公共棋盘的含义：** 所有访问者都可以落子、悔棋、认输和开始新局。开始新局会替换所有设备上的当前棋局，界面会先要求确认。没有账号系统，也不划分个人存档。

## 本地开发

需要 Node.js 24 或更新版本。

```sh
npm install
npm run dev
```

打开 `http://127.0.0.1:5187`。本地开发使用 `.artifacts/dev.sqlite` 保存开发棋局，与正式棋局隔离。

```sh
npm test             # 围棋规则、持久化及并发冲突测试
npm run build        # 生成 dist/ 静态网页
npm run test:browser # Windows Edge 浏览器端测试，先启动开发服务
node tests/latency.mjs # 将云端回复延迟 1.5 秒，验证落子与悔棋仍立即显示
```

## 部署结构

- 前端：GitHub Pages，`.github/workflows/pages.yml` 在推送 main 后自动测试、构建和发布。
- 云端接口：`backend/worker.js`，通过 Sites 托管的 Cloudflare Worker + D1 保存共享棋局。
- 规则引擎：`src/engine.js`，前后端共用；服务端校验操作，不接受客户端直接覆盖棋盘。
- 数据迁移：`backend/drizzle/`，由 `backend/db/schema.ts` 生成。
- API 地址：`src/config.js`。这是公开接口地址，前端不包含 GitHub 访问令牌或数据库密钥。

发布云端服务时，`node scripts/prepare-cloud.mjs` 将源文件及迁移复制到本地忽略的 `.cloud-workspace/`。该目录的 `.openai/hosting.json` 绑定现有 Sites 项目；更新时需保留项目 ID 和已应用迁移。前端 GitHub Actions 不会修改云端项目。

`backend/hosting.json` 保留云端项目的公开标识，方便重新检出后复用同一数据库。Windows 原生打包后备脚本为 `scripts/package-cloud.mjs`；应先通过 Sites 工作流构建并推送完全相同的源代码，再打包、保存版本并部署，不要新建替代数据库。

数据表只有一条 `id = shared` 的棋局记录，含局面、历史、模式、提子、阶段、结果、更新时间和递增版本号。浏览器 localStorage 仅缓存只读预览，云端数据库始终是正式存档来源。公共接口只允许规定大小的操作请求，并限制对局历史长度。

人机棋力定位于入门练习，使用提子、救棋、气、连接与布局启发式，不是专业围棋引擎。数子前需人工标记死子，有争议时可以继续下棋。采用所述简化规则，不声称完整实现某一比赛规则集。
