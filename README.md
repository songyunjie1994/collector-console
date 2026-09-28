# collector-console

千川采集管理台（独立前端）。

- 静态页面，**不含任何密钥**：只有 Supabase 的 publishable key（设计上就是公开的，仅用于登录换令牌）
- 所有权限判断在服务端：用户登录令牌 + 邮箱白名单
- 数据接口在 Supabase Edge Function（collector-admin）
- 部署方式：本仓库 main 分支 + GitHub Pages
