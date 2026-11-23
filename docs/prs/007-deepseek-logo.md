# DeepSeek 蓝鲸终端图标

## 交付

以 DeepSeek 蓝鲸字符轮廓替换鲸鱼娘角色像素画，在宽屏侧栏、普通窗口欢迎页和逐行启动中显示。保留无色、小窗口和名称版本，单次任务输出保持原有文本。用法见[终端图标](../mascot.md)。

字符轮廓参考 DeepSeek Harness 的蓝鲸图形，许可说明随打包产物交付。用户提供的原图保存在本地忽略目录 `.local-assets/whale-girl-original.png`，不进入 Git 或运行产物；本次不交付图片协议、图片读取功能或新增运行依赖。

## 阅读顺序

1. [单色字符轮廓](../../src/mascot-art.ts)。
2. [颜色与空间选择](../../src/mascot.ts)。
3. [全屏视图](../../src/tui-view.ts)和[逐行入口](../../src/interactive.ts)。
4. [第三方素材说明](../../THIRD_PARTY_NOTICES.md)。

## 验证

`pnpm check` 完成 32 项测试、类型检查和构建。`pnpm test:tui:pty --capture` 验证真实伪终端中的启动、对话、长草稿、三种尺寸、清空、帮助、退出和屏幕恢复。构建后的单次命令与无色交互均已检查；图标固定参数调用验证列宽、行数和无图片协议。预览使用支持 Braille 的字体绘制并检查。

问题、原图归档和测量数据统一记录于[开发日志](../development-log.md)。
