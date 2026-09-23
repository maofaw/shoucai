# 低价买料通知服务

这个 Cloudflare Worker 接收 GitHub Actions 每两小时生成的买料结果，通过飞书自建应用发个人消息，并用 D1 保存每种材料的通知冷却状态。

## 通知规则

- 只有材料进入7天、14天或30天囤货档才通知；
- 便宜且稳定、已被网页降噪的材料不通知；
- 当前不生产但属于稳定基准配方的备料也可以通知；
- 同一种材料24小时内不重复通知；
- 7天档升级到14天或30天档时，可以立即再次通知；
- 飞书发送失败时不写入冷却记录，下一轮仍会重试。

## 需要配置的密钥

Worker secrets：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_RECEIVE_ID`
- `NOTIFY_PUSH_KEY`：随机长字符串，用于验证 GitHub Actions 请求
- `ADMIN_KEY`：仅在启用跨设备状态同步时需要

GitHub Actions secrets：

- `SHOUCAI_NOTIFY_URL`：Worker 地址，例如 `https://shoucai-state.<账号>.workers.dev`
- `SHOUCAI_NOTIFY_KEY`：与 Worker 的 `NOTIFY_PUSH_KEY` 完全相同

不要把任何密钥写入仓库或 `wrangler.jsonc`。
