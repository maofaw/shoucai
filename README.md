# 三角洲收菜助手

低频读取 moligod 特勤处公开市场快照，保存本地历史并生成制造、买料和资金建议。程序只在计划时间启动，完成后立即退出，不常驻内存。

项目同时包含手机优先的静态看板：

```powershell
npm run serve:web
```

浏览器打开 `http://127.0.0.1:4173`；管理模式在地址末尾加 `#manage=本机测试`。网页目录为 `web/`，GitHub Pages工作流位于 `.github/workflows/pages.yml`。

公开网站构建只读取 `config.site.json`。本机运营配置 `config.json`、SQLite、日志、报告和Obsidian笔记均被 `.gitignore` 排除，不会上传到公开仓库。

## 默认运行时间

- 06:50：为07:00收菜生成建议。
- 14:50：为15:00收菜生成建议。
- 22:50：为23:00收菜和周末出售生成建议。
- 周六21:20：提醒21:30开始清仓，28号预计约112分钟。

06:50、14:50、22:50的通知直接显示收菜时间、四个制造台配方、囤料结论和“当前行情理论利润”。宿舍00:00至06:30断电，因此不安排凌晨本机任务，避免通电后补跑造成重复提醒。

## 使用

```powershell
npm test
npm run run
npm run task:install
```

生成内容：

- `data/market.sqlite`：本地行情历史；SQLite是文件，不是后台服务。
- `reports/latest.md`：最近一次建议。
- `logs/advisor.log`：运行结果与错误。
- Obsidian：`D:\我的笔记\200-Projects\三角洲收菜运营\三角洲收菜实时建议.md`。

## 重要配置

编辑 `config.json`：

- `historicalStock.enabled`：金甲修旧低价材料用完后改为 `false`。
- `balancePerAccount`：单号可用哈夫币变化时更新。
- `haffPerCny`：现实租赁比例变化时更新。
- `switchThreshold`：默认新配方的整周预计净利润高出5%才允许切换。
- `switchBasis`：当前固定为 `weeklyProjectedProfit`，按一周生产量比较，不按单轮或单日利润比较。

## 卸载计划任务

```powershell
npm run task:remove
```

删除计划任务不会删除行情数据库或报告。
