# @agent/launcher

Philont 的 **supervisor**(常驻管理进程)。它是"浏览器 + 小 launcher"打包形态的地基:

- 在 `PHILONT_LAUNCHER_PORT`(默认 **20267**)上 serve 控制面 API + 打包好的 web-ui;
- 读写权威配置文件 `~/.philont/.env`(密钥掩码、保留用户注释);
- 以子进程方式 **启动 / 停止 / 重启** agent server(`@agent/server`),崩溃自动退避重拉;
- 启动时:配置齐(有 `ANTHROPIC_API_KEY`)→ 拉起 agent;否则停在"待配置",等前端填完。

launcher 自己活得比 agent 久,所以"改完配置一键重启"成立 —— 重启只是杀子进程重拉,配置页面不掉线。

## 运行

```bash
cd launcher
npm install
npm run dev      # tsx src/index.ts(开发)
# 或 npm run build && npm start
```

打开 `http://localhost:20267`。首次无 key 时会提示去 web-ui 配置(web-ui 设置面板见阶段 2)。

## 控制面 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/launcher/status`  | agent 运行态:state / pid / port / uptime / recentLogs / configured |
| GET  | `/api/launcher/config`  | 当前配置(密钥掩码为 `••••后4位`) |
| PUT  | `/api/launcher/config`  | 写配置 `{values:{KEY:val}}`;回传掩码值会跳过,不覆盖真实密钥;校验失败返回 400 |
| POST | `/api/launcher/start`   | 启动 agent(未配置返回 409) |
| POST | `/api/launcher/stop`    | 优雅停止(SIGTERM,超时 SIGKILL) |
| POST | `/api/launcher/restart` | 停 → 启(配置变更后调用) |
| GET  | `/api/launcher/logs`    | agent 最近日志 |

## 环境变量(均可选,有合理默认)

| 变量 | 默认 | 说明 |
|------|------|------|
| `PHILONT_LAUNCHER_PORT` | `20267` | launcher 自身端口 |
| `PHILONT_HOME`          | `~/.philont` | 配置 + 运行时数据目录 |
| `PHILONT_ENV_FILE`      | `$PHILONT_HOME/.env` | 权威配置文件;launcher spawn agent 时注入,agent 的 load-env 据此读取 |
| `PHILONT_SERVER_DIR`    | `../server` | agent server 包目录(打包后可覆盖) |
| `PHILONT_WEBUI_DIR`     | `../web-ui/dist` | web-ui 构建产物目录 |
| `PHILONT_NO_OPEN` / `PHILONT_OPEN_BROWSER=0` | — | 关闭启动时自动打开浏览器 |
| `PHILONT_DESKTOP_SHORTCUT=0` | — | 关闭创建桌面 / 应用菜单快捷方式 |

## 与 agent server 的契约

launcher spawn agent 时:`cwd = serverDir`(供模块解析),并注入 `PHILONT_ENV_FILE` 与
`PHILONT_PORT`。agent 的 `server/src/load-env.ts` 认 `PHILONT_ENV_FILE` → 读 `~/.philont/.env`;
不设时退回原有"读 cwd/.env"行为,直跑 `tsx src/index.ts` 的开发流程不受影响。

## 状态(2026-06)

- 阶段 1 ✓ 控制面 + 进程监督 + 配置读写校验。
- 阶段 2 ✓ web-ui 设置面板 + 首次向导 + 状态灯/重启 + 同源/局域网地址解析。
- 阶段 3 ✓ 启动自动打开浏览器(headless 自动跳过)+ 桌面/应用菜单快捷方式(只创建一次)。
  系统托盘**留到阶段 4**:需跨平台原生 helper(systray 类库要打包一个 Go/原生二进制),
  且无法在无显示环境验证,故先用"快捷方式 + 自动打开"补可发现性。
- 阶段 4(进行中):
  - ✓ 可选能力检测(`GET /api/launcher/capabilities`:python/z3/playwright)+ 设置面板「系统」区展示。
  - ✓ 开机自启(`GET|POST /api/launcher/autostart`:linux XDG / mac LaunchAgent / win 启动文件夹)+ 面板开关。
  - ✓ 装配脚本 `scripts/assemble.mjs`(构建 + staging 到 dist-app,~14M app 层)。
  - ✓ 打包策略文档 `../PACKAGING.md`(含 z3 等可选能力不进基础包的决策)。
  - 待真机:各平台安装包(NSIS/.pkg/AppImage)+ 系统托盘(需原生 helper)+ 卸载器。

打包形态约定见 `../PACKAGING.md`。
