# 仓库命名与公开说明

仓库名称改为 `Whale-agent`，中文描述与 README 标题使用“基于DSH逐个pr写出自己的coding agent”。GitHub 仓库名只接受 ASCII 字母、数字、点、下划线和连字符，因此将用户给定英文名中的空格替换为连字符；规则见[GitHub 官方说明](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)。

仓库地址为 [xiaoxiang0626/Whale-agent](https://github.com/xiaoxiang0626/Whale-agent)，可见性设为公开。本地 origin 与文档中的仓库链接同步更新。改名保留同一仓库及其分支、提交和 PR 历史，CLI 命令继续使用 `my-coding-agent`。

公开前检查了全部可达 Git 对象：253 个文本或二进制 blob 中未匹配当前配置的已知密钥，敏感路径记录为 0。`.env`、会话日志与本地原图归档通过 Git 忽略规则保留在本地。

验证包含 `pnpm check`、构建后单次启动、文档链接与差异检查；最终通过不带认证的 GitHub API 读取确认公开状态。此项仅修改仓库信息和文档。
