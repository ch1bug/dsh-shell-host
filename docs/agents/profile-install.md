# Profile 安装与注册（Windows 桌面端）

`dsh-shell-host` 如何进入一个活的 DSH profile，以及"未发现插件"/组合报错时该看哪里。
**环境事实，非教程。**

## 布局

- Profile 根：`$DSH_HOME/profiles/<name>`（如 `C:\Users\<user>\.dsh\profiles\desktop`）
- 插件安装面：`<profile>\node_modules\<pkg>` —— 由 **pnpm 安装**产生（`link:` 协议下
  指向工作检出），故本仓 `pnpm build` 在 profile 重启后即生效。
- Profile 状态文件（**注册真身**）：
  - `<profile>\package.json` 的 `dependencies` 必须含该插件
    （`"dsh-shell-host": "link:<repo>"`），**且**
  - `<profile>\package.json` 的 `dsh.profile.bundles` 必须列出该 bundle 名。
- Bundle patch：插件自带的 `cordis.patch.yml`，由 loader 在组合时应用。

## 注册规则（2026-10-16 实测）

手工丢进 `<profile>\node_modules` 的 symlink **不是安装**：缺上面两处 `package.json`
记录时 loader 从不组合该插件 —— 症状是"未发现插件"/Plugins 页无组件。

**正确做法是官方 CLI 两步，顺序固定：**

```bash
export PATH="<pnpm shim 目录>:$PATH"    # dsh plugin 会调 pnpm
dsh --profile <name> --from-default-profile web --dump-config   # ① 播种 profile
dsh plugin --profile <name> add <插件绝对路径>                   # ② 注册 + pnpm 安装
```

- **① 不能省**：只有它会写出 `cordis.yml` / `pnpm-workspace.yaml` 与基础 entry list。
  只跑 ② 得到的 profile 启动时**毫无输出**（实测 120s 超时、stdout/stderr 皆空）。
- **② 不要用「手写注册记录 + 手工 symlink」代替**：那会跳过 pnpm 对 `link:` 依赖的
  **peer 解析检查**（本仓 10 个 peer 靠它暴露 `will not resolve the peer dependencies
  from the target node_modules`），以及 `.plugin-manager/logs/operation-*/pnpm.log`
  这个**诊断第一现场**。
- CLI 写注册记录时**不需要预先存在** `package.json`；目录也可由它自建。

> 插件管理器的 `install_bundle` 是 AI 会话内的工具面，等价能力在 CLI 上是
> 上面两步；脚本/CI/非交互场景走 CLI。

## 装好后必须 dump 组合树

**命令 exit 0 不等于挂上了。** 只写注册记录而没真装时，loader 打
`skipping profile bundle "dsh-shell-host": cannot resolve`，但**实例照常起来、
会话照常建得成** —— 这是最危险的假绿。

```bash
dsh --profile <name> --dump-config | grep -A2 'dsh-shell-host'
# 期望：- id: pty / name: dsh-shell-host/pty，以及 terminal 行
```

## 诊断入口

- 安装操作日志：`<profile>\.plugin-manager\logs\operation-*\pnpm.log`
  （只覆盖 pnpm 阶段问题；**组合错误不在这里**）
- patch/组合变更后：**重启 profile** —— 宿主只在启动时组合一次，symlink 改指向**不热更新**。
- 归咎 loader 之前，先用纯 Node 验产物可加载：
  `node -e "import('file:///<repo>/lib/pty/index.js').then(m => console.log(Object.keys(m)))"`

## 相关

- 环境事实唯一来源、隔离契约、源码部署步骤：[../dev-environment.md](../dev-environment.md)
- 验证分层与 e2e 安装断言：[TESTING.md](TESTING.md)