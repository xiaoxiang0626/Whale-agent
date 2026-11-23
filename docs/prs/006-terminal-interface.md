# 全屏终端交互界面

## 解决的问题

逐行 CLI 缺少固定输入区、模型状态和消息浏览。新增全屏界面，在宽屏显示鲸鱼娘侧栏，窗口缩小时收起装饰并保留草稿。使用与按键见[终端界面](../tui.md)。

## 实现

CLI 在真实终端中延迟加载 Ink 和 React 界面；`--plain` 与非终端交互沿用 readline。会话对象继续管理成功历史，TUI 单独管理显示记录，请求失败或取消不提交模型历史。卸载取消请求，Ink 负责终端恢复。

输入通过 Unicode 字素编辑与真实光标定位支持中文、emoji 和长草稿。消息按列宽折行，分页偏移限制在实际历史范围内。运行依赖增加 Ink、React、wrap-ansi、string-width；原来的纯文本 API 协议保持不变。

## 阅读顺序

1. [CLI 模式选择](../../src/cli.ts)。
2. [会话控制器](../../src/tui.ts)。
3. [布局与消息视口](../../src/tui-view.ts)。
4. [输入编辑器](../../src/tui-input.ts)。
5. [组件行为测试](../../tests/tui.test.ts)与[真实伪终端检查](../../scripts/test-tui-pty.ts)。

## 验证

检查命令为 `pnpm check`、构建后的 `pnpm start`、`pnpm test:tui:pty --capture` 和 `pnpm test:tui:pty --live`。默认测试不需要密钥，真实接口检查显式加载本地配置，仅输出结果摘要。实际结果和问题解决记录见[开发日志](../development-log.md)。

本次不增加流式回复、Markdown 高亮、会话持久化或代码工具。终端文字与候选窗由字体、终端及输入法共同决定；已验证字符编辑和终端光标位置，未自动操作用户的输入法候选窗。
