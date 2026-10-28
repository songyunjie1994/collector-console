# collector-console

千川采集管理台（独立前端）。

- 静态页面，**不含任何密钥**：只有 Supabase 的 publishable key（设计上就是公开的，仅用于登录换令牌）
- 所有权限判断在服务端：用户登录令牌 + 邮箱白名单
- 数据接口在 Supabase Edge Function（collector-admin）
- 正式入口：`https://39.105.205.48/collector-console/`，接口、登录及数据均在阿里云。
- 原 GitHub Pages 地址保留并自动跳转，查询参数和页面片段保留。
- 登录使用原账号密码；投流03:00、账户中心09:00计划不变。
- 服务器应用目录 `/opt/anbito-ops`；凭据只保存在私有配置，不能提交到仓库。
